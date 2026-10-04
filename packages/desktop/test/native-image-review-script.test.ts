import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

interface ImageTool {
  name: string;
  execute: (
    id: string,
    input: { model: string; paths: string[]; prompt: string },
  ) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

interface ReviewRequest {
  configFile: string;
  openclawRoot: string;
  imageModel: string;
  licenseHash: string;
  taskId: string;
  runId: string;
  guardBaseUrl: string;
  batchId: string;
  workspace: string;
  sessionKey: string;
  billingSessionId?: string;
  billingSessionProof?: {
    source: 'gateway-chat-history';
    taskId: string;
    sessionKey: string;
    runId: string;
    billingSessionId: string;
  };
  agentDir: string;
  outputSha256: string;
  revision: number;
  pages: Array<{ page: number; image: string; sha256: string }>;
}

interface ScriptModule {
  runImageReview: (
    request: ReviewRequest,
    dependencies: { fetcher: typeof fetch; loadTools: () => Promise<(options: unknown) => ImageTool[]> },
  ) => Promise<{ callId: string; pages: Array<{ page: number; issues: unknown[] }> }>;
}

function isScriptModule(value: unknown): value is ScriptModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'runImageReview' in value &&
    typeof value.runImageReview === 'function'
  );
}

let workspace: string;
let script: ScriptModule;
let request: ReviewRequest;
beforeEach(async () => {
  const loaded: unknown = await import(
    pathToFileURL(join(import.meta.dirname, '../resources/pptx-templates/native-image-review.mjs')).href
  );
  if (!isScriptModule(loaded)) throw Error('The image review script has no testable execution entry');
  script = loaded;
  workspace = mkdtempSync(join(tmpdir(), 'native-image-contract-'));
  writeFileSync(
    join(workspace, 'config.json'),
    JSON.stringify({
      models: { providers: { clawrouter: { baseUrl: 'http://127.0.0.1:1', apiKey: 'fixture-only' } } },
    }),
  );
  writeFileSync(join(workspace, 'package.json'), JSON.stringify({ version: '2026.9.3' }));
  request = {
    configFile: join(workspace, 'config.json'),
    openclawRoot: workspace,
    imageModel: 'clawrouter/fixture-vision',
    licenseHash: 'fixture-hash',
    taskId: 'task-1',
    runId: 'run-1',
    guardBaseUrl: 'http://127.0.0.1:1',
    batchId: 'batch-1',
    workspace,
    sessionKey: 'fixture-session',
    billingSessionId: 'runtime-session-1',
    billingSessionProof: {
      source: 'gateway-chat-history',
      taskId: 'task-1',
      sessionKey: 'fixture-session',
      runId: 'run-1',
      billingSessionId: 'runtime-session-1',
    },
    agentDir: workspace,
    outputSha256: 'a'.repeat(64),
    revision: 2,
    pages: [],
  };
  for (let page = 1; page <= 5; page += 1) {
    const image = `page-${page}.png`,
      content = Buffer.from(`fixture-image-${page}`);
    writeFileSync(join(workspace, image), content);
    request.pages.push({ page, image, sha256: createHash('sha256').update(content).digest('hex') });
  }
});
afterEach(() => {
  if (workspace) rmSync(workspace, { recursive: true, force: true });
});

function dependencies(options: { cap?: string; http?: number } = {}) {
  const execute = vi.fn(async (_id: string, input: { model: string; paths: string[]; prompt: string }) => {
    const pages = input.paths.map((file) => Number(file.match(/page-(\d+)\.png$/)?.[1]));
    return {
      content: [{ type: 'text', text: JSON.stringify({ pages: pages.map((page) => ({ page, issues: [] })) }) }],
    };
  });
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        JSON.stringify({
          guardVersion: 'ppt-budget-v1',
          licenseHash: request.licenseHash,
          currency: 'CNY',
          batchCapMicros: options.cap ?? '500000000',
          batchId: request.batchId,
        }),
        { status: options.http ?? 200 },
      ),
  );
  const createTools = vi.fn((_options: unknown) => [{ name: 'view_image', execute }]);
  const loadTools = vi.fn(async () => createTools);
  return { fetcher, loadTools, createTools, execute };
}

