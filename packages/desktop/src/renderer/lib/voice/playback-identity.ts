import { voiceRequestIdFromDigest } from '@clawwork/shared';

export interface VoicePlaybackIdentity {
  /** 商业账号 key（commercial overview.account.userId）：换账号 ⇒ 换身份。 */
  accountKey: string;
  messageKey?: string;
  /** 任务 id。 */
  taskId: string;
  /** 任务主会话 key（消息与 turn 共同的会话身份）。 */
  sessionKey: string;
}

export interface VoiceSentenceIdentity {
  target: VoicePlaybackIdentity;
  /** 整条回答内容的 sha256（消息内容修订）。 */
  answerDigest: string;
  /** 该目标此前完整播完的次数（失败/中断不计数，见文件头注释）。 */
  completedPlaybacks: number;
  /** 分句序号（`splitSpeechText` 的顺序，0 起）。 */
  sentenceIndex: number;
  /** 该分句文本（逐句唯一的最小内容）。 */
  text: string;
}

/** 与 `services/relay/src/voice.ts` 的 `buildVoiceRequest` 固定的 voice 字段一致（绑定字段之一）。 */
const VOICE_NAME = 'Cherry';

/** 播放目标串（v1 格式，字段顺序即契约；改格式必须当成新版本，禁止原地改序）。 */
export function voicePlaybackTargetString(target: VoicePlaybackIdentity, answerDigest: string): string {
  return [
    'partner-w-voice-tts-target-v1',
    `account=${target.accountKey}`,
    `task=${target.taskId}`,
    `session=${target.sessionKey}`,
    `voice=${VOICE_NAME}`,
    `answer=${answerDigest}`,
    ...(target.messageKey ? [`message=${target.messageKey}`] : []),
  ].join('\u0000');
}

/** 逐分句绑定串：目标串 + 完整播完次数 + 分句序号 + 分句文本。 */
export function voiceSentenceBindingString(identity: VoiceSentenceIdentity): string {
  return [
    voicePlaybackTargetString(identity.target, identity.answerDigest),
    `completed=${identity.completedPlaybacks}`,
    `sentence=${identity.sentenceIndex}`,
    `text=${identity.text}`,
  ].join('\u0000');
}

/** 稳定身份：sha256(绑定串) → 折成 UUIDv4 形状（relay 与 main IPC 都用这个形状校验）。 */
export async function deriveVoiceSentenceRequestId(identity: VoiceSentenceIdentity): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(voiceSentenceBindingString(identity)));
  return voiceRequestIdFromDigest(
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''),
  );
}

/** 整条回答的内容修订（sha256 十六进制）：换文本 ⇒ 换修订 ⇒ 换身份。 */
export async function answerRevisionDigest(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function voicePlaybackStorageKey(target: VoicePlaybackIdentity, digest: string): Promise<string> {
  return `partner-w.voice.playback.v1.${await answerRevisionDigest(voicePlaybackTargetString(target, digest))}`;
}

export function loadPlaybackGeneration(key: string): number {
  try {
    const raw = window.localStorage.getItem(key);
    const generation = raw === null ? 0 : Number(raw);
    if (!Number.isSafeInteger(generation) || generation < 0 || (raw !== null && String(generation) !== raw)) {
      throw new Error('voice-recovery-unavailable');
    }
    window.localStorage.setItem(key, String(generation));
    return generation;
  } catch {
    throw new Error('voice-recovery-unavailable');
  }
}

export function completePlaybackGeneration(key: string, generation: number): void {
  if (loadPlaybackGeneration(key) !== generation || !Number.isSafeInteger(generation + 1)) {
    throw new Error('voice-recovery-unavailable');
  }
  try {
    window.localStorage.setItem(key, String(generation + 1));
  } catch {
    throw new Error('voice-recovery-unavailable');
  }
}
