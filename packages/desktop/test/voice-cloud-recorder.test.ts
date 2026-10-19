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
    (_audio: ArrayBuffer, _requestId: string) =>
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
  it('holds one stable transcription identity per recording and never randomizes it in main', async () => {
    // R8-05：转写身份由本次录音会话（调用方）持有 —— 录音停止时生成一次，
    // 该次转写将来重试沿用同一 id（main/relay-client 不再内部随机）。
    const s = setup();
    s.session.start();
    await Promise.resolve();
    s.feed();
    s.session.stop();
    expect(s.transcribe).toHaveBeenCalledTimes(1);
    const requestId = s.transcribe.mock.calls[0]?.[1];
    expect(typeof requestId).toBe('string');
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it('确定性的终态失败（空转写）重试必须换新的 requestId —— 服务端那行已 failed，同 id 只会 409', async () => {
    const s = setup();
    const bridge = vi.fn(async () => ({ ok: false, error: 'voice-transcription-empty' }));
    window.clawwork.transcribeAudio = bridge;
    s.session.start();
    await Promise.resolve();
    s.feed();
    s.session.stop();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.handlers.onError).toHaveBeenCalledWith('voice-transcription-empty');
    const retryable = s.session as typeof s.session & { retry?: () => void };
    retryable.retry?.();
    await Promise.resolve();
    expect(bridge).toHaveBeenCalledTimes(2);
    // 音频必须逐字相同（不了重新录音），但身份必须换新 —— 否则永远 409。
    expect((bridge.mock.calls[1] as unknown[])[0]).toBe((bridge.mock.calls[0] as unknown[])[0]);
    expect((bridge.mock.calls[1] as unknown[])[1]).not.toBe((bridge.mock.calls[0] as unknown[])[1]);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });
  it('retries a failed captured recording with identical WAV and request ID without reopening the microphone', async () => {
    const s = setup();
    const bridge = vi.fn(async () => ({ ok: false, error: 'voice-settlement-pending' }));
    window.clawwork.transcribeAudio = bridge;
    s.session.start();
    await Promise.resolve();
    s.feed();
    s.session.stop();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.handlers.onError).toHaveBeenCalledWith('voice-settlement-pending');
    const retryable = s.session as typeof s.session & { retry?: () => void };
    retryable.retry?.();
    await Promise.resolve();
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(bridge.mock.calls[1]).toEqual(bridge.mock.calls[0]);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    s.session.destroy?.();
    retryable.retry?.();
    expect(bridge).toHaveBeenCalledTimes(2);
  });
  it('录音中按增量分段回填实时预览，松手后仍发整段权威转写', async () => {
    // 2026-10-17「语音输入实时逐字」：relay 只有批式 ASR ⇒ 客户端每攒够 2.5s 新语音发一段，
    // 结果拼成预览（onInterimResult）；松手后必须再发一次整段音频（onFinalResult 的唯一来源）。
    const s = setup();
    s.session.start();
    await Promise.resolve();
    for (let i = 0; i < 25; i++) s.feed(); // 25 × 4800 @48k = 2.5s
    expect(s.transcribe).toHaveBeenCalledTimes(1);
    s.finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.handlers.onInterimResult).toHaveBeenCalledWith('late');
    expect(s.handlers.onFinalResult).not.toHaveBeenCalled();

    s.session.stop();
    expect(s.transcribe).toHaveBeenCalledTimes(2);
  });

  it('松手时在飞的分段结果被丢弃（不覆盖权威转写）', async () => {
    const s = setup();
    s.session.start();
    await Promise.resolve();
    for (let i = 0; i < 25; i++) s.feed();
    expect(s.transcribe).toHaveBeenCalledTimes(1);
    s.session.stop(); // 分段未回 ⇒ 停止
    s.finish(); // 迟到的分段结果
    await Promise.resolve();
    await Promise.resolve();
    expect(s.handlers.onInterimResult).not.toHaveBeenCalled();
  });
});
