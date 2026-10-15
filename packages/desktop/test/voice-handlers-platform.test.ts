import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
  },
  session: { defaultSession: null },
  shell: { openExternal: vi.fn(async () => {}) },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => 'not-determined'), askForMediaAccess: vi.fn() },
}));
vi.mock('../src/main/commercial/relay-config', () => ({ activeRelayBaseUrl: () => 'https://relay.test' }));
vi.mock('../src/main/commercial/relay-key', () => ({ getActiveRelayKey: () => 'private-key' }));
vi.mock('../src/main/commercial/license-generation', () => ({ getLicenseGeneration: () => 1 }));
vi.mock('../src/main/security/navigation-guard', () => ({ isAllowedAppNavigation: vi.fn(() => true) }));
import { registerVoiceHandlers } from '../src/main/ipc/voice-handlers';
import { isAllowedAppNavigation } from '../src/main/security/navigation-guard';
function handler(channel: string) {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(channel);
  return fn;
}
function event(id = 1) {
  const frame = { url: 'file:///app/index.html' };
  return { sender: { id, mainFrame: frame, once: vi.fn() }, senderFrame: frame };
}
function capabilities(asr = true, tts = true) {
  return new Response(
    JSON.stringify({
      asr,
      tts,
      maxRecordingSeconds: 60,
      maxSpeechCharacters: 600,
      asrMicrosPerSecond: 40000,
      ttsMicrosPerCharacter: 12000,
    }),
  );
}
describe('voice IPC platform contract', () => {
  beforeEach(() => {
    handlers.clear();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => capabilities()),
    );
    vi.mocked(isAllowedAppNavigation).mockReturnValue(true);
    registerVoiceHandlers();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('enables Windows through the actual relay capability instead of POSIX dependencies', async () => {
    expect(await handler('voice:check-whisper')(event())).toEqual({
      available: true,
      binaryPath: null,
      modelPath: null,
    });
  });
  it('remains unavailable when the server has no ASR capability', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(capabilities(false));
    expect(await handler('voice:check-whisper')(event())).toEqual({
      available: false,
      binaryPath: null,
      modelPath: null,
    });
  });
  it('rejects an untrusted renderer before any network request', async () => {
    vi.mocked(isAllowedAppNavigation).mockReturnValue(false);
    expect(await handler('voice:capabilities')(event())).toEqual({ ok: false, error: 'voice-untrusted-sender' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects child frames even on an allowed app origin', async () => {
    const e = event();
    e.senderFrame = { url: e.senderFrame.url };
    expect(await handler('voice:capabilities')(e)).toEqual({ ok: false, error: 'voice-untrusted-sender' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses device acquisition for undetermined Windows permission', async () => {
    expect(await handler('voice:request-microphone-permission')(event())).toEqual({ status: 'granted' });
  });
  it('bounds and validates audio/text input before HTTP', async () => {
    expect(await handler('voice:transcribe')(event(), { audio: new ArrayBuffer(2_000_000) })).toEqual({
      ok: false,
      error: 'voice-invalid-audio',
    });
    expect(await handler('voice:speech')(event(), { text: '字'.repeat(601) })).toEqual({
      ok: false,
      error: 'voice-text-too-long',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('cancels pending requests and ignores a late reply', async () => {
    let finish: ((response: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const e = event(98);
    const pending = handler('voice:capabilities')(e);
    await handler('voice:cancel')(e);
    finish?.(capabilities());
    expect(await pending).toEqual({ ok: false, error: 'voice-cancelled' });
  });
  it('does not expose Homebrew instructions in any voice prompt', () => {
    const dir = join(__dirname, '../src/renderer/i18n/locales');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const voice =
        (JSON.parse(readFileSync(join(dir, file), 'utf8')) as { voiceInput?: Record<string, string> }).voiceInput ?? {};
      // `unsupportedPlatform` 已随 Windows 云端语音链删除（2026-10-15 i18n 门禁收口）——
      // 列表去掉了它，其余仍逐个断言无 brew 指引。
      for (const key of ['introStepBeta', 'unsupported', 'unsupportedTooltip']) expect(voice[key]).not.toMatch(/brew/i);
    }
  });
});
