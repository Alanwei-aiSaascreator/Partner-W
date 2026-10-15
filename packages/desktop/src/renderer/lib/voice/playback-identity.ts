import { voiceRequestIdFromDigest } from '@clawwork/shared';

/**
 * 朗读（TTS）请求身份派生（R8-05 / VV-1，2026-10-15 终审返工）。
 *
 * 缺陷背景：`main/voice/relay-client.ts` 以前在每次请求里 `randomUUID()` 现生成身份。
 * "供应商已成功 → settle COMMIT → ACK 丢失 → relay 返回 voice-settlement-pending" 之后，
 * 用户从失败状态再点一次朗读，会拿到**新身份** ⇒ 绕开 relay 的结果缓存（120s）与
 * `relay_voice_requests(license_id, request_id)` 幂等主键 ⇒ 供应商被再调用一次、再扣一次费。
 *
 * 现在的口径（终审给定）：
 *  - 身份绑"该次播放目标"：**账号 key + 任务 id + 会话 key + 音色 Cherry + 回答内容修订
 *    （整条回答的 sha256）+ 分句序号 + 该分句文本**；
 *  - 跨"失败重试"稳定（同一逻辑操作沿用同一身份）；
 *  - 显式换目标 / 换账号 / 文本变更 ⇒ 身份必变（旧账号、旧消息的结果绝不复用）；
 *  - **不能只按文本去重**：账号/任务/会话/音色都在绑定串里，文本只是其中一项。
 *
 * 为什么身份里带完整回答的 sha256（而不是只有分句文本）：消息内容修订是绑定字段之一，
 * 回答任意一段被改写都算"换了一条回答"；分句序号 + 分句文本再保证逐句唯一。
 *
 * 为什么身份**不**含消息行 id / turn id：投递期它们并不稳定（网关历史消息在同步时
 * 重新随机分配 id、turn 提升成消息时 id 换源）。用了它们，"失败后重试沿用同一身份"
 * 反而会在同步/重开时被破坏 —— 目标语义由 任务 + 会话 + 内容修订 表达即可。
 *
 * `completedPlaybacks`：该目标**完整播完**的次数。失败/中断不计数（下一次点击 = 结果未知的
 * 恢复，沿用同一身份）；完整播完后再点朗读 = 用户明确发起的新合成，计数前进一代 ⇒ 新身份。
 */

export interface VoicePlaybackIdentity {
  /** 商业账号 key（commercial overview.account.userId）：换账号 ⇒ 换身份。 */
  accountKey: string;
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
    'rongying-voice-tts-target-v1',
    `account=${target.accountKey}`,
    `task=${target.taskId}`,
    `session=${target.sessionKey}`,
    `voice=${VOICE_NAME}`,
    `answer=${answerDigest}`,
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
