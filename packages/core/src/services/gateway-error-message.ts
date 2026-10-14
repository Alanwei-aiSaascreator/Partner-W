/**
 * 把网关返回的错误原文翻成人话。
 *
 * 为什么需要它：`sessions.patch` 之类失败的原文是英文，例如
 * `thinkingLevel "minimal" is not supported for clawrouter/deepseek-r1 (use off)`。
 * 2026-09-12 之前这些原文被调用方**整个丢掉**，用户只看到一句「发送失败」，
 * 完全无法判断是模型不支持、模型不存在，还是网络问题。现在把原文透出来，
 * 但直接给中文用户看英文不合适，所以加这一层。
 *
 * ⚠️ 这是**按 message 字符串**匹配的兜底 —— 契约并不稳定，网关改一个字就失效。
 * 正解是与网关约定**错误码**（见 `docs/superpowers/plans/2026-09-11-模型子系统.md` 的 P1-4），
 * 届时本表应改写成「错误码 → 文案」。
 *
 * 认不出来的一律**返回 null**，由调用方回退到网关原文 ——
 * 网关的原文比我们编的话准，宁可给英文也不要给一句错的中文。
 */

import { describeQuestionFailure } from './question-flow.js';

/** 思考档位的协议 id → 中文。与 `ChatInput/constants.ts` 的展示名保持一致。 */
const THINKING_LEVEL_LABELS: Record<string, string> = {
  off: '关闭',
  minimal: '最低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最高',
};

function thinkingLabel(id: string): string {
  return THINKING_LEVEL_LABELS[id] ?? id;
}

/**
 * 例：`thinkingLevel "minimal" is not supported for clawrouter/deepseek-r1 (use off)`
 * → `当前模型（clawrouter/deepseek-r1）不支持「最低」档思考，只能用「关闭」。`
 */
function translateThinkingLevelUnsupported(raw: string): string | null {
  const m = /thinkingLevel\s+"([^"]+)"\s+is not supported for\s+(\S+)\s*(?:\(use\s+([^)]+)\))?/i.exec(raw);
  if (!m) return null;
  const [, level, model, allowed] = m;
  const head = `当前模型（${model}）不支持「${thinkingLabel(level)}」档思考`;
  return allowed ? `${head}，只能用「${thinkingLabel(allowed.trim())}」。` : `${head}。`;
}

/** 例：`The selected model was not found by the provider. Check the model id ...` */
function translateModelNotFound(raw: string): string | null {
  if (!/the selected model was not found by the provider/i.test(raw)) return null;
  return '该模型在当前服务上不存在。请换一个模型再试。';
}

/**
 * 结构化提问（`ask_user`）的校验失败。
 *
 * ⚠️ 原文长这样：`GatewayClientRequestError: question 'doc_type' requires an answer`
 * —— 直接把 `doc_type` 摆给用户看既是信息泄漏也是中文体验缺陷（2026-09-17 实机）。
 * 这里没有 question 上下文（拿不到 `header`），所以给通用中文；
 * 卡片里的具体提示由 `question-flow.ts` 的 `describeQuestionFailure` 负责。
 */
function translateQuestionFailure(raw: string): string | null {
  // fallback 传空串：认不出来的 reason 会返回空串（假值），由外层继续尝试别的翻译器
  return describeQuestionFailure(raw, [], '') || null;
}

/**
 * 一次运行**整体失败**（openclaw 的 `⚠️ Agent run failed (model: …).`）。
 *
 * 为什么值得单独给一句：原文只说"失败了"，用户唯一的反应是**重试同一句** ——
 * 而常见原因之一恰恰是"同一句还会再失败一次"（0.0.26 用户实测，2026-09-23：
 * 模型一次要吐出的内容撞上输出上限、工具调用被切在半路，openclaw 判
 * `Provider returned an incomplete or malformed tool call` 并把整轮作废；
 * 上游那一端的修复见 `services/relay/src/catalog.ts` 的 `MAX_OUTPUT_TOKENS_BY_MODEL`）。
 *
 * ⚠️ **不许把它写成"就是输出上限"**：`Agent run failed` 是 openclaw 的**通用**包装，
 *    网络、上游异常、工具失败都可能落到这里，而这个字段里**没有原因**。
 *    所以只给"常见原因 + 该怎么做"，不下断言 —— 与本文第一条纪律一致
 *    （宁可少说，也不给一句错的中文）。
 */