describe('fixed OpenClaw image review contract', () => {
  it('selects view_image and passes paths for every final-version page', async () => {
    const ports = dependencies();
    const result = await script.runImageReview(request, ports);
    expect(ports.execute).toHaveBeenCalledTimes(2);
    expect(ports.execute.mock.calls[0][1].paths).toEqual(
      request.pages.slice(0, 4).map((page) => join(workspace, page.image)),
    );
    expect(ports.execute.mock.calls[1][1].paths).toEqual([join(workspace, 'page-5.png')]);
    expect(ports.execute.mock.calls[0][1]).not.toHaveProperty('images');
    expect(ports.execute.mock.calls[0][1].prompt).toContain(request.outputSha256);
    expect(ports.execute.mock.calls[1][1].prompt).toContain('version 2');
    expect(result.pages.map((page) => page.page)).toEqual([1, 2, 3, 4, 5]);
    expect(ports.createTools).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: request.sessionKey,
        config: expect.objectContaining({
          models: expect.objectContaining({
            providers: expect.objectContaining({
              clawrouter: expect.objectContaining({
                headers: expect.objectContaining({ 'x-clawrouter-session-id': request.billingSessionId }),
              }),
            }),
          }),
        }),
      }),
    );
  });

  it.each([
    'missing-id',
    'missing-proof',
    'wrong-task',
    'wrong-run',
    'wrong-session',
    'wrong-runtime-id',
    'ui-task-id',
    'session-key',
  ])('does not fetch or execute when billing ownership is unverified: %s', async (fault) => {
    const ports = dependencies();
    if (fault === 'missing-id') delete request.billingSessionId;
    else if (fault === 'missing-proof') delete request.billingSessionProof;
    else if (fault === 'wrong-task') request.billingSessionProof!.taskId = 'another-task';
    else if (fault === 'wrong-run') request.billingSessionProof!.runId = 'another-run';
    else if (fault === 'wrong-session') request.billingSessionProof!.sessionKey = 'another-session';
    else if (fault === 'wrong-runtime-id') request.billingSessionProof!.billingSessionId = 'another-runtime-session';
    else {
      request.billingSessionId = fault === 'ui-task-id' ? request.taskId : request.sessionKey;
      request.billingSessionProof!.billingSessionId = request.billingSessionId;
    }
    await expect(script.runImageReview(request, ports)).rejects.toThrow('visual-billing-session-unverified');
    expect(ports.fetcher).not.toHaveBeenCalled();
    expect(ports.loadTools).not.toHaveBeenCalled();
    expect(ports.execute).not.toHaveBeenCalled();
  });

  it('replaces existing attribution headers case-insensitively without splitting the relay task', async () => {
    writeFileSync(
      request.configFile,
      JSON.stringify({
        models: {
          providers: {
            clawrouter: {
              baseUrl: request.guardBaseUrl,
              apiKey: 'fixture-only',
              headers: { 'X-ClawRouter-Session-Id': 'stale-session', 'X-Request-ID': 'stale-run', 'X-Fixture': 'keep' },
            },
          },
        },
      }),
    );
    const ports = dependencies();
    await script.runImageReview(request, ports);
    const options = ports.createTools.mock.calls[0][0];
    expect(options).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          models: expect.objectContaining({
            providers: expect.objectContaining({
              clawrouter: expect.objectContaining({
                headers: {
                  'x-clawrouter-session-id': request.billingSessionId,
                  'x-request-id': expect.stringMatching(/^run-1:model:\d+$/),
                  'X-Fixture': 'keep',
                },
              }),
            }),
          }),
        }),
      }),
    );
  });

  it('makes no tool call if any page hash is invalid, including a later group', async () => {
    const ports = dependencies();
    writeFileSync(join(workspace, 'page-5.png'), 'changed-final-page');
    await expect(script.runImageReview(request, ports)).rejects.toThrow('visual-image-version-mismatch');
    expect(ports.execute).not.toHaveBeenCalled();
  });

  it('retains the five-yuan batch guard even when a larger global limit is authorized', async () => {
    const ports = dependencies({ cap: '5000000000' });
    await expect(script.runImageReview(request, ports)).rejects.toThrow('visual-budget-guard-unavailable');
    expect(ports.loadTools).not.toHaveBeenCalled();
    expect(ports.execute).not.toHaveBeenCalled();
  });

  it('does not execute on a failed capability response', async () => {
    const ports = dependencies({ http: 409 });
    await expect(script.runImageReview(request, ports)).rejects.toThrow('visual-budget-guard-unavailable');
    expect(ports.execute).not.toHaveBeenCalled();
  });
});
