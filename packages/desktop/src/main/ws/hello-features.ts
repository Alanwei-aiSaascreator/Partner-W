/**
 * `hello-ok` 里**网关自报的能力面**：解析 + 落日志的形状。
 *
 * ## 为什么要有这个文件
 *
 * 2026-09 那一整轮协议漂移（白皮书停在 2026.4.2、随包运行时是 2026.9.3）全都是
 * **事后读源码**才发现 —— 而网关**每次握手都把自己的方法表/事件表/能力表发过来**，
 * 我们此前整块丢掉。契约在 `packages/gateway-protocol/src/schema/frames.ts`：
 *
 * ```ts
 * features: closedObject({
 *   methods: Type.Array(NonEmptyString),   // 必需
 *   events: Type.Array(NonEmptyString),    // 必需
 *   capabilities: Type.Optional(...),
 * })
 * ```
 *
 * ⇒ 接上它之后，"服务器到底支持什么"从"五个月后读源码"变成"连上就知道"。
 *
 * ## 这一刀**只做可观测性**
 *
 * 不改任何行为：不拿它做能力门禁、不据此启用/禁用功能。原因很简单 —— **先看得见，才谈得上用**，
 * 而"看见"这一步零风险。将来要拿它做门禁（比如"网关没有 `question.list` 就不显示问题卡片"），
 * 那是另一刀的事。
 *
 * ## 两条纪律
 *
 * 1. **拿不到就说拿不到，不抛**：我们连的不一定是 2026.9.3 的网关，畸形帧不能把连接打掉。
 * 2. **日志里记数量、不记整份清单**：方法表有 400+ 条，塞进日志没法看；而**数量**足以
 *    一眼看出漂移。capabilities 少（十几个）⇒ 照原样记。
 */

export interface HelloFeatures {
  /** 服务端**当前**协议版本（`HelloOkSchema.protocol`）。解析不出就是 `null`。 */
  protocol: number | null;
  methods: string[];
  events: string[];
  /** 可选字段；缺失时给**空数组**（日志里好读，不是 `undefined`）。 */
  capabilities: string[];
}

/** 只留字符串，其余（数字/对象/null）一律丢掉 —— 别把对象塞进日志。 */
function onlyStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * 从 `hello-ok` 的 payload 里挖出能力面。
 *
 * ⚠️ 没有 `features` 整块时返回 `null`（**不是**空对象）—— 调用方要能区分
 *    "网关广告了 0 个方法"和"网关没广告"。
 */
export function parseHelloFeatures(payload: Record<string, unknown>): HelloFeatures | null {
  const features = payload['features'];
  if (!features || typeof features !== 'object') return null;
  const f = features as Record<string, unknown>;

  const protocol = payload['protocol'];
  return {
    protocol: typeof protocol === 'number' && Number.isFinite(protocol) ? protocol : null,
    methods: onlyStrings(f['methods']),
    events: onlyStrings(f['events']),
    capabilities: onlyStrings(f['capabilities']),
  };
}

/**
 * 落进调试日志的形状。
 *
 * ⚠️ 记**数量**而不是整份清单：方法表 400+ 条，塞进日志就没人看了；而数量足以看出
 *    "网关的方法表变了"。capabilities 少且是能力协商的关键，**照原样记**。
 */
export function helloFeatureLogData(payload: Record<string, unknown>): Record<string, unknown> {
  const features = parseHelloFeatures(payload);
  if (!features) {
    // 明确的"没广告"，不是空对象 —— 空对象在日志里看不出是"没字段"还是"解析失败"
    return { advertisedFeatures: 'missing' };
  }
  return {
    protocol: features.protocol,
    advertisedMethods: features.methods.length,
    advertisedEvents: features.events.length,
    capabilities: features.capabilities,
  };
}
