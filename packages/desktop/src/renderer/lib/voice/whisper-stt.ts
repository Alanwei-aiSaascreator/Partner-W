import { isVoiceTerminalFailure, type CreateVoiceSessionHandlers, type VoiceSession } from '@/lib/voice/types';
import { appendTranscript, partialWindow, shouldEmitPartial, sliceSamples } from '@/lib/voice/partial-transcript';
const TARGET_SAMPLE_RATE = 16000;
const MAX_RECORDING_SECONDS = 60;
/** 分段请求卡住多久算超时（只放行下一段，不 abort —— abort 已 claim 的请求会留下预占）。 */
const PARTIAL_STALL_MS = 12_000;
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
  let transcriptionRequestId: string | null = null;
  let capturedWav: ArrayBuffer | null = null;
  let transcribing = false;
  // ── 实时逐字（2026-10-17）───────────────────────────────────────────────
  // relay 的 ASR 是批式的，没有流式通道 ⇒ 录音过程中按增量分段送转写，拼成预览。
  // 松手后仍用**整段**音频再转一次（权威结果），预览只负责"边说边看见字"。
  let lastPartialSamples = 0;
  let lastPartialAtMs = 0;
  let partialInFlightSince = 0;
  let committedText = '';
  /** 分段的代数：卡住被软重置后可能有两段同时在飞，只有"更新的一段"能改写预览。 */
  let partialSeq = 0;
  let partialAppliedSeq = 0;
  function transcribe(): void {
    if (destroyed || transcribing || !capturedWav || !transcriptionRequestId) return;
    transcribing = true;
    handlers.onTranscribing?.();
    void window.clawwork
      .transcribeAudio(capturedWav, transcriptionRequestId)
      .then((result) => {
        if (destroyed) return;
        if (result.ok && result.transcript) {
          capturedWav = null;
          handlers.onFinalResult(result.transcript);
        } else {
          const code = result.error ?? 'transcription-failed';
          // 确定性终态（空转写 / 音频不合规…）：服务端那一行已经 failed，**同 id 再来必 409**。
          // 换新身份重试＝换一条 claim；音频不变、不重新录音。未知终态（超时/未确认）
          // 则**必须**保持同一身份，靠幂等回放拿到原结果而不是重新生成。
          if (isVoiceTerminalFailure(code)) transcriptionRequestId = crypto.randomUUID();
          handlers.onError(code);
        }
      })
      .catch(() => {
        if (!destroyed) handlers.onError('transcription-failed');
      })
      .finally(() => {
        transcribing = false;
        if (!destroyed) handlers.onEnd();
      });
  }
  /**
   * 发一段"当前进度"转写（预览用）。
   *
   * 只在录音中、且没有请求在飞时发；每次只送**增量**音频（带 0.3s 重叠）⇒ 计费随录音线性增长，
   * 不是把整段反复送（那样是 O(n²) 秒）。失败静默丢弃：预览缺一句不影响松手后的权威转写。
   */
  function emitPartial(): void {
    if (stopped || destroyed) return;
    const now = Date.now();
    if (partialInFlightSince > 0) {
      // 慢请求不冻结实时预览；它回来时仍会被采纳（没有更新的分段），迟到的结果不算错。
      if (now - partialInFlightSince < PARTIAL_STALL_MS) return;
      partialInFlightSince = 0;
    }
    const rate = audioContext?.sampleRate ?? TARGET_SAMPLE_RATE;
    if (
      !shouldEmitPartial({
        sampleCount,
        lastPartialSamples,
        sampleRate: rate,
        nowMs: now,
        lastPartialAtMs,
        inFlight: false,
      })
    ) {
      return;
    }
    // ⚠️ 变量不能叫 `window` —— 那会把全局 `window` 遮住，`window.clawwork` 变成 undefined。
    const span = partialWindow(sampleCount, lastPartialSamples, rate);
    const segment = sliceSamples(chunks, span.from, span.to);
    if (segment.length < rate * 0.5) return;
    const wav = encodeWav([segment], rate);
    const requestId = crypto.randomUUID();
    const startedAt = now;
    const seq = ++partialSeq;
    partialInFlightSince = startedAt;
    lastPartialAtMs = now;
    lastPartialSamples = span.to;
    void window.clawwork
      .transcribeAudio(wav, requestId)
      .then((result) => {
        if (destroyed || stopped) return;
        if (!result.ok || !result.transcript) return;
        // 只接受比已应用更新的一段：卡住后并发的旧请求晚回来时不能把预览倒回去。
        if (seq <= partialAppliedSeq) return;
        partialAppliedSeq = seq;
        committedText = appendTranscript(committedText, result.transcript);
        handlers.onInterimResult(committedText);
      })
      .catch(() => {})
      .finally(() => {
        // 只放行自己这一代的闸：卡住被软重置之后新起的请求不能被更早的收尾提前解锁。
        if (partialInFlightSince === startedAt) partialInFlightSince = 0;
      });
  }
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
    capturedWav = encodeWav(captured, rate);
    transcriptionRequestId ??= crypto.randomUUID();
    transcribe();
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
                // 实时预览：每来一块音频问一次"该发下一段了吗"（判据在 partial-transcript.ts）。
                // 挂在音频回调上而不是定时器上 —— 没有音频就没有可送的东西，也不额外占一条时间线。
                emitPartial();
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
    retry: transcribe,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      stopped = true;
      capturedWav = null;
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
