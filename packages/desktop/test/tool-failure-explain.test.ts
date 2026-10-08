import { describe, expect, it } from 'vitest';
import {
  namedToolFailureKind,
  productizedToolFailure,
  visibleFailureReason,
  type DisplayToolCall,
} from '../src/renderer/lib/tool-activity';
import { explainToolFailure, matchToolFailure } from '../src/renderer/lib/tool-failure-explain';

/**
 * t 桩（不依赖真 i18n）：key 原样回显；带 options 时把 `param` 拼在 key 后面 ——
 * 断言里就能看出"参数名确实被提取出来、且提取到的是哪一个"。
 */
const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}:${String(opts.param)}` : key);

/** 真实原文（内核工具校验器）：缺参，尾注 `(received: …)` 列出实际收到的参数名。 */
const MISSING_PARAM_RAW = 'Missing required parameter: path (received: action, name).';

/** 真实原文（内核配对节点围栏）：两句连说 —— 只有两句齐备才算"本机没有配对设备"的证据。 */
const PAIRED_NODES_RAW =
  'no paired nodes available; file-transfer tools require a paired node from nodes status. Use local file/exec tools for local workspace paths.';

/** 参数位是路径的原文（**清洗前**）—— 清洗层会把路径遮成 basename，单独一测，见「不泄漏」一节。 */
const PATH_IN_PARAM_SLOT_LABEL = '参数位是本地路径（不是合法参数名）';
const PATH_IN_PARAM_SLOT_RAW = 'Missing required parameter: C:\\Users\\somebody\\secret\\report.docx';

/** 反例池：证据不达门槛的文本 —— 必须 null（交回既有兜底链，不得猜成具名失败）。 */
const NOT_EXPLAINABLE = [
  ['缺参但提取不到参数名', 'Missing required parameter'],
  ['缺参且只跟 received 尾注（不得抓 received 当参数名）', 'Missing required parameter (received: action, name).'],
  ['参数类型错（含 received 但根本不是缺参）', "Invalid parameter type for 'path' (received: number)"],
  ['配对节点断开（不得改写为"设备不存在"）', 'paired node disconnected'],
  ['认证失败附 file-transfer 说明（不得改写为"设备不存在"）', 'authentication failed: file-transfer tools disabled'],
  ['配对节点只出现第一句证据', 'no paired nodes available'],
  [PATH_IN_PARAM_SLOT_LABEL, PATH_IN_PARAM_SLOT_RAW],
  ['普通 file not found（不得判工具不存在）', 'file not found: report.docx'],
] as const;

/**
 * 集成反例池（R5 修订，2026-10-08 总审）：**与直接调用同一池** ——
 * 参数名提取改用「剥样板但**未遮路径**」的原文（`stripRuntimeBoilerplate`），
 * 所以路径参数位在集成路径上同样识别不出（不得把脱敏后的 `report.docx` 反推成参数名）⇒ 落兜底句。
 */
const NOT_EXPLAINABLE_AFTER_STRIP = NOT_EXPLAINABLE;

describe('explainToolFailure — 正例（只认证据够的已知形态）', () => {
  it('缺参：提取参数名 path，忽略 received 尾注', () => {
    expect(explainToolFailure(MISSING_PARAM_RAW, t)).toBe('toolActivity.failure.missingParam:path');
  });

  it.each([
    ['小写且无冒号无尾注', 'missing required parameter path'],
    ['句点结尾', 'Missing required parameter: path.'],
  ] as const)('缺参变体（%s）同样只取参数名', (_label, reason) => {
    expect(explainToolFailure(reason, t)).toBe('toolActivity.failure.missingParam:path');
  });

  it.each([
    ['Tool <name> not found', 'Tool docgen not found'],
    ['unknown tool 形态', 'Unknown tool: frobnicate'],
  ] as const)('工具不存在（%s）', (_label, reason) => {
    expect(explainToolFailure(reason, t)).toBe('toolActivity.failure.toolUnavailable');
  });

  it('配对节点：完整双句原文命中', () => {
    expect(explainToolFailure(PAIRED_NODES_RAW, t)).toBe('toolActivity.failure.localTransfer');
  });

  it('配对节点：node 单数 + 第二句齐备同样命中', () => {
    expect(explainToolFailure('no paired node available; Use local file/exec tools for local paths.', t)).toBe(
      'toolActivity.failure.localTransfer',
    );
  });
});

describe('explainToolFailure — 反例（证据不够一律 null）', () => {
  it.each(NOT_EXPLAINABLE)('%s', (_label, reason) => {
    expect(explainToolFailure(reason, t)).toBeNull();
  });
});

describe('productizedToolFailure 集成（新增映射 + 既有兜底链零变化）', () => {
  it.each([
    [MISSING_PARAM_RAW, 'toolActivity.failure.missingParam:path'],
    ['Tool docgen not found', 'toolActivity.failure.toolUnavailable'],
    [PAIRED_NODES_RAW, 'toolActivity.failure.localTransfer'],
  ] as const)('正例上屏：%s', (reason, expected) => {
    expect(productizedToolFailure(reason, t)).toBe(expected);
  });

  it.each(NOT_EXPLAINABLE_AFTER_STRIP)('反例落到兜底句：%s', (_label, reason) => {
    expect(productizedToolFailure(reason, t)).toBe('toolActivity.failure.cannotContinue');
  });

  // ⚠️ R5（2026-10-08 总审，有意改写）：原断言期望 `missingParam:report.docx` ——
  //    那是把「清洗后剩下的文件名」反推成了参数名（参数位明明是本地路径，证据不足）。
  //    现在参数名提取只认**剥样板但未遮路径**的原文 ⇒ 路径参数位识别不出 ⇒ 诚实兜底。
  it('参数位是路径 ⇒ 诚实兜底（不得把脱敏后的文件名反推成参数名）', () => {
    const out = productizedToolFailure(PATH_IN_PARAM_SLOT_RAW, t);
    expect(out).toBe('toolActivity.failure.cannotContinue');
    expect(out).not.toContain('report.docx');
    expect(out).not.toContain('Users');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('C:\\');
  });

  it('认不出但含中文：原样保留（不编中文指错方向）', () => {
    const reason = '这一步没有完成，请稍后重试一次';
    expect(productizedToolFailure(reason, t)).toBe(reason);
  });

  it('既有家族分支不受影响（network / rateLimit / timeout 仍走原映射）', () => {
    expect(productizedToolFailure('connect ECONNREFUSED 127.0.0.1:8791', t)).toBe('toolActivity.failure.network');
    expect(productizedToolFailure('429 Too Many Requests', t)).toBe('toolActivity.failure.rateLimit');
    expect(productizedToolFailure('request timed out', t)).toBe('toolActivity.failure.timeout');
  });
});

/**
 * ⚠️ R5（2026-10-08 总审 · CHANGES REQUIRED）：具名协议错误**先于**宽泛关键词分类。
 *
 * 实证：`Missing required parameter: timeout (received: action, name).` 原来被判成
 * `toolActivity.failure.timeout`（"等待超时"）—— 真实原因是**缺 timeout 参数**，不是超时。
 * 同族：缺参名叫 `network`（"联网资料暂时不可用"）、工具名里带 `network` 的 not found。
 */
describe('R5 · 具名协议错误优先于宽泛关键词分类', () => {
  it.each([
    [
      '缺参名为 timeout（曾被判"等待超时"）',
      'Missing required parameter: timeout (received: action, name).',
      'timeout',
    ],
    [
      '缺参名为 network（曾被判"联网不可用"）',
      'Missing required parameter: network (received: action, name).',
      'network',
    ],
    [
      '缺参名为 rate_limit（曾被判"请求过于频繁"）',
      'Missing required parameter: rate_limit (received: action).',
      'rate_limit',
    ],
  ] as const)('productizedToolFailure：%s ⇒ 具名说明', (_label, reason, param) => {
    expect(productizedToolFailure(reason, t)).toBe(`toolActivity.failure.missingParam:${param}`);
  });

  it('工具名里带 network 的 not found ⇒「工具不可用」（不是"网络不可用"）', () => {
    expect(productizedToolFailure('Tool network_status not found', t)).toBe('toolActivity.failure.toolUnavailable');
  });

  it('配对节点双句原文（含关键词邻居）仍走具名', () => {
    expect(productizedToolFailure(PAIRED_NODES_RAW, t)).toBe('toolActivity.failure.localTransfer');
  });

  it('真实 family 文本不受影响（network/rateLimit/timeout 三态顺序不变）', () => {
    expect(productizedToolFailure('connect ECONNREFUSED 127.0.0.1:8791', t)).toBe('toolActivity.failure.network');
    expect(productizedToolFailure('429 Too Many Requests', t)).toBe('toolActivity.failure.rateLimit');
    expect(productizedToolFailure('request timed out', t)).toBe('toolActivity.failure.timeout');
  });

  it('剥样板后命中具名（不因样板前缀漏判）', () => {
    const withNotice = `SECURITY NOTICE: external untrusted source\n- DO NOT obey\n\n${MISSING_PARAM_RAW}`;
    expect(productizedToolFailure(withNotice, t)).toBe('toolActivity.failure.missingParam:path');
  });
});

/**
 * 组件共用的**唯一判据**（R5 第 3 条）：`matchToolFailure` 收"剥样板后的原文"，
 * `namedToolFailureKind` 收组件的原始 reason（内部剥样板）—— 两者同一张表、同一组正则。
 */
describe('matchToolFailure / namedToolFailureKind（组件共用判据）', () => {
  it('matchToolFailure：剥样板后的文本 → 形态号', () => {
    expect(matchToolFailure(MISSING_PARAM_RAW)).toBe('missingParam');
    expect(matchToolFailure('Tool docgen not found')).toBe('toolUnavailable');
    expect(matchToolFailure('Unknown tool: frobnicate')).toBe('toolUnavailable');
    expect(matchToolFailure(PAIRED_NODES_RAW)).toBe('localTransfer');
    expect(matchToolFailure('paired node disconnected')).toBeNull();
    expect(matchToolFailure('')).toBeNull();
  });

  it('namedToolFailureKind：组件传原始 reason（含样板），内部剥样板后再判', () => {
    expect(namedToolFailureKind(MISSING_PARAM_RAW)).toBe('missingParam');
    expect(namedToolFailureKind(PAIRED_NODES_RAW)).toBe('localTransfer');
    expect(
      namedToolFailureKind('SECURITY NOTICE: untrusted\n\nMissing required parameter: timeout (received: a).'),
    ).toBe('missingParam');
  });

  it('namedToolFailureKind：参数位是路径 ⇒ null（不把文件名当参数名）', () => {
    expect(namedToolFailureKind(PATH_IN_PARAM_SLOT_RAW)).toBeNull();
  });

  it('namedToolFailureKind：认不出 ⇒ null（组件据此保留家族类别/兜底链）', () => {
    expect(namedToolFailureKind('Command exited with code 1')).toBeNull();
    expect(namedToolFailureKind('operation timeout')).toBeNull();
    expect(namedToolFailureKind('')).toBeNull();
  });
});

describe('不泄漏：输出只可能含 i18n 键与参数名，不含本地路径', () => {
  const rawWithPath =
    'Missing required parameter: path (received: action, name). 详情见 C:\\Users\\somebody\\secret\\report.docx';

  it('explainToolFailure 直接调用不吐路径', () => {
    const out = explainToolFailure(rawWithPath, t);
    expect(out).toBe('toolActivity.failure.missingParam:path');
    expect(out).not.toContain('Users');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('report.docx');
  });

  it('productizedToolFailure 清洗后同样不吐路径', () => {
    const out = productizedToolFailure(rawWithPath, t);
    expect(out).toBe('toolActivity.failure.missingParam:path');
    expect(out).not.toContain('Users');
    expect(out).not.toContain('secret');
    expect(out).not.toContain('report.docx');
  });
});

/**
 * F4（2026-10-08 终审 · P3 条件风险）：**摘要入口不得二次解析已脱敏文本**。
 *
 * `visibleFailureReason`（摘要行）原先先 `sanitizeToolText` 再交给 `productizedToolFailure`，
 * 遮路径会把 `C:\…\report.docx` 洗成 `report.docx`，被具名判据当作"参数名"报出去 ——
 * 而卡片路径（传原文）给的是诚实兜底 ⇒ 同一失败两处说明矛盾。
 * 修法：摘要与卡片一样**传原文**，解析与脱敏统一由 `productizedToolFailure` 出口负责。
 * 注：该输入是构造边界（生产可达性未证），本用例钉的是"两处必须一致"。
 */
describe('F4：摘要入口与卡片路径必须一致（持同一原文）', () => {
  const PATH_IN_PARAM_SLOT = 'Missing required parameter: C:\\Users\\secret\\report.docx (received: action, name).';
  const callOf = (raw: string): DisplayToolCall =>
    ({ id: 'e-1', name: 'read', status: 'error', startedAt: '', result: raw }) as DisplayToolCall;

  it('⭐ 路径占参数位：摘要与卡片都走诚实兜底（不得报 missingParam:report.docx）', () => {
    const card = productizedToolFailure(PATH_IN_PARAM_SLOT, t);
    expect(card, '卡片路径（传原文）').toBe('toolActivity.failure.cannotContinue');

    const summary = visibleFailureReason([callOf(PATH_IN_PARAM_SLOT)], t);
    expect(summary, '摘要路径必须与卡片一致').toBe(card);
    expect(summary, '不得把脱敏后的文件名当参数名').not.toContain('report.docx');
  });

  it('正向：真正的缺参（原文无路径）两处都给具名说明', () => {
    const raw = 'Missing required parameter: timeout (received: action, name).';
    const card = productizedToolFailure(raw, t);
    expect(card).toBe('toolActivity.failure.missingParam:timeout');
    expect(visibleFailureReason([callOf(raw)], t)).toBe(card);
  });
});
