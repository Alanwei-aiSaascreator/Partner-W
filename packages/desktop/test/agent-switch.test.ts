import { describe, expect, it } from 'vitest';
import { resolvePendingAfterAgentSwitch } from '../src/renderer/lib/agent-switch';
import { ASSISTANT_TASK_PRESETS } from '../src/renderer/lib/assistant-task-presets';
import {
  ASSISTANT_TASK_PRESET_TAG_PREFIX,
  encodeAssistantTaskPresetTag,
} from '../src/renderer/lib/assistant-task-preset-tags';

/**
 * 用**真的**编码器造一个预设标签 —— 写死字符串的话，前缀一改这里就悄悄失效了
 * （`encodeAssistantTaskPresetTag` 只认规范 id，瞎编的 id 会返回 null）。
 */
const encodedPresetTag = encodeAssistantTaskPresetTag(ASSISTANT_TASK_PRESETS[0]?.id ?? '');
if (!encodedPresetTag) throw new Error('夹具：第一个任务预设 id 编不出标签');
const PRESET_TAG: string = encodedPresetTag;

/**
 * 切助手时 `pendingNewTask` 的整理规则（2026-09-19）。
 *
 * 这段逻辑从 `LeftNav.handleSelectAgent` 里抽出来，是为了给「身份中心 → 应用此画像」
 * 复用 —— 两边各写一遍的话，最可能漏的就是**清预设标签**这一步：
 * 用户新任务打到一半换了助手，标签却还挂着上一个助手的预设。
 */
describe('resolvePendingAfterAgentSwitch', () => {
  it('前提：造出来的确实是个预设标签', () => {
    expect(PRESET_TAG.startsWith(ASSISTANT_TASK_PRESET_TAG_PREFIX)).toBe(true);
  });

  it('⭐ 换到别的助手 ⇒ 清掉旧助手的任务预设标签（普通标签保留）', () => {
    const next = resolvePendingAfterAgentSwitch(
      { gatewayId: 'gw-1', agentId: 'rongying-content', tags: [PRESET_TAG, 'my-own-tag'] },
      'gw-1',
      'rongying-office',
    );

    expect(next.gatewayId).toBe('gw-1');
    expect(next.agentId).toBe('rongying-office');
    expect(next.tags).toEqual(['my-own-tag']);
    expect((next.tags ?? []).some((tag) => tag.startsWith(ASSISTANT_TASK_PRESET_TAG_PREFIX))).toBe(false);
  });

  it('⭐ 点的还是**同一个**助手 ⇒ 标签原样保留（别把用户自己选的丢掉）', () => {
    const next = resolvePendingAfterAgentSwitch(
      { gatewayId: 'gw-1', agentId: 'rongying-office', tags: [PRESET_TAG, 'my-own-tag'], model: 'qwen-max' },
      'gw-1',
      'rongying-office',
    );

    expect(next.tags).toEqual([PRESET_TAG, 'my-own-tag']);
    expect(next.model).toBe('qwen-max');
  });

  it('网关不同也算换了助手（gatewayId 与 agentId 要同时相等才算同一个）', () => {
    const next = resolvePendingAfterAgentSwitch(
      { gatewayId: 'gw-2', agentId: 'rongying-office', tags: [PRESET_TAG] },
      'gw-1',
      'rongying-office',
    );

    expect(next.gatewayId).toBe('gw-1');
    expect(next.tags).toBeUndefined();
  });

  it('没有待发任务（null）⇒ 造一个只带 gatewayId/agentId 的', () => {
    const next = resolvePendingAfterAgentSwitch(null, 'gw-1', 'rongying-office');

    expect(next).toEqual({ gatewayId: 'gw-1', agentId: 'rongying-office' });
  });

  it('清完标签为空 ⇒ 不带 `tags` 字段（别留一个空数组）', () => {
    const next = resolvePendingAfterAgentSwitch(
      { gatewayId: 'gw-1', agentId: 'rongying-content', tags: [PRESET_TAG] },
      'gw-1',
      'rongying-office',
    );

    expect('tags' in next).toBe(false);
  });

  it('与助手无关的字段（model / thinkingLevel / ensemble / teamId）原样带过去', () => {
    const next = resolvePendingAfterAgentSwitch(
      {
        gatewayId: 'gw-1',
        agentId: 'rongying-content',
        model: 'qwen-max',
        thinkingLevel: 'high',
        ensemble: true,
        teamId: 'team-9',
      },
      'gw-1',
      'rongying-office',
    );

    expect(next).toMatchObject({
      model: 'qwen-max',
      thinkingLevel: 'high',
      ensemble: true,
      teamId: 'team-9',
    });
  });
});
