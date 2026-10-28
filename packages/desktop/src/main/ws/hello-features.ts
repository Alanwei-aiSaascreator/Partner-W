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
 * 「我们要调的方法，网关**广告过**吗」—— 在 `sendReq` 那个唯一咽喉点上问一句。
 *
 * ## 为什么值得
 *
 * 这一整轮的教训都是同一个形状：**我们以为网关有，其实没有**（方法被删、字段改名、
 * 事件分流变了）。而网关**每次握手都把方法表送过来** —— 有了它，"调一个不存在的方法"
 * 从"等它失败 / 五个月后读源码"变成"当场记一条"。
 *
 * ## ⚠️ 零行为变更
 *
 * 照样把请求发出去（**不拦、不改道、不重试**）。这是**诊断**，不是门禁。
 * 要拿它做门禁（比如"网关没有 `question.list` 就不显示问题卡片"）是另一刀，
 * 而且属产品选择（不支持时**隐藏**还是**禁用**，得有人拍）。
 *
 * ## 三条判断（都有用例钉着）
 *
 * 1. **没有广告表 ⇒ 永远不报**：握手之前 / 老网关没有 `features` ⇒ 我们**不能断言任何事**。
 *    在这里报会把每次连接的头几个请求全报一遍，纯噪音。"不知道"不等于"没有"。
 * 2. **空广告表 ⇒ 什么都报**：网关**明确说**"我什么都没有"，这是确定的判断，不是不知道。
 * 3. **每个方法只报一次**：`chat.send` 一轮会调很多次，每次都报等于没报。
 *    但**拿到新的广告表就重置已报记录** —— 重连后网关可能被降级了，值得再说一次。
 */
export interface AdvertisedSurface {
  /** 收到 `hello-ok` 时喂进来。**内容与上次相同则不清空已报记录**（否则每次重设都重报）。 */
  setAdvertised(methods: string[]): void;
  /**
   * 这个方法没被广告过吗？**每个方法只会回答一次 `true`**（消费式命名就是这个意思）。
   */
  takeUnadvertised(method: string): boolean;
}

export function createAdvertisedSurface(): AdvertisedSurface {
  let advertised: Set<string> | null = null;
  let lastSignature: string | null = null;
  let warned = new Set<string>();

  return {
    setAdvertised(methods) {
      // ⚠️ 用**排序后的签名**比对："内容没变"不该重置已报记录（重连时很容易重复喂同一份）。
      const signature = [...methods].sort().join('\n');
      if (signature !== lastSignature) warned = new Set();
      lastSignature = signature;
      advertised = new Set(methods);
    },
    takeUnadvertised(method) {
      if (!advertised) return false; // 不知道 ≠ 没有
      if (advertised.has(method)) return false;
      if (warned.has(method)) return false;
      warned.add(method);
      return true;
    },
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
