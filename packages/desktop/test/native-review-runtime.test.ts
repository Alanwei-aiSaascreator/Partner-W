import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeReviewPorts } from '../src/main/docgen/native-review-runtime';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

let workspace: string;
let context: {
  taskId: string;
  sessionKey: string;
  runId: string;
  billingSessionId?: string;
  billingSessionProof?: {
    source: 'gateway-chat-history';
    taskId: string;
    sessionKey: string;
    runId: string;
    billingSessionId: string;
  };
};

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'native-review-runtime-'));
  const configFile = join(workspace, 'review-config.json');
  writeFileSync(
    configFile,
    JSON.stringify({
      node: join(workspace, 'node.exe'),
      scriptsRoot: workspace,
      imageModel: 'clawrouter/fixture-vision',
      configFile: join(workspace, 'openclaw.json'),
      openclawRoot: workspace,
      licenseHash: 'fixture-license-hash',
      guardBaseUrl: 'http://127.0.0.1:1',
      batchId: 'batch-1',
      agentDir: workspace,
      allowOffice: true,
    }),
  );
  vi.stubEnv('ROYIN_NATIVE_REVIEW_CONFIG', configFile);
  vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
  context = {
    taskId: 'task-1',
    sessionKey: 'fixture-session',
    runId: 'run-1',
    billingSessionId: 'runtime-session-1',
    billingSessionProof: {
      source: 'gateway-chat-history',
      taskId: 'task-1',
      sessionKey: 'fixture-session',
      runId: 'run-1',
      billingSessionId: 'runtime-session-1',
    },
  };
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(workspace, { recursive: true, force: true });
});

describe('native visual runtime billing ownership', () => {
  it.each(['missing-id', 'missing-proof', 'wrong-task', 'wrong-run', 'wrong-session', 'ui-task-id', 'session-key'])(
    'leaves visual review unavailable before rendering or invocation: %s',
    (fault) => {
      if (fault === 'missing-id') delete context.billingSessionId;
      else if (fault === 'missing-proof') delete context.billingSessionProof;
      else if (fault === 'wrong-task') context.billingSessionProof!.taskId = 'other-task';
      else if (fault === 'wrong-run') context.billingSessionProof!.runId = 'other-run';
      else if (fault === 'wrong-session') context.billingSessionProof!.sessionKey = 'other-session';
      else {
        context.billingSessionId = fault === 'ui-task-id' ? context.taskId : context.sessionKey;
        context.billingSessionProof!.billingSessionId = context.billingSessionId;
      }
      expect(nativeReviewPorts(workspace, context, () => true)).toBeUndefined();
      expect(execFile).not.toHaveBeenCalled();
    },
  );

  it('does not enable review for a no-longer-current task and run', () => {
    expect(nativeReviewPorts(workspace, context, () => false)).toBeUndefined();
    expect(execFile).not.toHaveBeenCalled();
  });

  it('provides the verified runtime session without changing the tool session', () => {
    expect(nativeReviewPorts(workspace, context, () => true)).toBeDefined();
    expect(execFile).not.toHaveBeenCalled();
  });
});
