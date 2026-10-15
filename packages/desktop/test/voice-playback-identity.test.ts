import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  deriveVoiceSentenceRequestId,
  voiceSentenceBindingString,
  type VoiceSentenceIdentity,
} from '../src/renderer/lib/voice/playback-identity';

const base: VoiceSentenceIdentity = {
  target: { accountKey: 'user-1', taskId: 'task-1', sessionKey: 'session-1' },
  answerDigest: 'a'.repeat(64),
  completedPlaybacks: 0,
  sentenceIndex: 0,
  text: '你好，世界。😀',
};

/** 文档口径的折叠规则：sha256 前 128 位 → UUIDv4 形状（version=4，variant 取 10 位）。 */
function referenceIdFrom(binding: string): string {
  const hex = createHash('sha256').update(binding, 'utf8').digest('hex');
  const chars = hex.slice(0, 32).split('');
  chars[12] = '4';
  chars[16] = '89ab'[Number.parseInt(hex[16]!, 16) % 4]!;
  return `${chars.slice(0, 8).join('')}-${chars.slice(8, 12).join('')}-${chars.slice(12, 16).join('')}-${chars
    .slice(16, 20)
    .join('')}-${chars.slice(20, 32).join('')}`;
}

describe('语音朗读请求身份派生（R8-05 / VV-1）', () => {
  it('同一逻辑分句重复派生得到逐字节相同的 UUIDv4 形状身份', async () => {
    const first = await deriveVoiceSentenceRequestId(base);
    const second = await deriveVoiceSentenceRequestId({ ...base, target: { ...base.target } });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('身份 = sha256(绑定串) 折 UUIDv4 形状（与文档口径逐字符一致）', async () => {
    const binding = voiceSentenceBindingString(base);
    // 绑定串里写进音色与最终内容：改名/换句/换目标都会改身份，不能只看文本
    expect(binding).toContain('voice=Cherry');
    expect(binding).toContain('sentence=0');
    expect(binding).toContain(`answer=${'a'.repeat(64)}`);
    expect(binding).toContain('text=你好，世界。😀');
    expect(await deriveVoiceSentenceRequestId(base)).toBe(referenceIdFrom(binding));
  });
  it('UTF-8 编码与 node:crypto 的 sha256 逐字节一致（中文/emoji/代理对绑定串）', async () => {
    for (const text of ['中文😀 mixed-ASCII', 'plain', 'ü ß ẞ', '🙂🙃']) {
      const identity = { ...base, text };
      expect(await deriveVoiceSentenceRequestId(identity)).toBe(referenceIdFrom(voiceSentenceBindingString(identity)));
    }
  });
  it('账号/任务/会话/回答修订/分句序号/分句文本/完整播完次数任一变化都换身份', async () => {
    const ids = await Promise.all([
      deriveVoiceSentenceRequestId(base),
      deriveVoiceSentenceRequestId({ ...base, target: { ...base.target, accountKey: 'user-2' } }),
      deriveVoiceSentenceRequestId({ ...base, target: { ...base.target, taskId: 'task-2' } }),
      deriveVoiceSentenceRequestId({ ...base, target: { ...base.target, sessionKey: 'session-2' } }),
      deriveVoiceSentenceRequestId({ ...base, answerDigest: 'b'.repeat(64) }),
      deriveVoiceSentenceRequestId({ ...base, sentenceIndex: 1 }),
      deriveVoiceSentenceRequestId({ ...base, text: '换了分句' }),
      deriveVoiceSentenceRequestId({ ...base, completedPlaybacks: 1 }),
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