function translateAgentRunFailed(raw: string): string | null {
  if (!/agent run failed/i.test(raw)) return null;
  return '这次没能完成。常见原因之一是：模型一次要写的内容太长（超过单次输出上限）被截断了 —— 如果是这种，请让它分步做，例如先只要大纲或脚本骨架，再逐段补内容。已经跑过的工具动作可能已经生效，重试前请先确认结果。';
}

/**
 * 与 `Agent run failed` 成对出现的那条（"没能产出回复"）。
 *
 * 原文同样带英文且信息量为零；这一句真正的价值是**提醒用户先看已执行的动作**，
 * 所以中文版必须把这一点说出来，不能只翻成"没生成回复"。
 */
function translateAgentNoResponse(raw: string): string | null {
  if (!/agent couldn't generate a response|couldn't generate a response/i.test(raw)) return null;
  return '模型这次没有产出回复（可能是被截断或上游异常）。已经跑过的工具动作可能已经生效，重试前请先确认结果。';
}

/**
 * 请求超时（10-01 用户实测反馈 #1；调查报告 `D:\backup\issue1-investigation-20261006.md`）。
 *
 * 原文：`TimeoutError: request timed out` —— 随包运行时的 fetch 超时自造，没有 HTTP 状态码。
 * 此前无翻译器 → 英文原文直接上屏。匹配从严：只认运行时的确切措辞（`request timed out` /
 * `TimeoutError`），不泛化到 "timeout" 一词——免得吞掉别家协议的原文
 * （纪律「宁可少说，也不给一句错的中文」）。
 */
function translateRequestTimeout(raw: string): string | null {
  if (!/request timed out|TimeoutError/i.test(raw)) return null;
  return '这次请求超时了——等待时间太长被中断（通常是网络波动或服务临时繁忙）。可以直接重试一次；如果连续出现，请检查网络后再试。';
}

/**
 * 受控测试通道（relay）的**守门拒绝**：`⚠️ clawrouter/<model> request failed (HTTP 409).`
 *
 * 为什么值得单独一句（2026-10-03 场景一实测，runId e637f73d 的第 23 笔）：
 *   - 这条 409 不是网络抖动 —— 是中转的预算/停止守卫在**供应商提交之前**拒了这次调用
 *     （实测一例：任务帽 0.7385 + 单次最坏预留 0.3146 > 1 元 ⇒ `ppt_budget_exhausted`）；
 *   - 重发同一句**必然再失败**（额度是确定性的），而原文只有一句 `request failed`，
 *     用户会把它当故障反复重试；
 *   - 被拒的调用**没有花掉任何钱**，已经生成的文件和回执都还在 —— 这两点必须说出来。
 * ⚠️ 不下断言"就是预算"：409 这一类里还有"任务已停止"等（同样拒绝先于提交），
 *    所以给的是"守门拦下"的类级说法 + 正确动作，与本文开头的纪律一致。
 * ⚠️ 只认 `clawrouter/`（守门只在自家中转这条路上）；其他 provider 的 409 不吃这条。
 */
function translateRelayGuardRejected(raw: string): string | null {
  if (!/clawrouter\/\S+\s+request failed \(HTTP 409\)/i.test(raw)) return null;
  return '这次调用被额度守门拦下了（HTTP 409，通常是本轮测试额度已到上限，或任务已被停止）。没有产生费用；已经生成的文件和回执仍然保留。请不要反复重发，调整后继续。';
}

