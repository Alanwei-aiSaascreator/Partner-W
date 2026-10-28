export interface VoiceSession {
  start: () => void;
  stop: () => void;
  retry?: () => void;
  destroy?: () => void;
}

export interface CreateVoiceSessionHandlers {
  onInterimResult: (text: string) => void;
  onFinalResult: (text: string) => void;
  onError: (code: VoiceErrorCode) => void;
  onEnd: () => void;
  onTranscribing?: () => void;
}

export type VoicePermissionStatus = 'granted' | 'not-determined' | 'denied' | 'unsupported';

export type VoiceErrorCode =
  | 'permission-denied'
  | 'unsupported'
  | 'mic-access-failed'
  | 'transcription-failed'
  | (string & {});

export function isVoiceRecoveryError(code: string): boolean {
  return [
    'voice-settlement-pending',
    'voice-request-pending',
    'voice-request-unconfirmed',
    'voice-timeout',
    'voice-upstream-error',
    'voice-response-too-large',
    'voice-usage-invalid',
    'voice-transcription-empty',
    'transcription-failed',
    // 忙 = 等一等（服务端已轮询 4 秒才回 429），本次**没有** claim 任何行 ⇒ 原身份可重试。
    'voice-busy',
  ].includes(code);
}

/**
 * **确定性终态**：这次请求注定拿不到结果，服务端也已把预占标记为 failed。
 *
 * ⚠️ 这类错误**必须换新的 requestId 才能重试**：relay 的请求行已经存在（state=failed），
 *    同 id 再 claim 只会得到 `claimed:false` ⇒ 409 `voice-request-pending` ⇒
 *    用户看到"可重试"却怎么点都失败（2026-10-17 审查发现）。
 *    与"未知终态"（超时 / 未确认 / 结算未落）严格相反 —— 那些**必须**沿用同一身份，
 *    否则等于让服务端重新生成、可能多扣一次。
 */
export function isVoiceTerminalFailure(code: string): boolean {
  return [
    'voice-transcription-empty',
    'voice-usage-invalid',
    'voice-synthesis-invalid',
    'voice-audio-unavailable',
    'voice-audio-invalid',
    'voice-audio-limit',
    'voice-invalid-audio',
    'voice-recording-too-long',
    'voice-text-too-long',
  ].includes(code);
}
