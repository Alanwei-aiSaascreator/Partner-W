import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
  },
  session: { defaultSession: null },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(),
    askForMediaAccess: vi.fn(),
  },
}));

import { registerVoiceHandlers } from '../src/main/ipc/voice-handlers';

function registeredHandler(channel: string): (...args: unknown[]) => unknown {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler;
}

describe('voice IPC platform contract', () => {
  beforeEach(() => {
    handlers.clear();
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    registerVoiceHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('disables Whisper on Windows instead of probing POSIX-only dependencies', () => {
    const reply = registeredHandler('voice:check-whisper')({}) as {
      available: boolean;
      binaryPath: string | null;
      modelPath: string | null;
      unsupportedPlatform?: boolean;
      error?: string;
    };

    expect(reply).toEqual({
      available: false,
      binaryPath: null,
      modelPath: null,
      unsupportedPlatform: true,
      error: 'voice input is not supported on Windows yet',
    });
  });

  it('does not expose Homebrew instructions in any voice prompt', () => {
    const localeDir = join(__dirname, '../src/renderer/i18n/locales');
    const localeFiles = readdirSync(localeDir).filter((file) => file.endsWith('.json'));

    for (const file of localeFiles) {
      const locale = JSON.parse(readFileSync(join(localeDir, file), 'utf8')) as {
        voiceInput?: Record<string, string>;
      };
      const voiceInput = locale.voiceInput ?? {};

      expect(voiceInput.unsupportedPlatform, `${file} needs Windows-specific disabled copy`).toBeTruthy();
      for (const key of ['introStepBeta', 'unsupported', 'unsupportedTooltip', 'unsupportedPlatform'] as const) {
        expect(voiceInput[key], `${file} ${key} must not mention Homebrew`).not.toMatch(/brew/i);
      }
    }
  });
});
