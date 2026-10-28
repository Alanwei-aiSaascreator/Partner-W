import { BrowserWindow } from 'electron';
import { captureArtifactDeliveryOperation } from '../artifact/delivery-operation.js';
import { activeRelayBaseUrl } from '../commercial/relay-config.js';
import { readLicenseStatus } from '../commercial/license.js';
import { getLicenseGeneration } from '../commercial/license-generation.js';
import { getActiveRelayKey } from '../commercial/relay-key.js';
import { createImagegenRelayClient } from './client.js';
import { extractImagegenBlocks } from './request.js';
import { generateImagesFromMessage } from './generate.js';
const active = new Set<string>();
export interface StartImagegenJobsInput {
  workspacePath: string;
  taskId: string;
  sessionKey: string;
  messageId: string;
  runId?: string;
  content: string;
  sourceCurrent?: () => boolean;
  retainSource?: () => () => void;
}
export function startImagegenJobs(input: StartImagegenJobsInput): void {
  const parsed = extractImagegenBlocks(input.content);
  if (!parsed.requests.length && !parsed.failures.length) return;
  const key = `${input.workspacePath}:${input.taskId}:${input.messageId}`;
  if (active.has(key)) return;
  active.add(key);
  const releaseSource = input.retainSource?.();
  const sourceCurrent = () => input.sourceCurrent?.() ?? true;
  const operation = captureArtifactDeliveryOperation(input);
  const broadcast = (channel: string, value: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(channel, value);
  };
  void (async () => {
    try {
      if (!sourceCurrent()) {
        operation.finish('canceled');
        return;
      }
      operation.phase('generating-image');
      const generation = getLicenseGeneration(),
        relayKey = getActiveRelayKey();
      const status = await readLicenseStatus();
      const current = () =>
        sourceCurrent() && getLicenseGeneration() === generation && getActiveRelayKey() === relayKey;
      if (!current()) {
        operation.finish('canceled');
        return;
      }
      if (!relayKey || !status.ok || !status.result?.activated || !status.result.licenseId) {
        operation.finish('failed');
        broadcast('imagegen:failed', [{ code: 'imagegen-unavailable' }]);
        return;
      }
      const client = createImagegenRelayClient({ baseUrl: activeRelayBaseUrl(), relayKey });
      const result = await generateImagesFromMessage({
        ...input,
        client,
        authScope: status.result.licenseId,
        authCurrent: current,
        onActivity: operation.phase,
      });
      if (!current()) {
        operation.finish('canceled');
        return;
      }
      for (const artifact of result.saved) broadcast('artifact:saved', artifact);
      if (result.failed.length) broadcast('imagegen:failed', result.failed);
      const unconfirmed = result.failed.some(
        (failure) => failure.code === 'imagegen-request-unconfirmed' || failure.code === 'imagegen-result-unconfirmed',
      );
      if (result.failed.length) operation.finish(result.saved.length || unconfirmed ? 'needs-review' : 'failed');
      else operation.finish('succeeded', result.saved[0]?.id);
    } catch {
      if (!sourceCurrent()) {
        operation.finish('canceled');
        return;
      }
      operation.finish('failed');
      broadcast('imagegen:failed', [{ code: 'imagegen-save-failed' }]);
    } finally {
      active.delete(key);
      releaseSource?.();
    }
  })();
}
