import { describe, expect, it } from 'vitest';
import { extractDeltaText, extractToolCalls } from '../src/protocol/parse-content.js';

/**
 * `chat` 的 delta 帧里**正文到底该追加还是该替换**。
 *
 * ## 真 bug（2026-09-19 实测定位）
 *
 * 我们原来对 delta 一律 `appendStreamDelta(extractText(payload))`，而
 * `extractText` 取的是 `message.content[0].text` —— 那是**到此刻为止的全文**，
 * **不是增量**。两条独立证据：
 *
 * 1. **白皮书**（2026.4.2 时代，也就是代码当初照着写的契约）在 §4.2 明写：
 *    「delta: `message.content[0].text` contains the **full accumulated text** up to this point
 *    (not just the delta)」。
 * 2. **真实日志**（09-14，`renderer.chat.delta.applied`）：一轮 118 帧的 Σ字符数
 *    **84,927**，而那一轮的 `final` 只有 **1,486** —— **57 倍**。5–57 倍的膨胀
 *    只可能是"把全文当增量拼起来"。
 *
 * ⇒ 症状：**流式期间正文重复膨胀**，到 `final`（来自网关历史）才纠正回来。
 *    这解释了"卡住好久突然跳出来"之外的另一半 —— 中途看到的字是错的。
 *
 * ## 三种形状（每种都要有理由，不能一律）
 *
 * | 帧 | 正文在哪 | 语义 | 该做什么 |
 * | --- | --- | --- | --- |
 * | v4 delta | `deltaText` | **增量** | 追加 |
 * | v4 delta + `replace` | `deltaText` | **全文**（网关发现不是前缀，重新给一份） | 替换 |
 * | 旧形状 delta / final | `message.content` | **全文** | 替换 |
 */

const p = (o: Record<string, unknown>) => o as never;

describe('extractDeltaText —— 追加还是替换', () => {
  it('⭐ v4：有 `deltaText` 且没 `replace` ⇒ 那是**增量**，追加', () => {
    const r = extractDeltaText(p({ deltaText: '世界', message: { content: [{ type: 'text', text: '你好世界' }] } }));

    expect(r).toEqual({ text: '世界', replace: false });
  });

  it('⭐ 有 `replace: true` ⇒ `deltaText` 是**全文**，必须替换（不能追加！）', () => {
    // 网关在"新文本不是旧文本的前缀"时会走这条路（`resolveBroadcastDelta` 的第三个分支）
    const r = extractDeltaText(p({ deltaText: '完全重写的正文', replace: true }));

    expect(r).toEqual({ text: '完全重写的正文', replace: true });
  });

  it('⚠️ **旧形状**（没有 `deltaText`）⇒ `message.content` 是全文，替换 —— 这正是那个 57 倍的来源', () => {
    const r = extractDeltaText(p({ message: { content: [{ type: 'text', text: '到此刻为止的全文' }] } }));

    expect(r, 'content 是全文快照，追加它就是把答案重复 N 遍').toEqual({
      text: '到此刻为止的全文',
      replace: true,
    });
  });

  it('旧形状的另一种写法（顶层 `content`）也走替换', () => {
    expect(extractDeltaText(p({ content: [{ type: 'text', text: '全文' }] }))).toEqual({ text: '全文', replace: true });
  });

  it('⭐ `deltaText` 优先于 `message.content`（v4 帧两者都有，取**增量**那个）', () => {
    // 这是最关键的一条：v4 帧**同时**带 `deltaText`（增量）和 `message.content`（全文）。
    // 取错一个就是 57 倍膨胀。
    const r = extractDeltaText(
      p({ deltaText: '增量', message: { content: [{ type: 'text', text: '很长很长的全文'.repeat(50) }] } }),
    );

    expect(r.text).toBe('增量');
    expect(r.replace).toBe(false);
  });

  it('空帧 / 认不出 ⇒ 空文本、不替换（别把已有正文清掉）', () => {
    expect(extractDeltaText(p({}))).toEqual({ text: '', replace: false });
    expect(extractDeltaText(p({ deltaText: '' }))).toEqual({ text: '', replace: false });
    expect(extractDeltaText(p({ message: { content: [] } }))).toEqual({ text: '', replace: false });
  });

  it('⚠️ `replace: true` 但 `deltaText` 是空的 ⇒ **不替换**（空的 replace 会把正文清空）', () => {
    // `resolveBroadcastDelta` 里 `replace` 只在有文本时才给，但契约上要挡住：
    // 一次空的替换 = 用户眼看着已生成的内容消失。
    expect(extractDeltaText(p({ deltaText: '', replace: true }))).toEqual({ text: '', replace: false });
  });
});

/**
 * V1（2026-10-13 集中整改 step 1）：chat 帧里的 toolCall 块是**模型声明**，不是执行证据。
 *
 * 旧行为：`extractToolCalls` 把声明落成 `running` 并当场读时钟造 `startedAt` ——
 * 一张**从未被确认执行**的卡片转圈 + 计时，是在编"正在执行"。
 * 新语义：返回 `declared`（声明态）、`startedAt: ''`；解析器**不读时钟**。
 * 真正的 running/done/error 只由 `agent/tool` 流（有执行证据）产生并覆盖声明。
 */
describe('extractToolCalls —— V1 模型声明 = declared，不造开始时间', () => {
  it('⭐ toolCall 块 ⇒ declared + startedAt 空串（不得落 running）', () => {
    const calls = extractToolCalls(
      p({ message: { content: [{ type: 'toolCall', id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}' }] } }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ id: 'c1', name: 'read_file', status: 'declared', startedAt: '' });
  });

  it('⭐ 顶层 `content` 形状同样返回 declared', () => {
    const calls = extractToolCalls(p({ content: [{ type: 'toolCall', id: 'c2', name: 'exec' }] }));

    expect(calls[0]).toMatchObject({ id: 'c2', name: 'exec', status: 'declared', startedAt: '' });
  });

  it('⭐ 解析器不读时钟：声明没有开始时间（startedAt 恒为空串，不是某个时刻）', () => {
    const before = Date.now();
    const first = extractToolCalls(p({ message: { content: [{ type: 'toolCall', id: 'c3', name: 'ls' }] } }));
    // 即使真的过了时间，声明也不会带上任何时间戳
    expect(first[0].startedAt).toBe('');
    expect(first[0].completedAt).toBeUndefined();
    void before;
  });

  it('无 id / 无 name 的块不算工具调用（与既有三条件过滤一致）', () => {
    expect(
      extractToolCalls(
        p({
          message: {
            content: [
              { type: 'toolCall', name: 'no-id' },
              { type: 'toolCall', id: 'no-name' },
            ],
          },
        }),
      ),
    ).toEqual([]);
  });
});
