import type { CreateVoiceSessionHandlers, VoiceSession } from '@/lib/voice/types';
const TARGET_SAMPLE_RATE = 16000;
const MAX_RECORDING_SECONDS = 60;
export function createWhisperSttSession(handlers: CreateVoiceSessionHandlers): VoiceSession | null {
  if (!navigator.mediaDevices?.getUserMedia) return null;
  let stream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  let chunks: Float32Array[] = [];
  let stopped = false;
  let destroyed = false;
  let sampleCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  function cleanup(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (processor) {
      processor.disconnect();
      processor.onaudioprocess = null;
      processor = null;
    }
    if (source) {
      source.disconnect();
      source = null;
    }
    if (audioContext) {
      void audioContext.close().catch(() => {});
      audioContext = null;
    }
    if (stream) {
      stream.getTracks().forEach((track) => {
        track.onended = null;
        track.stop();
      });
      stream = null;
    }
    chunks = [];
  }
  function stop(): void {
    if (stopped || destroyed) return;
    stopped = true;
    const captured = chunks;
    const rate = audioContext?.sampleRate ?? TARGET_SAMPLE_RATE;
    cleanup();
    handlers.onTranscribing?.();
    if (captured.length === 0) {
      handlers.onEnd();
      return;
    }
    const wav = encodeWav(captured, rate);
    void window.clawwork
      .transcribeAudio(wav)
      .then((result) => {
        if (destroyed) return;
        if (result.ok && result.transcript) handlers.onFinalResult(result.transcript);
        else handlers.onError(result.error ?? 'transcription-failed');
      })
      .catch(() => {
        if (!destroyed) handlers.onError('transcription-failed');
      })
      .finally(() => {
        if (!destroyed) handlers.onEnd();
      });
  }
  return {
    start: () => {
      if (destroyed || stream || stopped) return;
      void navigator.mediaDevices
        .getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } })
        .then((mediaStream) => {
          if (stopped || destroyed) {
            mediaStream.getTracks().forEach((track) => track.stop());
            return;
          }
          stream = mediaStream;
          stream.getTracks().forEach((track) => {
            track.onended = () => {
              if (stopped || destroyed) return;
              stopped = true;
              cleanup();
              handlers.onError('microphone-not-found');
              handlers.onEnd();
            };
          });
          try {
            audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
            source = audioContext.createMediaStreamSource(stream);
            processor = audioContext.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (event) => {
              if (stopped || destroyed) return;
              const data = event.inputBuffer.getChannelData(0);
              const remaining = Math.max(
                0,
                Math.floor((audioContext?.sampleRate ?? TARGET_SAMPLE_RATE) * MAX_RECORDING_SECONDS) - sampleCount,
              );
              const captured = new Float32Array(data.subarray(0, remaining));
              if (captured.length > 0) {
                chunks.push(captured);
                sampleCount += captured.length;
              }
              if (remaining <= data.length) stop();
            };
            source.connect(processor);
            processor.connect(audioContext.destination);
            timer = setTimeout(stop, MAX_RECORDING_SECONDS * 1000);
          } catch {
            cleanup();
            handlers.onError('mic-access-failed');
            handlers.onEnd();
          }
        })
        .catch((error) => {
          if (destroyed || stopped) return;
          cleanup();
          const name = error instanceof Error ? error.name : '';
          handlers.onError(
            name === 'NotAllowedError' || name === 'SecurityError'
              ? 'permission-denied'
              : name === 'NotFoundError'
                ? 'microphone-not-found'
                : 'mic-access-failed',
          );
          handlers.onEnd();
        });
    },
    stop,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      stopped = true;
      cleanup();
      void window.clawwork.cancelVoice?.();
    },
  };
}
export function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
  }
  const count = Math.floor((length * TARGET_SAMPLE_RATE) / sampleRate);
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  function writeString(index: number, value: string): void {
    for (let i = 0; i < value.length; i++) view.setUint8(index + i, value.charCodeAt(i));
  }
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + count * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, TARGET_SAMPLE_RATE, true);
  view.setUint32(28, TARGET_SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, count * 2, true);
  // Average the source window when downsampling, rather than mislabelling browser-rate samples as 16 kHz.
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * sampleRate) / TARGET_SAMPLE_RATE);
    const end = Math.min(length, Math.max(start + 1, Math.floor(((i + 1) * sampleRate) / TARGET_SAMPLE_RATE)));
    let sum = 0;
    for (let j = start; j < end; j++) sum += samples[j];
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true);
  }
  return buffer;
}
