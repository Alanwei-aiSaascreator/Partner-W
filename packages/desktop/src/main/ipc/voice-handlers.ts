import { ipcMain, session, shell, systemPreferences, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { isVoiceRequestId } from '@clawwork/shared';
import { allowsAudioMedia } from '../voice/media-permission';
import { createVoiceRelayClient } from '../voice/relay-client';
import { activeRelayBaseUrl } from '../commercial/relay-config';
import { getActiveRelayKey } from '../commercial/relay-key';
import { getLicenseGeneration } from '../commercial/license-generation';
import { isAllowedAppNavigation } from '../security/navigation-guard';

type VoicePermissionStatus = 'granted' | 'not-determined' | 'denied' | 'unsupported';
const requests = new Map<number, Set<AbortController>>();
export function isTrustedVoiceSender(event: IpcMainInvokeEvent): boolean {
  return Boolean(
    event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    isAllowedAppNavigation(event.senderFrame.url, {
      devOrigin: process.env['ELECTRON_RENDERER_URL'] ?? null,
      appRendererDir: join(import.meta.dirname, '../renderer'),
    }),
  );
}
function cancelRequests(senderId: number): void {
  for (const controller of requests.get(senderId) ?? []) controller.abort();
  requests.get(senderId)?.clear();
}
function safeError(error: unknown): string {
  return error instanceof Error && /^voice-[a-z-]+$/.test(error.message) ? error.message : 'voice-upstream-error';
}
export function registerVoiceHandlers(): void {
  const client = createVoiceRelayClient({
    baseUrl: activeRelayBaseUrl,
    relayKey: getActiveRelayKey,
    generation: getLicenseGeneration,
    fetch: (...args) => fetch(...args),
  });
  async function run<T>(
    event: IpcMainInvokeEvent,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
    if (!isTrustedVoiceSender(event)) return { ok: false, error: 'voice-untrusted-sender' };
    const controller = new AbortController();
    const senderId = event.sender.id;
    let active = requests.get(senderId);
    if (!active) {
      active = new Set();
      requests.set(senderId, active);
      event.sender.once('destroyed', () => {
        cancelRequests(senderId);
        requests.delete(senderId);
      });
    }
    active.add(controller);
    try {
      const result = await operation(controller.signal);
      if (controller.signal.aborted) return { ok: false, error: 'voice-cancelled' };
      return { ok: true, result };
    } catch (error) {
      return { ok: false, error: safeError(error) };
    } finally {
      active.delete(controller);
    }
  }
  ipcMain.handle('voice:get-microphone-permission', (event) => ({
    status: isTrustedVoiceSender(event) ? getMicrophonePermissionStatus() : 'denied',
  }));
  ipcMain.handle('voice:request-microphone-permission', async (event) => ({
    status: isTrustedVoiceSender(event) ? await requestMicrophonePermission() : 'denied',
  }));
  ipcMain.handle('voice:capabilities', (event) => run(event, (signal) => client.capabilities(signal)));
  ipcMain.handle('voice:check-whisper', async (event) => {
    const result = await run(event, (signal) => client.capabilities(signal));
    return {
      available: result.ok && result.result.asr,
      binaryPath: null,
      modelPath: null,
      ...(!result.ok ? { error: result.error } : {}),
    };
  });
  ipcMain.handle('voice:transcribe', async (event, args: unknown) => {
    const audio = typeof args === 'object' && args !== null && 'audio' in args ? args.audio : null;
    const requestId = typeof args === 'object' && args !== null && 'requestId' in args ? args.requestId : null;
    if (!(audio instanceof ArrayBuffer) || audio.byteLength > 44 + 16000 * 2 * 60)
      return { ok: false, error: 'voice-invalid-audio' };
    // R8-05：身份由 renderer 的逻辑录音操作持有并透传；这里只校验形状，不改写、不重发。
    if (!isVoiceRequestId(requestId)) return { ok: false, error: 'voice-invalid-request-id' };
    const result = await run(event, (signal) => client.transcribe(Buffer.from(audio), requestId, signal));
    return result.ok ? { ok: true, transcript: result.result } : result;
  });
  ipcMain.handle('voice:speech', async (event, args: unknown) => {
    const text = typeof args === 'object' && args !== null && 'text' in args ? args.text : null;
    const requestId = typeof args === 'object' && args !== null && 'requestId' in args ? args.requestId : null;
    if (typeof text !== 'string' || Array.from(text).length > 600) return { ok: false, error: 'voice-text-too-long' };
    // 同上：坏身份拒绝在发任何请求之前（失败重试沿用同一身份是幂等恢复的前提）。
    if (!isVoiceRequestId(requestId)) return { ok: false, error: 'voice-invalid-request-id' };
    return run(event, (signal) => client.speech(text, requestId, signal));
  });
  ipcMain.handle('voice:cancel', (event) => {
    if (!isTrustedVoiceSender(event)) return { ok: false };
    cancelRequests(event.sender.id);
    return { ok: true };
  });
  ipcMain.handle('voice:open-microphone-settings', async (event) => {
    if (!isTrustedVoiceSender(event)) return { ok: false };
    const url =
      process.platform === 'win32'
        ? 'ms-settings:privacy-microphone'
        : process.platform === 'darwin'
          ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'
          : null;
    if (!url) return { ok: false };
    try {
      await shell.openExternal(url);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });
}
export function configureVoicePermissionHandlers(): void {
  const defaultSession = session.defaultSession;
  if (!defaultSession) return;
  defaultSession.setPermissionCheckHandler(
    (_webContents, permission, _requestingOrigin, details) => permission === 'media' && allowsAudioMedia(details),
  );
  defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) =>
    callback(permission === 'media' && allowsAudioMedia(details)),
  );
}
function getMicrophonePermissionStatus(): VoicePermissionStatus {
  if (process.platform === 'darwin' || process.platform === 'win32')
    return normalizeMediaAccessStatus(systemPreferences.getMediaAccessStatus('microphone'));
  return 'granted';
}
async function requestMicrophonePermission(): Promise<VoicePermissionStatus> {
  if (process.platform === 'darwin') {
    const current = systemPreferences.getMediaAccessStatus('microphone');
    if (current === 'granted') return 'granted';
    if (current === 'denied' || current === 'restricted') return 'denied';
    return (await systemPreferences.askForMediaAccess('microphone')) ? 'granted' : 'denied';
  }
  // On Windows Chromium's getUserMedia makes the device request. Do not reject an undetermined OS status early.
  const status = getMicrophonePermissionStatus();
  return status === 'not-determined' ? 'granted' : status;
}
function normalizeMediaAccessStatus(status: string): VoicePermissionStatus {
  if (status === 'granted') return 'granted';
  if (status === 'not-determined') return 'not-determined';
  return 'denied';
}
