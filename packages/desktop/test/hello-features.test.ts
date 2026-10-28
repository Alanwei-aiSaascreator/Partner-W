import { describe, expect, it } from 'vitest';
import { parseHelloFeatures, helloFeatureLogData, createAdvertisedSurface } from '../src/main/ws/hello-features';

/**
 * `hello-ok` 里**网关自报的能力面**。
 *
 * ## 为什么要有它
 *
 * 整个 2026-09 的协议漂移（白皮书停在 4.2、运行时是 9.3）都是靠**事后读源码**才发现
 * 的 —— 而网关**每次握手都把自己的方法表/事件表/能力表发给我们**，我们整块丢掉了。
 * 契约在 `packages/gateway-protocol/src/schema/frames.ts` 的 `HelloOkSchema`：
 * `features.methods` / `features.events` 是**必需**字段，`capabilities` 可选。
 *
 * ⇒ 接上它，"服务器到底支持什么"从"五个月后读源码"变成"连上就知道"。
 *    这一刀**只做可观测性**（往调试日志里记），不改任何行为。
 */

/** 真形状（照 `HelloOkSchema` 写的最小样本）。 */
const realShape = {
  type: 'hello-ok',
  protocol: 4,
  server: { version: '2026.9.3', connId: 'c-1' },
  features: {
    methods: ['chat.send', 'session.list', 'question.resolve'],
    events: ['chat', 'agent', 'sessions.changed'],
    capabilities: ['chat.send.routing-contract', 'session.unread-ack-contract'],
  },
};

describe('parseHelloFeatures —— 解析网关自报的能力面', () => {
  it('⭐ 从真形状里解析出协议版本、方法表、事件表、能力表', () => {
    const f = parseHelloFeatures(realShape);

    expect(f).not.toBeNull();
    expect(f?.protocol).toBe(4);
    expect(f?.methods).toEqual(['chat.send', 'session.list', 'question.resolve']);
    expect(f?.events).toEqual(['chat', 'agent', 'sessions.changed']);
    expect(f?.capabilities).toEqual(['chat.send.routing-contract', 'session.unread-ack-contract']);
  });

  it('⚠️ 整块没有 `features`（老网关 / 异常帧）⇒ 返回 null，**不抛**', () => {
    // 我们连的不一定是 9.3 的网关 —— 拿不到就说拿不到，别把握手搞崩。
    expect(parseHelloFeatures({ type: 'hello-ok' })).toBeNull();
    expect(parseHelloFeatures({})).toBeNull();
  });

  it('`capabilities` 是可选的 ⇒ 缺了给空数组（日志里好读，不是 undefined）', () => {
    const f = parseHelloFeatures({ features: { methods: ['a'], events: ['b'] } });

    expect(f?.capabilities).toEqual([]);
    expect(f?.methods).toEqual(['a']);
  });

  it('⚠️ 字段类型不对 ⇒ 当空表，不抛（畸形帧不该把连接打掉）', () => {
    const f = parseHelloFeatures({ features: { methods: 'chat.send', events: null } });

    expect(f?.methods).toEqual([]);
    expect(f?.events).toEqual([]);
  });

  it('列表里混进非字符串 ⇒ 只留字符串（别把对象塞进日志）', () => {
    const f = parseHelloFeatures({ features: { methods: ['ok', 42, null, { a: 1 }, 'ok2'], events: [] } });

    expect(f?.methods).toEqual(['ok', 'ok2']);
  });

  it('⚠️ 空方法表**也是信息**（说明网关没广告任何方法）⇒ 照实返回 0，不是 null', () => {
    const f = parseHelloFeatures({ features: { methods: [], events: [] } });

    expect(f).not.toBeNull();
    expect(f?.methods).toEqual([]);
  });

  it('`protocol` 不是数字 ⇒ null（不猜）', () => {
    expect(parseHelloFeatures({ features: { methods: [], events: [] }, protocol: '4' })?.protocol).toBeNull();
    expect(parseHelloFeatures({ features: { methods: [], events: [] } })?.protocol).toBeNull();
  });
});

describe('helloFeatureLogData —— 落到调试日志里的形状', () => {
  it('⭐ 记**数量**而不是整份清单（方法表有 400+ 条，塞进日志没法看）', () => {
    const data = helloFeatureLogData(realShape);

    expect(data).toEqual({
      protocol: 4,
      advertisedMethods: 3,
      advertisedEvents: 3,
      capabilities: ['chat.send.routing-contract', 'session.unread-ack-contract'],
    });
    // 数量能一眼看出漂移；清单本身太长
    expect(JSON.stringify(data)).not.toContain('question.resolve');
  });

  it('⚠️ 没有 `features` ⇒ 记一条明确的"没广告"，而不是空对象', () => {
    expect(helloFeatureLogData({ type: 'hello-ok' })).toEqual({ advertisedFeatures: 'missing' });
  });
});

