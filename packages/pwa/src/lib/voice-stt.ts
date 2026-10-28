import { Capacitor } from '@capacitor/core';
import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import { reportDebugEvent } from './debug';
import { gatewayToken, mobileFetch } from './remote-api';

/**
 * 手机端语音输入（2026-10-22 通用版）。
 *
 * **任何系统都能用**的三通道，按优先级：
 * 1. App + 系统引擎可用 → Capacitor 原生插件（免费、不耗 relay 额度）
 * 2. App + 系统引擎不可用（小米等 ROM 停用语音服务，`available()=false`）
 *    → **getUserMedia 录音 → 桌面端 `/api/mobile/voice/transcribe` 中转 →
 *      relay 商业 ASR**（与桌面端语音同一套服务，只依赖联网，不依赖系统引擎）
 * 3. 浏览器（无原生桥）→ Web Speech API（手机 Chrome 可用）
 *
 * ⚠️ 交互契约：`startVoiceRecording()` 开始听，返回 `{ stop, cancel }`；
 * stop() 停止并返回文字（松手时调用）；cancel() 放弃。stop 幂等。
 */

export interface VoiceCapabilities {
  asr: boolean;
  tts: boolean;
  maxRecordingSeconds: number;
  maxSpeechCharacters: number;
}

interface RecordingHandle {
  stop: () => Promise<string>;
  cancel: () => void;
}

/** 录音选项：onPartial 在录音中收到增量转写（微信式「边说边出字」预览）。 */
export interface VoiceRecordingOptions {
  onPartial?: (text: string) => void;
}

const TARGET_SAMPLE_RATE = 16000;
const MAX_RECORDING_SECONDS = 60;

function webSpeechAvailable(): boolean {
  const w = window as unknown as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

function micAvailable(): boolean {
  return Boolean(typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia);
}

/** 探测语音能力：App 里插件可用或能录音（relay 兜底）即视为可用。 */
export async function voiceCapabilities(): Promise<VoiceCapabilities | null> {
  if (Capacitor.isNativePlatform()) {
    try {
      const { available } = await SpeechRecognition.available();
      return { asr: available || micAvailable(), tts: false, maxRecordingSeconds: 60, maxSpeechCharacters: 0 };
    } catch {
      return { asr: micAvailable(), tts: false, maxRecordingSeconds: 60, maxSpeechCharacters: 0 };
    }
  }
  return webSpeechAvailable()
    ? { asr: true, tts: false, maxRecordingSeconds: 60, maxSpeechCharacters: 0 }
    : null;
}

async function ensurePermission(): Promise<boolean> {
  try {
    const status = await SpeechRecognition.checkPermissions();
    if (status.speechRecognition === 'granted') return true;
    const requested = await SpeechRecognition.requestPermissions();
    return requested.speechRecognition === 'granted';
  } catch {
    return false;
  }
}

/** 通道 1：系统插件。 */
async function startNativeRecording(): Promise<RecordingHandle> {
  const ok = await SpeechRecognition.available();
  if (!ok.available) throw new Error('voice-native-unavailable');
  const granted = await ensurePermission();
  if (!granted) throw new Error('voice-mic-denied');

  let settled = false;
  let resultText = '';

  const started = SpeechRecognition.start({
    language: 'zh-CN',
    maxResults: 1,
    popup: false,
    partialResults: false,
  }).then(({ matches }) => {
    settled = true;
    resultText = Array.isArray(matches) && matches.length > 0 ? matches[0] : '';
    return resultText;
  });

  return {
    stop: async () => {
      try {
        await SpeechRecognition.stop();
      } catch {
        /* 已结束 */
      }
      return started.catch(() => '');
    },
    cancel: () => {
      if (settled) return;
      void SpeechRecognition.stop().catch(() => undefined);
    },
  };
}

/** 通道 3：Web Speech API（浏览器）。 */
function startWebRecording(): RecordingHandle {
  const w = window as unknown as {
    SpeechRecognition?: new () => WebRecognition;
    webkitSpeechRecognition?: new () => WebRecognition;
  };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) throw new Error('voice-unsupported');

  const rec = new Ctor();
  rec.lang = 'zh-CN';
  rec.continuous = false;
  rec.interimResults = false;
  rec.maxAlternatives = 1;

  let settled = false;
  let resultText = '';
  const finished = new Promise<string>((resolve, reject) => {
    rec.onresult = (e) => {
      const first = e.results[0];
      const transcript = first?.[0]?.transcript ?? '';
      if (transcript) resultText = transcript;
    };
    rec.onend = () => {
      settled = true;
      resolve(resultText);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') {
        settled = true;
        resolve('');
        return;
      }
      if (e.error === 'not-allowed') {
        settled = true;
        reject(new Error('voice-mic-denied'));
        return;
      }
      settled = true;
      reject(new Error('voice-failed'));
    };
  });

  rec.start();

  return {
    stop: async () => {
      try {
        rec.stop();
      } catch {
        /* 已结束 */
      }
      return finished.catch(() => '');
    },
    cancel: () => {
      if (settled) return;
      try {
        rec.abort();
      } catch {
        /* 已结束 */
      }
    },
  };
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

/** 从 chunks 数组切出 [from, to) 采样区间（跨 chunk 边界，桌面端 partial-transcript 同语义）。 */
function sliceSamples(chunks: Float32Array[], from: number, to: number): Float32Array {
  const out = new Float32Array(to - from);
  let outPos = 0;
  let acc = 0;
  for (const chunk of chunks) {
    const next = acc + chunk.length;
    if (next <= from) {
      acc = next;
      continue;
    }
    const startIn = Math.max(0, from - acc);
    const endIn = Math.min(chunk.length, to - acc);
    if (startIn < endIn) {
      out.set(chunk.subarray(startIn, endIn), outPos);
      outPos += endIn - startIn;
    }
    acc = next;
    if (acc >= to) break;
  }
  return out.subarray(0, outPos);
}

