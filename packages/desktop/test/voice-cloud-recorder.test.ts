// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createWhisperSttSession } from '../src/renderer/lib/voice/whisper-stt';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] };
  let processAudio: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null = null;
  const processor = {
    disconnect: vi.fn(),
    connect: vi.fn(),
    set onaudioprocess(fn: typeof processAudio) {
      processAudio = fn;
    },
  };
  class Context {
    sampleRate = 48000;
    destination = {};
    close = vi.fn(async () => {});
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
    createScriptProcessor() {
      return processor;
    }
  }
  vi.stubGlobal('AudioContext', Context);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
  let finish: ((result: { ok: boolean; transcript: string }) => void) | undefined;
  const transcribe = vi.fn(
    (_audio: ArrayBuffer) =>
      new Promise<{ ok: boolean; transcript: string }>((resolve) => {
        finish = resolve;
      }),
  );
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: { transcribeAudio: transcribe, cancelVoice: vi.fn(async () => {}) },
  });
  const handlers = { onFinalResult: vi.fn(), onInterimResult: vi.fn(), onError: vi.fn(), onEnd: vi.fn() };
  const session = createWhisperSttSession(handlers)!;
  return {
    session,
    handlers,
    stop,
    transcribe,
    finish: () => finish?.({ ok: true, transcript: 'late' }),
    feed: () => processAudio?.({ inputBuffer: { getChannelData: () => new Float32Array(4800) } }),
  };
}
describe('cloud recorder lifetime', () => {
  it('discards a transcript delivered after destroy and releases microphone', async () => {
    const s = setup();
    s.session.start();
    await Promise.resolve();
    s.feed();
    s.session.stop();
    s.session.destroy?.();
    s.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.stop).toHaveBeenCalledTimes(1);
    expect(s.handlers.onFinalResult).not.toHaveBeenCalled();
    expect(s.handlers.onEnd).not.toHaveBeenCalled();
  });
  it('resamples browser audio to mono PCM16 16000 WAV', async () => {
    const s = setup();
    s.session.start();
    await Promise.resolve();
    s.feed();
    s.session.stop();
    const wav = s.transcribe.mock.calls[0]?.[0] as ArrayBuffer;
    const view = new DataView(wav);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint32(40, true)).toBe(3200);
    expect(view.getUint16(22, true)).toBe(1);
  });
  it('automatically stops at sixty seconds rather than accumulating forever', async () => {
    vi.useFakeTimers();
    const s = setup();
    s.session.start();
    await Promise.resolve();
    s.feed();
    vi.advanceTimersByTime(60000);
    expect(s.stop).toHaveBeenCalledTimes(1);
    expect(s.transcribe).toHaveBeenCalledTimes(1);
  });
});
