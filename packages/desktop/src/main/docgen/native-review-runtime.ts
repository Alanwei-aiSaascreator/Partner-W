import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { NativeReviewPorts } from './native-review.js';
import { readWorkspaceBytes } from '../slidegen/source-file.js';

// Construct only in main after resolving the owned task's actual gateway session.
// A product task UUID or session key is not a model-call billing session ID.
export interface NativeReviewBillingSessionProof {
  source: 'gateway-chat-history';
  taskId: string;
  sessionKey: string;
  runId: string;
  billingSessionId: string;
}

export function nativeReviewPorts(
  workspace: string,
  context: {
    taskId: string;
    sessionKey: string;
    runId?: string;
    billingSessionId?: string;
    billingSessionProof?: NativeReviewBillingSessionProof;
  },
  isCurrent: () => boolean,
): NativeReviewPorts | undefined {
  const billingProof = context.billingSessionProof;
  if (
    !isCurrent() ||
    !context.runId ||
    typeof context.billingSessionId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(context.billingSessionId) ||
    context.billingSessionId === context.taskId ||
    context.billingSessionId === context.sessionKey ||
    billingProof?.source !== 'gateway-chat-history' ||
    billingProof.taskId !== context.taskId ||
    billingProof.sessionKey !== context.sessionKey ||
    billingProof.runId !== context.runId ||
    billingProof.billingSessionId !== context.billingSessionId
  )
    return undefined;
  const file = process.env.ROYIN_NATIVE_REVIEW_CONFIG;
  if (process.env.ROYIN_NATIVE_PPT_VALIDATION !== '1' || !file || !path.isAbsolute(file)) return undefined;
  let cfg: {
    node: string;
    scriptsRoot: string;
    imageModel: string;
    configFile: string;
    openclawRoot: string;
    licenseHash: string;
    guardBaseUrl: string;
    batchId: string;
    agentDir: string;
    allowOffice: boolean;
  };
  try {
    cfg = JSON.parse(readWorkspaceBytes(path.dirname(file), path.basename(file), 64 * 1024).toString('utf8'));
    if (
      !cfg.imageModel?.startsWith('clawrouter/') ||
      !cfg.allowOffice ||
      !context.runId ||
      !cfg.licenseHash ||
      ![cfg.node, cfg.scriptsRoot, cfg.configFile, cfg.openclawRoot, cfg.agentDir].every(
        (p) => typeof p === 'string' && path.isAbsolute(p),
      )
    )
      return undefined;
  } catch {
    return undefined;
  }
  function invoke(executable: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        args,
        { windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          clearInterval(stop);
          if (error) reject(Error('native-visual-runtime-unavailable'));
          else resolve(stdout);
        },
      );
      const stop = setInterval(() => {
        if (!isCurrent()) child.kill();
      }, 100);
      stop.unref();
    });
  }
  let folder: string;
  return {
    model: cfg.imageModel,
    async render(receipt) {
      if (!isCurrent()) throw Error('native-visual-canceled');
      folder = fs.mkdtempSync(path.join(workspace, '.royin-native-review-'));
      const bytes = readWorkspaceBytes(workspace, receipt.fileName, receipt.bytes);
      const pptx = path.join(folder, 'final.pptx');
      fs.writeFileSync(pptx, bytes, { flag: 'wx' });
      await invoke('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(cfg.scriptsRoot, 'native-office-render.ps1'),
        '-InputPptx',
        pptx,
        '-OutputDirectory',
        folder,
      ]);
      return Array.from({ length: receipt.pages }, (_, i) =>
        path.relative(workspace, path.join(folder, `page-${i + 1}.png`)).replaceAll('\\', '/'),
      );
    },
    async review(input) {
      if (!isCurrent()) throw Error('native-visual-canceled');
      const file = path.join(folder, 'request.json');
      fs.writeFileSync(file, JSON.stringify({ ...cfg, ...input, workspace, ...context }), { flag: 'wx' });
      const response = JSON.parse(
        await invoke(cfg.node, [path.join(cfg.scriptsRoot, 'native-image-review.mjs'), file]),
      );
      if (response.error) throw Error(response.error);
      return response;
    },
  };
}
