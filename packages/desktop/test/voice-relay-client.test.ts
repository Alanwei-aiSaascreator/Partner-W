import { describe, expect, it, vi } from 'vitest';
import { createVoiceRelayClient, validateVoiceWav } from '../src/main/voice/relay-client';
/**
 * R8-05：请求身份由调用方（renderer 朗读/录音操作）持有并透传 —— client 不再内部随机。
 * 这里用固定身份断言"原样使用"；随机/派生在 renderer 的 playback-identity 与 useVoicePlayback 测。
 */
const FIXED = '00112233-4455-4677-8899-aabbccddeeff';
function wav() {
  const b = Buffer.alloc(44 + 3200);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(3200, 40);
  return b;
}
function setup() {
  let generation = 1;
  const fetcher = vi.fn<typeof fetch>();
  const client = createVoiceRelayClient({
    baseUrl: () => 'https://relay.test',
    relayKey: () => 'private-key',
    generation: () => generation,
    fetch: fetcher,
  });
  return {
    client,
    fetcher,
    switchAccount: () => {
      generation++;
    },
  };
}
function caps() {
  return new Response(
    JSON.stringify({
      asr: true,
      tts: true,
      maxRecordingSeconds: 60,
      maxSpeechCharacters: 600,
      asrMicrosPerSecond: 40000,
      ttsMicrosPerCharacter: 12000,
    }),
  );
}
describe('voice relay contract', () => {
  it('requires real prices along with capability so fees cannot be hidden', async () => {
    const s = setup();
    s.fetcher.mockResolvedValue(
      new Response(JSON.stringify({ asr: true, tts: true, maxRecordingSeconds: 60, maxSpeechCharacters: 600 })),
    );
    expect(await s.client.capabilities(new AbortController().signal)).toEqual(
      expect.objectContaining({ asr: false, tts: false }),
    );
  });
  it('discards an ASR response that arrives after the commercial account changes', async () => {
    const s = setup();
    s.fetcher.mockResolvedValueOnce(caps()).mockImplementationOnce(async () => {
      s.switchAccount();
      return new Response(JSON.stringify({ transcript: 'wrong account' }));
    });
    await expect(s.client.transcribe(wav(), FIXED, new AbortController().signal)).rejects.toThrow('voice-cancelled');
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry an upstream failure or expose upstream error messages', async () => {
    const s = setup();
    s.fetcher.mockResolvedValueOnce(caps()).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'upstream', message: 'sensitive-provider-data' } }), {
        status: 502,
      }),
    );
    await expect(s.client.transcribe(wav(), FIXED, new AbortController().signal)).rejects.toThrow(
      'voice-upstream-error',
    );
    expect(s.fetcher).toHaveBeenCalledTimes(2);
  });
  it('returns valid WAV bytes for TTS and sends the Unicode text intact', async () => {
    const s = setup();
    s.fetcher
      .mockResolvedValueOnce(caps())
      .mockResolvedValueOnce(new Response(wav(), { headers: { 'content-type': 'audio/wav' } }));
    const result = await s.client.speech('😀中文', FIXED, new AbortController().signal);
    expect(Buffer.from(result)).toEqual(wav());
    const [url, options] = s.fetcher.mock.calls[1];
    expect(url).toBe('https://relay.test/v1/voice/speech');
    const body = JSON.parse(String(options?.body));
    expect(body.text).toBe('😀中文');
    expect(body.requestId).toBe(FIXED);
  });
  it('uses the caller-owned identity verbatim instead of generating one', async () => {
    const s = setup();
    s.fetcher.mockResolvedValueOnce(caps()).mockResolvedValueOnce(new Response(JSON.stringify({ transcript: '中文' })));
    expect(await s.client.transcribe(wav(), FIXED, new AbortController().signal)).toBe('中文');
    expect(s.fetcher).toHaveBeenCalledTimes(2);
    const [url, opts] = s.fetcher.mock.calls[1];
    expect(url).toBe('https://relay.test/v1/voice/transcriptions');
    expect(opts?.headers).toEqual(expect.objectContaining({ Authorization: 'Bearer private-key' }));
    expect(JSON.parse(String(opts?.body)).requestId).toBe(FIXED);
  });
  it('rejects a malformed or missing request identity before any HTTP', async () => {
    const s = setup();
    const signal = new AbortController().signal;
    await expect(s.client.speech('你好', 'not-a-uuid', signal)).rejects.toThrow('voice-invalid-request-id');
    await expect(s.client.speech('你好', undefined as unknown as string, signal)).rejects.toThrow(
      'voice-invalid-request-id',
    );
    await expect(s.client.transcribe(wav(), 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa', signal)).rejects.toThrow(
      'voice-invalid-request-id',
    );
    expect(s.fetcher).not.toHaveBeenCalled();
  });
  it('validates PCM16 mono16000 and duration before sending', () => {
    expect(validateVoiceWav(wav())).toBe(true);
    const invalid = wav();
    invalid.writeUInt32LE(48000, 24);
    expect(validateVoiceWav(invalid)).toBe(false);
    expect(validateVoiceWav(Buffer.alloc(44 + 16000 * 2 * 61))).toBe(false);
  });
  it('fails closed when no server capability and makes no paid request', async () => {
    const s = setup();
    s.fetcher.mockResolvedValue(
      new Response(
        JSON.stringify({
          asr: false,
          tts: false,
          maxRecordingSeconds: 60,
          maxSpeechCharacters: 600,
          asrMicrosPerSecond: 100,
          ttsMicrosPerCharacter: 200,
        }),
      ),
    );
    await expect(s.client.transcribe(wav(), FIXED, new AbortController().signal)).rejects.toThrow('voice-unavailable');
    expect(s.fetcher).toHaveBeenCalledTimes(1);
  });
  it('discards late replies after account switch', async () => {
    const s = setup();
    s.fetcher.mockImplementation(async () => {
      s.switchAccount();
      return new Response(
        JSON.stringify({
          asr: true,
          tts: true,
          maxRecordingSeconds: 60,
          maxSpeechCharacters: 600,
          asrMicrosPerSecond: 100,
          ttsMicrosPerCharacter: 200,
        }),
      );
    });
    await expect(s.client.capabilities(new AbortController().signal)).rejects.toThrow('voice-cancelled');
  });
  it('rejects speech over six hundred unicode characters before HTTP', async () => {
    const s = setup();
    await expect(s.client.speech('😀'.repeat(601), FIXED, new AbortController().signal)).rejects.toThrow(
      'voice-text-too-long',
    );
    expect(s.fetcher).not.toHaveBeenCalled();
  });
});
