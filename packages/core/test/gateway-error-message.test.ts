import { describe, expect, it } from 'vitest';
import {
  describeGatewayError,
  translateGatewayError,
  translateGatewayErrorKey,
} from '../src/services/gateway-error-message.js';

describe('translateGatewayError —— 已知错误翻中文', () => {
  it('思考档位不支持（带 use 提示）', () => {
    // 原文来自 2026-09-11 实测网关日志
    const raw = 'thinkingLevel "minimal" is not supported for clawrouter/deepseek-r1 (use off)';
    expect(translateGatewayError(raw)).toBe('当前模型（clawrouter/deepseek-r1）不支持「最低」档思考，只能用「关闭」。');
  });

  it('思考档位不支持（不带 use 提示）', () => {
    // ⚠️ 这里**刻意不再用 `adaptive` 举例**（2026-09-14）：客户端已经不再提供那个档位，
    //    用户遇不到它了。拿一个不可能出现的值当用例，这条翻译就成了空转。
    const raw = 'thinkingLevel "high" is not supported for clawrouter/some-off-only-model';
    expect(translateGatewayError(raw)).toBe('当前模型（clawrouter/some-off-only-model）不支持「高」档思考。');
  });

  it('档位 id 不认识时原样嵌入，不瞎猜', () => {
    const raw = 'thinkingLevel "xhigh" is not supported for clawrouter/some-model (use high)';
    expect(translateGatewayError(raw)).toBe('当前模型（clawrouter/some-model）不支持「极高」档思考，只能用「高」。');
  });

  it('选中了服务不了的模型', () => {
    const raw = 'The selected model was not found by the provider. Check the model id or choose a different model.';
    expect(translateGatewayError(raw)).toBe('该模型在当前服务上不存在。请换一个模型再试。');
  });

  it('结构化提问的答案没给全 —— 且不泄漏内部字段名', () => {
    // 2026-09-17 实机原文（`GatewayClientRequestError: ` 前缀是客户端包出来的）
    const raw = "GatewayClientRequestError: question 'doc_type' requires an answer";
    const translated = translateGatewayError(raw);
    expect(translated).toBe('还有必答的问题没有选择，请在问题卡片里选完再发送。');
    expect(translated).not.toContain('doc_type');
  });

  it('提问已经结束 / 已被回答', () => {
    expect(translateGatewayError("question 'ask_1' was not found")).toBe('这个问题已经结束，请重新发送消息。');
    expect(translateGatewayError("question 'ask_1' is already answered")).toBe(
      '这个问题已经回答过了，请重新发送消息。',
    );
  });
});

describe('受控测试通道的守门拒绝（relay → HTTP 409）', () => {
  it('⭐ 场景一实测原文 ⇒ 说清"没花钱、别重发、产物保留"', () => {
    // 原文来自 2026-10-03 场景一真机聊天记录（该轮第 23 笔被任务帽拦下：0.7385+0.3146>1 元）
    const raw = '⚠️ clawrouter/deepseek-v4-flash request failed (HTTP 409).';
    const translated = translateGatewayError(raw);
    expect(translated).toContain('没有产生费用');
    expect(translated).toContain('不要反复重发');
    expect(translated).toContain('保留');
  });

  it('500 的 request failed 不吃这条规则（那是另一类，另有出口）', () => {
    expect(translateGatewayError('⚠️ clawrouter/deepseek-v4-flash request failed (HTTP 500).')).toBeNull();
  });

  it('非 clawrouter 的 409 不冒充（守门只在中转那条路上）', () => {
    expect(translateGatewayError('⚠️ openai/gpt-5 request failed (HTTP 409).')).toBeNull();
  });
});

describe('translateGatewayError —— 认不出来要返回 null（由调用方回退原文）', () => {
  it('未知错误返回 null，不编文案', () => {
    expect(translateGatewayError('some brand new gateway wording')).toBeNull();
  });

  it('空 / undefined 返回 null', () => {
    expect(translateGatewayError('')).toBeNull();
    expect(translateGatewayError(undefined)).toBeNull();
  });
});