/**
 * 单帧超限被网关断连（close code 1009，`message too large`）。
 *
 * 原文由**我们自己**的主进程造（`main/ws/gateway-client.ts` 的
 * `GATEWAY_MESSAGE_TOO_BIG_ERROR`）：进程收到 1009 后用它拒绝在途的发送请求。
 * 没有这一层时用户看到的是"连接断开"式的通用失败，看不出"是这次发的内容太大"，
 * 只会对着同一句话反复重试（质量战役区 2 · P1-1）。
 * ⚠️ 匹配从严：只认运行时的确切措辞（`message too large` / `frame limit`）。
 */
function translateFrameTooLarge(raw: string): string | null {
  if (!/message too large|frame limit/i.test(raw)) return null;
  return '这次发送的内容太大，超过了网关单帧上限，连接被网关断开（消息没有发出去）。请减少一次带上的附件数量或大小（例如先移除最大的那个文件），然后重试。';
}

const TRANSLATORS = [
  translateThinkingLevelUnsupported,
  translateModelNotFound,
  translateQuestionFailure,
  translateAgentRunFailed,
  translateAgentNoResponse,
  translateRequestTimeout,
  translateRelayGuardRejected,
  translateFrameTooLarge,
];

/**
 * 已知的**英文包装句** → i18n key（九语言文案走 locales，**不在本文件硬塞中文**）。
 *
 * 为什么这几位不走上面的 `TRANSLATORS`：那句话不是"漏了一个中文翻译"，而是
 * **所有语言**的用户都会看到英文原文（BUG-077：2026-10-14 真实用户 1.0.6 截图
 * 「推流: LLM request failed: provider rejected the request schema or tool payload.」，
 * 客户端只加了「推流: 」前缀）。硬塞一句中文只有中文用户受益；返回 key 交给
 * `error-classify` 的 `displayMessage` 走统一 `t()`，9 个语言各拿自己的产品文案
 * （真实文案由 desktop 的 `gateway-copy-coverage.test.ts` 钉住）。
 *
 * ⚠️ 只认**确切措辞**（大小写不敏感）——不许写成 `/schema|tool/` 这类宽匹配：
 *    这句话背后可能是 404 模型下架（BUG-078 就是实例）、400 参数错误或工具载荷问题；
 *    把"句子里出现 schema/tool"的其它错误一起吞掉，等于替用户编一个错的原因。
 *    也不许把它解释成"必然是你的工具参数写错了"。
 *
 * ⚠️ 优先级：在 `displayMessage` 里排在**结构化 kind 之后** —— 限流/超时/拒绝/上下文
 *    这类明确类别照旧先行，泛化包装文案不盖过它们（同处见该文件注释）。
 */
const KNOWN_WRAPPER_MESSAGE_KEYS: ReadonlyArray<{ readonly test: RegExp; readonly key: string }> = [
  {
    // `LLM request failed: ` 前缀由运行时加、「推流: 」由客户端加 —— 都可变，
    // 所以只匹配这句独有的措辞本身。
    test: /provider rejected the request schema or tool payload/i,
    key: 'errors.wrapper.providerRequestRejected',
  },
];

/**
 * 已知英文包装句 → i18n key；认不出来返回 `null`（调用方回退原文，纪律同
 * `translateGatewayError`）。与那条的区别：那条返回**中文**，这条返回**key**（九语言）。
 */
export function translateGatewayErrorKey(raw: string | undefined): string | null {
  if (!raw) return null;
  for (const { test, key } of KNOWN_WRAPPER_MESSAGE_KEYS) {
    if (test.test(raw)) return key;
  }
  return null;
}

/** 命中已知错误返回中文；认不出来返回 null（调用方应回退到网关原文）。 */
export function translateGatewayError(raw: string | undefined): string | null {
  if (!raw) return null;
  for (const translate of TRANSLATORS) {
    const out = translate(raw);
    if (out) return out;
  }
  return null;
}

/**
 * 给界面用的统一入口：已知错误给中文，未知错误给**网关原文**，都没有才给兜底文案。
 */
export function describeGatewayError(raw: string | undefined, fallback: string): string {
  const translated = translateGatewayError(raw);
  if (translated) return translated;
  const trimmed = raw?.trim();
  return trimmed ? trimmed : fallback;
}