function encodeWav(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
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
  const writeString = (index: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(index + i, value.charCodeAt(i));
  };
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

/** 通道 2：getUserMedia 录音 → 桌面端中转 → relay ASR（不依赖系统引擎）。 */
async function startRelayRecording(options?: VoiceRecordingOptions): Promise<RecordingHandle> {
  if (!micAvailable()) throw new Error('voice-mic-unavailable');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  let audioContext: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let processor: ScriptProcessorNode | null = null;
  const chunks: Float32Array[] = [];
  let sampleCount = 0;
  let stopped = false;
  let cancelled = false;
  let autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  const requestId = crypto.randomUUID();
  let finishedPromise: Promise<string> | null = null;

  // ── 实时分段预览（微信式「边说边出字」）：录音中每 ~1.5s 把增量音频送转写 ──
  let lastPartialSamples = 0;
  let partialInFlight = false;
  let partialSeq = 0;

  function emitPartial(rate: number): void {
    if (stopped || cancelled || partialInFlight || !options?.onPartial) return;
    const spanFrom = lastPartialSamples;
    const spanTo = sampleCount;
    if (spanTo - spanFrom < rate * 1.5) return;
    const segment = sliceSamples(chunks, spanFrom, spanTo);
    if (segment.length < rate * 0.5) return;
    const wav = encodeWav([segment], rate);
    const seq = ++partialSeq;
    partialInFlight = true;
    lastPartialSamples = spanTo;
    void (async () => {
      try {
        const token = await gatewayToken();
        if (!token) return;
        const res = await mobileFetch('/api/mobile/voice/transcribe', token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ audio: toBase64(wav), requestId: `${requestId.slice(0, -1)}${seq}` }),
        });
        if (res.ok) {
          const body = (await res.json()) as { transcript?: unknown };
          if (typeof body.transcript === 'string' && body.transcript.trim()) {
            options.onPartial?.(body.transcript);
          }
        }
      } catch {
        /* 预览失败静默：松手后的权威整段转写兜底 */
      } finally {
        partialInFlight = false;
      }
    })();
  }

  const finish = (): Promise<string> => {
    if (finishedPromise) return finishedPromise;
    finishedPromise = new Promise<string>((resolve, reject) => {
      void (async () => {
        if (cancelled) {
          cleanup();
          reject(new Error('voice-cancelled'));
          return;
        }
        if (chunks.length === 0) {
          cleanup();
          resolve('');
          return;
        }
        try {
          const rate = audioContext?.sampleRate ?? TARGET_SAMPLE_RATE;
          const wav = encodeWav(chunks, rate);
          const token = await gatewayToken();
          if (!token) throw new Error('voice-unavailable');
          const res = await mobileFetch('/api/mobile/voice/transcribe', token, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ audio: toBase64(wav), requestId }),
          });
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as { error?: string };
            throw new Error(body.error ?? 'voice-upstream-error');
          }
          const body = (await res.json()) as { transcript?: unknown };
          if (typeof body.transcript !== 'string') throw new Error('voice-upstream-error');
          resolve(body.transcript);
        } catch (err) {
          reject(err instanceof Error ? err : new Error('voice-upstream-error'));
        } finally {
          cleanup();
        }
      })();
    });
    return finishedPromise;
  };

  function cleanup(): void {
    if (autoStopTimer) clearTimeout(autoStopTimer);
    try {
      processor?.disconnect();
      source?.disconnect();
    } catch {
      /* 已断开 */
    }
    void audioContext?.close().catch(() => undefined);
    for (const track of stream.getTracks()) track.stop();
  }

  try {
    audioContext = new AudioContext();
    source = audioContext.createMediaStreamSource(stream);
    processor = audioContext.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (stopped || cancelled) return;
      const data = event.inputBuffer.getChannelData(0);
      chunks.push(new Float32Array(data));
      sampleCount += data.length;
      const rate = audioContext?.sampleRate ?? TARGET_SAMPLE_RATE;
      emitPartial(rate);
    };
    source.connect(processor);
    processor.connect(audioContext.destination);
    autoStopTimer = setTimeout(() => {
      stopped = true;
      void finish();
    }, MAX_RECORDING_SECONDS * 1000);
  } catch (err) {
    for (const track of stream.getTracks()) track.stop();
    throw err instanceof Error ? err : new Error('voice-recording-failed');
  }

  return {
    stop: () => {
      if (!stopped) stopped = true;
      return finish();
    },
    cancel: () => {
      cancelled = true;
      cleanup();
    },
  };
}

/** 入口：App 插件优先，系统引擎不可用自动降级云端转写；浏览器走 Web Speech。 */
export async function startVoiceRecording(options?: VoiceRecordingOptions): Promise<RecordingHandle> {
  if (Capacitor.isNativePlatform()) {
    try {
      const ok = await SpeechRecognition.available();
      if (ok.available) {
        return startNativeRecording();
      }
    } catch {
      /* 插件调用异常：走云端降级 */
    }
    reportDebugEvent({
      level: 'info',
      domain: 'renderer',
      event: 'voice.relay.fallback',
      error: { message: 'native speech engine unavailable, falling back to relay ASR' },
    });
    return startRelayRecording(options);
  }
  return startWebRecording();
}

type WebRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