describe('describeGatewayError —— 界面用的统一入口', () => {
  it('已知错误给中文', () => {
    const raw = 'The selected model was not found by the provider.';
    expect(describeGatewayError(raw, '发送失败')).toBe('该模型在当前服务上不存在。请换一个模型再试。');
  });

  it('未知错误回退**网关原文**（而不是兜底文案）—— 原文比我们编的话准', () => {
    expect(describeGatewayError('ERR_UPSTREAM_QUOTA_EXCEEDED', '发送失败')).toBe('ERR_UPSTREAM_QUOTA_EXCEEDED');
  });

  it('连原文都没有才用兜底文案', () => {
    expect(describeGatewayError(undefined, '发送失败')).toBe('发送失败');
    expect(describeGatewayError('   ', '发送失败')).toBe('发送失败');
  });
});

/**
 * 一次运行整体失败（0.0.26 用户实测，2026-09-23）。
 *
 * 现场原文（客户端调试日志 `renderer.agent.lifecycle.error`）：
 *   `⚠️ Agent run failed (model: clawrouter/deepseek-v4-flash).`
 * 紧跟一条 `⚠️ Agent couldn't generate a response. Note: some tool actions may have
 * already been executed — please verify before retrying.`
 *
 * 根因（逐层取证见 `services/relay/src/catalog.ts` 的注释）：模型单次要吐出的内容
 * 撞上**输出上限**，工具调用被切在半路，openclaw 判 `Provider returned an incomplete
 * or malformed tool call` 并把**整轮**作废。原文只说"失败了"，用户看不出该做什么 ——
 * 反复重试同一句只会再失败一次（还会再花一次钱）。
 */
describe('运行整体失败的出口（截断的工具调用）', () => {
  it('⭐ `Agent run failed` ⇒ 说清"分步做"，而不是让用户反复重试', () => {
    const raw = '⚠️ Agent run failed (model: clawrouter/deepseek-v4-flash).';
    const text = translateGatewayError(raw);

    expect(text).toBeTruthy();
    expect(text).toContain('分步');
    // 不许把 openclaw 的英文原文或内部模型 id 摆到用户脸上
    expect(text).not.toContain('Agent run failed');
    expect(text).not.toContain('clawrouter/');
  });

  it('⭐ "可能有工具已经跑过了"那条也要给人话（它同样带英文原文）', () => {
    const raw =
      "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.";
    const text = translateGatewayError(raw);

    expect(text).toBeTruthy();
    expect(text).toContain('确认');
    expect(text).not.toContain('tool actions');
  });

  it('认不出来的一律仍然返回 null（这条纪律不许因为新规则而松）', () => {
    expect(translateGatewayError('some brand-new gateway failure mode')).toBeNull();
  });
});

/**
 * 请求超时（10-01 用户实测反馈 #1；调查报告 `D:\backup\issue1-investigation-20261006.md`）。
 *
 * 现场原文：`TimeoutError: request timed out` —— 由随包运行时在 fetch 超时时自造
 * （`openclaw/dist/fetch-timeout-*.mjs`：`new Error("request timed out")`、`error.name="TimeoutError"`）。
 * 此前桌面端**没有超时翻译器** → 英文原文直接上屏（用户可见的"推流失败"提示里带英文）。
 */
describe('请求超时（运行时 fetch 超时）', () => {
  it('⭐ `TimeoutError: request timed out` ⇒ 中文人话（不出现英文原文）', () => {
    const raw = 'TimeoutError: request timed out';
    const text = translateGatewayError(raw);

    expect(text).toBeTruthy();
    expect(text).toContain('超时');
    expect(text).toContain('重试');
    expect(text).not.toContain('TimeoutError');
    expect(text).not.toContain('timed out');
  });

  it('无前缀的裸 "request timed out" 同样识别', () => {
    const text = translateGatewayError('request timed out');
    expect(text).toBeTruthy();
    expect(text).toContain('超时');
  });
});

/**
 * 单帧超限被网关断连（close code 1009，2026-10-07 质量战役区 2 · P1-1）。
 *
 * 原文由我们自己的主进程造（`main/ws/gateway-client.ts` 的 `GATEWAY_MESSAGE_TOO_BIG_ERROR`，
 * 在收到 1009 断连时用来拒绝在途发送请求）。没有这一层，用户看到的是通用"连接断开"，
 * 完全看不出是"这次发的内容太大"，只会对着同一句话反复重试。
 */
