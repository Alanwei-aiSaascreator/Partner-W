import { useCallback, useEffect, useRef, useState } from 'react';
import { createSpeechPlayback } from '@/lib/voice/speech-playback';
export function useVoicePlayback(scopeKey: string) {
  const [phase, setPhase] = useState<'idle' | 'preparing' | 'playing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const context = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const finishPlayback = useRef<(() => void) | null>(null);
  const epoch = useRef(0);
  const running = useRef(false);
  const cancel = useCallback(() => {
    const node = source.current;
    source.current = null;
    if (node) {
      node.onended = null;
      try {
        node.stop();
        node.disconnect();
      } catch {}
    }
    finishPlayback.current?.();
    finishPlayback.current = null;
    const active = context.current;
    context.current = null;
    if (active) void active.close().catch(() => {});
    void window.clawwork.cancelVoice?.();
  }, []);
  const player = useRef<ReturnType<typeof createSpeechPlayback> | null>(null);
  if (!player.current)
    player.current = createSpeechPlayback({
      cancel,
      speak: async (text) => {
        setPhase('preparing');
        const response = await window.clawwork.synthesizeSpeech(text);
        if (!response.ok || !response.result) throw new Error(response.error ?? 'voice-playback-failed');
        return response.result;
      },
      play: async (audio) => {
        const active = context.current;
        if (!active) return;
        const decoded = await active.decodeAudioData(audio.slice(0));
        if (context.current !== active) return;
        const node = active.createBufferSource();
        node.buffer = decoded;
        node.connect(active.destination);
        source.current = node;
        setPhase('playing');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            try {
              node.stop();
            } catch {}
            reject(new Error('voice-timeout'));
          }, 120_000);
          const finish = () => {
            clearTimeout(timer);
            resolve();
          };
          finishPlayback.current = finish;
          node.onended = finish;
          try {
            node.start();
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
        if (source.current === node) {
          source.current = null;
          node.disconnect();
          finishPlayback.current = null;
        }
      },
    });
  const stop = useCallback(() => {
    running.current = false;
    epoch.current++;
    player.current?.stop();
    setPhase('idle');
  }, []);
  const start = useCallback(
    async (text: string) => {
      if (running.current) return;
      stop();
      running.current = true;
      const current = epoch.current;
      setError(null);
      try {
        // Create/resume in the user gesture, before waiting for synthesis.
        const active = new AudioContext();
        context.current = active;
        await active.resume();
        if (current !== epoch.current) return;
        // The queue's initial stop invalidates old requests; keep this fresh audio context.
        context.current = null;
        const pending = player.current!.start(text);
        context.current = active;
        await pending;
      } catch (failure) {
        if (current === epoch.current) setError(failure instanceof Error ? failure.message : 'voice-playback-failed');
      } finally {
        if (current === epoch.current) {
          running.current = false;
          cancel();
          setPhase('idle');
        }
      }
    },
    [cancel, stop],
  );
  useEffect(() => {
    stop();
    return stop;
  }, [scopeKey, stop]);
  return { phase, error, start, stop };
}
