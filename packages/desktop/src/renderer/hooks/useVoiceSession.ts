import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CreateVoiceSessionHandlers,
  VoiceErrorCode,
  VoicePermissionStatus,
  VoiceSession,
} from '@/lib/voice/types';

interface UseVoiceSessionOptions {
  isSupported: boolean;
  requestPermission: () => Promise<VoicePermissionStatus>;
  createSession: (handlers: CreateVoiceSessionHandlers) => VoiceSession | null;
  canStartAfterPermission: (requiresActivePress: boolean) => boolean;
  onSessionStarted: (requiresActivePress: boolean) => void;
  onFinalTranscript: (text: string) => void;
}

interface UseVoiceSessionResult {
  isListening: boolean;
  isTranscribing: boolean;
  interimTranscript: string;
  errorCode: VoiceErrorCode | null;
  beginListening: (requiresActivePress: boolean) => Promise<void>;
  stopListening: () => void;
  cleanup: () => void;
  isListeningActive: () => boolean;
  reportUnsupported: () => void;
}

export function useVoiceSession({
  isSupported,
  requestPermission,
  createSession,
  canStartAfterPermission,
  onSessionStarted,
  onFinalTranscript,
}: UseVoiceSessionOptions): UseVoiceSessionResult {
  const [isListening, setIsListening] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState('');
  const [errorCode, setErrorCode] = useState<VoiceErrorCode | null>(null);

  const sessionRef = useRef<VoiceSession | null>(null);
  const isListeningRef = useRef(false);
  const startRequestIdRef = useRef(0);

  useEffect(() => {
    isListeningRef.current = isListening;
  }, [isListening]);

  const releaseSession = useCallback((shouldStop: boolean) => {
    const session = sessionRef.current;
    sessionRef.current = null;
    if (!session) return;
    if (shouldStop) {
      session.stop();
    } else {
      session.destroy?.();
    }
  }, []);

  const clearListeningState = useCallback(() => {
    setIsListening(false);
    isListeningRef.current = false;
    setInterimTranscript('');
  }, []);

  const reportUnsupported = useCallback(() => {
    setErrorCode('unsupported');
  }, []);

  const stopListening = useCallback(() => {
    const wasListening = isListeningRef.current;
    if (!wasListening) return;
    clearListeningState();
    setIsTranscribing(true);
    sessionRef.current?.stop();
  }, [clearListeningState]);

  const beginListening = useCallback(
    async (requiresActivePress: boolean) => {
      if (!isSupported) {
        reportUnsupported();
        return;
      }

      releaseSession(false);
      setIsTranscribing(false);
      setErrorCode(null);
      const requestId = startRequestIdRef.current + 1;
      startRequestIdRef.current = requestId;

      let permissionStatus: VoicePermissionStatus;
      try {
        permissionStatus = await requestPermission();
      } catch {
        if (startRequestIdRef.current === requestId) setErrorCode('mic-access-failed');
        return;
      }

      if (startRequestIdRef.current !== requestId) return;
      if (!canStartAfterPermission(requiresActivePress)) return;

      if (permissionStatus !== 'granted') {
        setErrorCode(permissionStatus === 'unsupported' ? 'unsupported' : 'permission-denied');
        clearListeningState();
        return;
      }

      const session = createSession({
        onInterimResult: (text) => {
          if (startRequestIdRef.current !== requestId) return;
          setInterimTranscript(text);
        },
        onFinalResult: (text) => {
          if (startRequestIdRef.current !== requestId) return;
          setInterimTranscript('');
          setIsTranscribing(false);
          onFinalTranscript(text);
        },
        onError: (code) => {
          if (startRequestIdRef.current !== requestId) return;
          setErrorCode(code);
          setIsTranscribing(false);
          releaseSession(false);
          clearListeningState();
        },
        onTranscribing: () => {
          if (startRequestIdRef.current !== requestId) return;
          clearListeningState();
          setIsTranscribing(true);
        },
        onEnd: () => {
          if (startRequestIdRef.current !== requestId) return;
          setIsTranscribing(false);
          releaseSession(false);
          clearListeningState();
        },
      });

      if (!session) {
        reportUnsupported();
        clearListeningState();
        return;
      }

      sessionRef.current = session;
      session.start();
      onSessionStarted(requiresActivePress);
      setInterimTranscript('');
      setIsListening(true);
      isListeningRef.current = true;
    },
    [
      canStartAfterPermission,
      clearListeningState,
      createSession,
      isSupported,
      onFinalTranscript,
      onSessionStarted,
      releaseSession,
      reportUnsupported,
      requestPermission,
    ],
  );

  const cleanup = useCallback(() => {
    startRequestIdRef.current += 1;
    releaseSession(false);
    clearListeningState();
    setIsTranscribing(false);
  }, [clearListeningState, releaseSession]);

  const isListeningActive = useCallback(() => isListeningRef.current, []);

  return {
    isListening,
    isTranscribing,
    interimTranscript,
    errorCode,
    beginListening,
    stopListening,
    cleanup,
    isListeningActive,
    reportUnsupported,
  };
}