describe('单帧超限断连（close code 1009）', () => {
  it('⭐ 主进程的 1009 失败原文 ⇒ 说清"内容太大、没发出去、减附件重试"', () => {
    const raw = 'message too large for gateway frame limit (close code 1009)';
    const text = translateGatewayError(raw);

    expect(text).toBeTruthy();
    expect(text).toContain('太大');
    expect(text).toContain('没有发出去');
    expect(text).toContain('重试');
    expect(text).not.toContain('1009');
  });

  it('普通断线的 "connection closed" 不吃这条（那还是通用失败）', () => {
    expect(translateGatewayError('connection closed')).toBeNull();
  });
});

/**
 * BUG-077（2026-10-14 真实用户 1.0.6 现场）：运行时把"上游判请求不合法"统一成
 * `LLM request failed: provider rejected the request schema or tool payload.`，
 * 客户端只加「推流: 」前缀 —— 用户看到的就是整句英文（截图证据在 BUGS）。
 *
 * ⚠️ 这一句**不能**只在中文字符串翻译器里硬塞一句中文：那样只有中文用户受益，
 *    英文/日文……用户照样看到原文。所以出口是**返回 i18n key**，由 `error-classify`
 *    走统一 `t()`；九语言文案在 desktop 的 locale 里（`gateway-copy-coverage.test.ts` 钉住）。
 *
 * ⚠️ 匹配**只认这一句的确切措辞**（大小写不敏感），不许用 `/schema|tool/` 这类宽匹配：
 *    这句话背后可能是 404 模型下架（BUG-078 就是实例）、400 参数错误或工具载荷问题，
 *    把"句子里出现 schema/tool"的其它错误一并吞掉 = 编一句错的中文，违反本文件第一条纪律。
 *
 * ⚠️ 也**不许**把这句话解释成"必然是你的工具参数写错了"——原因只在上游拒绝的具体码里。
 */
describe('BUG-077：已知英文包装句 → i18n key（不在这里硬塞中文）', () => {
  const RAW = 'LLM request failed: provider rejected the request schema or tool payload.';
  const KEY = 'errors.wrapper.providerRequestRejected';

  it('⭐ 原句命中（大小写变体同样命中）', () => {
    expect(translateGatewayErrorKey(RAW)).toBe(KEY);
    expect(translateGatewayErrorKey('Provider rejected the request schema or tool payload')).toBe(KEY);
    expect(translateGatewayErrorKey(RAW.toUpperCase())).toBe(KEY);
  });

  it('⭐ 客户端「推流: 」前缀 / 其它包装前缀不挡命中（BUG-077 截图形态）', () => {
    expect(translateGatewayErrorKey(`推流: ${RAW}`)).toBe(KEY);
    expect(translateGatewayErrorKey(`⚠️ ${RAW}`)).toBe(KEY);
    expect(translateGatewayErrorKey(`GatewayClientRequestError: ${RAW}`)).toBe(KEY);
  });

  it('窄匹配：只有 schema / 只有 tool payload 的其它原文一律不吞', () => {
    expect(translateGatewayErrorKey('tool payload schema mismatch in report.json')).toBeNull();
    expect(translateGatewayErrorKey('provider rejected the request')).toBeNull();
    expect(translateGatewayErrorKey('the request schema was rejected by our validator')).toBeNull();
  });

  it('限流/额度（429/402 家族）的措辞不吃这条 —— 它们各自的明确文案照旧先行', () => {
    // 审计硬约束：不得让泛化包装文案盖过既有 429/402/context/timeout/拒绝类别
    expect(translateGatewayErrorKey('LLM request failed: insufficient_quota (kind=arrears)')).toBeNull();
    expect(translateGatewayErrorKey('request failed (HTTP 429) rate limit exceeded')).toBeNull();
    expect(translateGatewayErrorKey('insufficient balance: 402')).toBeNull();
  });

  it('未知原文 / 空 → null（调用方回退原文）', () => {
    expect(translateGatewayErrorKey('some brand new gateway wording')).toBeNull();
    expect(translateGatewayErrorKey('')).toBeNull();
    expect(translateGatewayErrorKey(undefined)).toBeNull();
  });

  it('它**不**走中文硬编码翻译器（否则只有中文语言受益）', () => {
    expect(translateGatewayError(RAW)).toBeNull();
  });
});
