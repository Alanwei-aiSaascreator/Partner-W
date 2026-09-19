import { describe, expect, it } from 'vitest';
import { parseHelloFeatures, helloFeatureLogData } from '../src/main/ws/hello-features';

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
