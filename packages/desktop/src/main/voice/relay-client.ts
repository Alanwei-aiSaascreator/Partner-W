import { isVoiceRequestId } from '@clawwork/shared';
export interface VoiceCapabilities {
  asr: boolean;
  tts: boolean;
  maxRecordingSeconds: number;
  maxSpeechCharacters: number;
  asrMicrosPerSecond?: number;
  ttsMicrosPerCharacter?: number;
}
interface VoiceRelayDependencies {
  baseUrl: () => string;
  relayKey: () => string | null;
  generation: () => number;
  fetch: typeof fetch;
}
const MAX_AUDIO_BYTES = 44 + 16000 * 2 * 60;
export function validateVoiceWav(audio: Buffer): boolean {
  if (audio.length < 46 || audio.length > MAX_AUDIO_BYTES) return false;
  return (
    audio.toString('ascii', 0, 4) === 'RIFF' &&
    audio.readUInt32LE(4) === audio.length - 8 &&
    audio.toString('ascii', 8, 12) === 'WAVE' &&
    audio.toString('ascii', 12, 16) === 'fmt ' &&
    audio.readUInt32LE(16) === 16 &&
    audio.readUInt16LE(20) === 1 &&
    audio.readUInt16LE(22) === 1 &&
    audio.readUInt32LE(24) === 16000 &&
    audio.readUInt32LE(28) === 32000 &&
    audio.readUInt16LE(32) === 2 &&
    audio.readUInt16LE(34) === 16 &&
    audio.toString('ascii', 36, 40) === 'data' &&
    audio.readUInt32LE(40) === audio.length - 44 &&
    (audio.length - 44) % 2 === 0
  );
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}
async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('voice-upstream-error');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('voice-response-too-large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
export function createVoiceRelayClient(deps: VoiceRelayDependencies) {
  async function request(
    path: string,
    signal: AbortSignal,
    body?: Record<string, unknown>,
  ): Promise<{ bytes: Buffer; contentType: string }> {
    const generation = deps.generation();
    const key = deps.relayKey();
    const base = deps.baseUrl().replace(/\/$/, '');
    if (!key) throw new Error('voice-unavailable');
    const controller = new AbortController();
    const isCurrent = () =>
      generation === deps.generation() &&
      key === deps.relayKey() &&
      base === deps.baseUrl().replace(/\/$/, '') &&
      !signal.aborted;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, body ? 65_000 : 10_000);
    const accountWatch = setInterval(() => {
      if (!isCurrent()) abort();
    }, 100);
    try {
      if (!isCurrent()) throw new Error('voice-cancelled');
      const response = await deps.fetch(`${base}/v1/voice/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        redirect: 'error',
      });
      const bytes = await readBounded(response, path === 'speech' ? 8_000_000 : 64_000);
      if (!isCurrent() || controller.signal.aborted) throw new Error('voice-cancelled');
      if (!response.ok) {
        let code = 'voice-upstream-error';
        try {
          const proposed = record(record(JSON.parse(bytes.toString('utf8'))).error).code;
          if (typeof proposed === 'string' && /^voice-[a-z-]+$/.test(proposed)) code = proposed;
        } catch {}
        throw new Error(code);
      }
      return { bytes, contentType: response.headers.get('content-type') ?? '' };
    } catch (error) {
      if (!isCurrent()) throw new Error('voice-cancelled');
      if (controller.signal.aborted) throw new Error('voice-timeout');
      if (error instanceof Error && /^voice-[a-z-]+$/.test(error.message)) throw error;
      throw new Error('voice-upstream-error');
    } finally {
      clearTimeout(timer);
      clearInterval(accountWatch);
      signal.removeEventListener('abort', abort);
    }
  }
  async function capabilities(signal: AbortSignal): Promise<VoiceCapabilities> {
    const generation = deps.generation();
    const { bytes } = await request('capabilities', signal);
    const value = record(JSON.parse(bytes.toString('utf8')));
    if (generation !== deps.generation() || signal.aborted) throw new Error('voice-cancelled');
    const rate = (name: string) =>
      typeof value[name] === 'number' && Number.isSafeInteger(value[name]) && Number(value[name]) >= 0
        ? Number(value[name])
        : undefined;
    const asrRate = rate('asrMicrosPerSecond');
    const ttsRate = rate('ttsMicrosPerCharacter');
    return {
      asr: value.asr === true && asrRate !== undefined,
      tts: value.tts === true && ttsRate !== undefined,
      maxRecordingSeconds: Math.min(60, Number(value.maxRecordingSeconds) || 60),
      maxSpeechCharacters: Math.min(600, Number(value.maxSpeechCharacters) || 600),
      asrMicrosPerSecond: asrRate,
      ttsMicrosPerCharacter: ttsRate,
    };
  }
  return {
    capabilities,
    /**
     * 请求身份由调用方持有（R8-05）：失败恢复必须沿用同一 requestId，relay 才能幂等回放
     * 已存结果或明确拒绝；这里**不再**内部随机生成，坏身份在发任何请求前拒绝。
     */
    async transcribe(audio: Buffer, requestId: string, signal: AbortSignal): Promise<string> {
      if (!isVoiceRequestId(requestId)) throw new Error('voice-invalid-request-id');
      if (!validateVoiceWav(audio)) throw new Error('voice-invalid-audio');
      const generation = deps.generation();
      const caps = await capabilities(signal);
      if (!caps.asr) throw new Error('voice-unavailable');
      if ((audio.length - 44) / 32000 > caps.maxRecordingSeconds) throw new Error('voice-recording-too-long');
      if (signal.aborted || generation !== deps.generation()) throw new Error('voice-cancelled');
      const { bytes } = await request('transcriptions', signal, {
        requestId,
        audio: audio.toString('base64'),
      });
      const transcript = record(JSON.parse(bytes.toString('utf8'))).transcript;
      if (typeof transcript !== 'string' || transcript.length > 16000) throw new Error('voice-upstream-error');
      return transcript;
    },
    async speech(text: string, requestId: string, signal: AbortSignal): Promise<ArrayBuffer> {
      if (!isVoiceRequestId(requestId)) throw new Error('voice-invalid-request-id');
      if (!text.trim() || Array.from(text).length > 600) throw new Error('voice-text-too-long');
      const generation = deps.generation();
      const caps = await capabilities(signal);
      if (!caps.tts) throw new Error('voice-unavailable');
      if (Array.from(text).length > caps.maxSpeechCharacters) throw new Error('voice-text-too-long');
      if (signal.aborted || generation !== deps.generation()) throw new Error('voice-cancelled');
      const { bytes, contentType } = await request('speech', signal, { requestId, text });
      if (
        !/^audio\/wav(?:;|$)/i.test(contentType) ||
        bytes.length < 44 ||
        bytes.toString('ascii', 0, 4) !== 'RIFF' ||
        bytes.toString('ascii', 8, 12) !== 'WAVE'
      )
        throw new Error('voice-invalid-audio');
      return Uint8Array.from(bytes).buffer;
    },
  };
}
