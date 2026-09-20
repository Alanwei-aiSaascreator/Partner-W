import { describe, expect, it } from 'vitest';
import { allowsAudioMedia } from '../src/main/voice/media-permission';

/**
 * 麦克风权限的判据（外部审计 P5）。
 *
 * 审计点名的分支：`details.mediaType === 'unknown'` 也放行 —— 属"防御性不足"。
 *
 * ⚠️ 我们**自己的**录音路径只有一条：`renderer/lib/voice/whisper-stt.ts` 的
 *    `getUserMedia({ audio: { channelCount: 1 } })` ⇒ Electron 给过来的
 *    `details.mediaTypes` 必然含 `'audio'`。所以那条 `unknown` 兜底对本功能**没有用**，
 *    删掉它不会伤到语音输入（这条是本刀的依据，写下来免得后人以为删错了）。
 */
describe('allowsAudioMedia —— 只认明确的 audio 信号', () => {
  it('mediaTypes 含 audio ⇒ 放行（这是我们自己的录音路径的形状）', () => {
    expect(allowsAudioMedia({ mediaTypes: ['audio'] })).toBe(true);
    expect(allowsAudioMedia({ mediaTypes: ['audio', 'video'] })).toBe(true);
    expect(allowsAudioMedia({ mediaTypes: ['video', 'audio'] })).toBe(true);
  });

  it('mediaTypes 不含 audio ⇒ 拒绝', () => {
    expect(allowsAudioMedia({ mediaTypes: ['video'] })).toBe(false);
    expect(allowsAudioMedia({ mediaTypes: [] })).toBe(false);
  });

  it('没有 mediaTypes 时看 mediaType：只有显式 audio 才放行', () => {
    expect(allowsAudioMedia({ mediaType: 'audio' })).toBe(true);
    expect(allowsAudioMedia({ mediaType: 'video' })).toBe(false);
  });

  it('⭐ `mediaType: "unknown"` ⇒ 拒绝（审计点名的那条；我们不依赖它）', () => {
    expect(allowsAudioMedia({ mediaType: 'unknown' })).toBe(false);
    expect(allowsAudioMedia({ mediaTypes: undefined, mediaType: 'unknown' })).toBe(false);
  });

  it('没有 details ⇒ 拒绝（拿不到依据就不放行）', () => {
    expect(allowsAudioMedia(undefined)).toBe(false);
  });

  // ⚠️ 这几条**不是**在守"形状校验"（那行删了，见模块注释：变异实测分辨不出东西）——
  //    它们只是把"这些入参也走不到放行分支"记下来当行为文档。
  it('入参不是对象 ⇒ 拒绝（原始类型上没有那些字段，自然走不到放行分支）', () => {
    expect(allowsAudioMedia('audio' as unknown)).toBe(false);
    expect(allowsAudioMedia(null)).toBe(false);
    expect(allowsAudioMedia(42)).toBe(false);
  });

  it('⭐ mediaTypes 与 mediaType 都在时，以 mediaTypes 为准', () => {
    // Electron 两种字段并存时 mediaTypes 更精确；这里钉住"不看 mediaType 兜底"
    expect(allowsAudioMedia({ mediaTypes: ['video'], mediaType: 'audio' })).toBe(false);
  });
});