/**
 * 「我们要调的方法，网关**广告过**吗」——在 `sendReq` 那个唯一咽喉点上问一句。
 *
 * ## 为什么值得
 *
 * 这一整轮的教训都是同一个形状：**我们以为网关有，其实没有**（方法被删、字段改名、
 * 事件分流变了）。而网关**每次握手都把方法表送过来** —— 有了它，"调一个不存在的方法"
 * 从"等它失败 / 五个月后读源码"变成"当场记一条"。
 *
 * ⚠️ **零行为变更**：照样把请求发出去（不拦、不改道）。这是**诊断**，不是门禁。
 *    要拿它做门禁（不支持就不显示入口）是另一刀，且属产品选择。
 */
describe('createAdvertisedSurface —— 调了网关没广告的方法吗', () => {
  it('⭐ 广告过 ⇒ 永远不报', () => {
    const s = createAdvertisedSurface();
    s.setAdvertised(['chat.send', 'sessions.list']);

    expect(s.takeUnadvertised('chat.send')).toBe(false);
    expect(s.takeUnadvertised('chat.send')).toBe(false);
  });

  it('⭐ 没广告过 ⇒ 第一次报，**同一个方法第二次不报**（否则 `chat.send` 会刷屏）', () => {
    const s = createAdvertisedSurface();
    s.setAdvertised(['sessions.list']);

    expect(s.takeUnadvertised('chat.send')).toBe(true);
    expect(s.takeUnadvertised('chat.send'), '第二次不该再报 —— 一条就够定位了').toBe(false);
    expect(s.takeUnadvertised('chat.send')).toBe(false);
  });

  it('不同的方法各报各的（一次只报一条，但每个都报得到）', () => {
    const s = createAdvertisedSurface();
    s.setAdvertised([]);

    expect(s.takeUnadvertised('a.method')).toBe(true);
    expect(s.takeUnadvertised('b.method')).toBe(true);
    expect(s.takeUnadvertised('a.method')).toBe(false);
  });

  it('⚠️ **还没收到 `hello-ok`**（没有广告表）⇒ 永远不报 —— "不知道"不等于"没有"', () => {
    // 握手之前 / 老网关没有 `features` ⇒ 我们不能断言任何事。
    // 在这里报会把**每次连接的头几个请求**全报一遍，纯噪音。
    const s = createAdvertisedSurface();

    expect(s.takeUnadvertised('chat.send')).toBe(false);
    expect(s.takeUnadvertised('anything')).toBe(false);
  });

  it('⭐ 重连后拿到**新的**广告表 ⇒ 已报过的可以**再报一次**（网关可能被降级了）', () => {
    // ⚠️ 第一版这里写错了：先 `setAdvertised(['chat.send'])`，于是第一次 take 返回 **false**
    //    （它广告过）—— 根本没有"已报过"这回事，用例等于没测到重置。
    //    变异验证当场抓出来（去掉重置逻辑那条**存活**）。现在让第一轮**真的报一次**。
    const s = createAdvertisedSurface();
    s.setAdvertised(['sessions.list']);
    expect(s.takeUnadvertised('chat.send'), '第一轮就没广告过 ⇒ 报').toBe(true);

    s.setAdvertised(['other.method']); // 新的一轮握手，仍然没有 chat.send

    expect(s.takeUnadvertised('chat.send'), '新广告表里仍然没有它，值得再说一次').toBe(true);
  });

  it('同一份广告表重复 set ⇒ 不清空已报记录（否则每次重设都会重报）', () => {
    const s = createAdvertisedSurface();
    s.setAdvertised(['sessions.list']);
    expect(s.takeUnadvertised('chat.send')).toBe(true);

    s.setAdvertised(['sessions.list']);

    expect(s.takeUnadvertised('chat.send'), '内容没变就不该重报').toBe(false);
  });

  it('空广告表 ⇒ 什么都报（网关明确说"我什么都没有"——这是确定的，不是"不知道"）', () => {
    const s = createAdvertisedSurface();
    s.setAdvertised([]);

    expect(s.takeUnadvertised('whatever')).toBe(true);
  });
});
