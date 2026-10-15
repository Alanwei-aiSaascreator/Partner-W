export interface VoiceSession {
  start: () => void;
  stop: () => void;
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
