import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { parseSlidegenToolStream } from '@clawwork/shared';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { installBundledSkill } from '../src/main/skills/bundled.js';

let root = '',
  workspace = '',
  command = '',
  child = '';
const sourceName = 'quarter $(never).slidegen';
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-launcher-test-'));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, sourceName), 'source');
  const managedDir = path.join(root, 'managed');
  expect(
    installBundledSkill({ root: path.join(import.meta.dirname, '../our-skills'), managedDir, slug: 'deck-layout' }).ok,
  ).toBe(true);
  command = path.join(managedDir, 'deck-layout/scripts/generate.cjs');
  child = path.join(root, 'child.cjs');
});
afterEach(() => {
  if (!path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('test path escaped');
  fs.rmSync(root, { recursive: true, force: true });
});

function configure(script: string) {
  fs.writeFileSync(child, script);
  fs.writeFileSync(
    path.join(path.dirname(command), 'generate-runtime.json'),
    JSON.stringify({ schemaVersion: 1, executable: process.execPath, args: [child] }),
  );
}
function invoke(args = [sourceName], environment: NodeJS.ProcessEnv = {}) {
  expect(fs.existsSync(command)).toBe(true);
  const { NODE_OPTIONS: options, NODE_PATH: nodePath, ...env } = process.env;
  void options;
  void nodePath;
  const result = spawnSync(process.execPath, [command, ...args], {
    cwd: workspace,
    env: { ...env, ...environment },
    encoding: 'utf8',
    timeout: 20_000,
    maxBuffer: 512 * 1024,
  });
  return { status: result.status, report: JSON.parse(result.stdout), stderr: result.stderr };
}

const success = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const [flag,file]=process.argv.slice(2);
fs.writeFileSync('invocation.json',JSON.stringify({flag,file,env:{temp:process.env.TEMP,appData:process.env.APPDATA,localAppData:process.env.LOCALAPPDATA,userProfile:process.env.USERPROFILE,nodeOptions:process.env.NODE_OPTIONS,nodePath:process.env.NODE_PATH,runAsNode:process.env.ELECTRON_RUN_AS_NODE}}));
const bytes=Buffer.from('actual-child-output');fs.writeFileSync('result.pptx',bytes);
console.log(JSON.stringify({schemaVersion:1,status:'file-generated',fileCreated:true,artifactIndexed:false,fileName:'result.pptx',pages:2,bytes:bytes.length,sourceSha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),outputSha256:crypto.createHash('sha256').update(bytes).digest('hex'),warnings:[],visualReview:'not-performed'}));`;

it.each([
  { ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--no-warnings', NODE_PATH: 'untrusted' },
  { electron_run_as_node: '1', node_options: '--no-warnings', node_path: 'untrusted' },
])('runs the installed helper with literal arguments and owned disposable profile paths: %j', (environment) => {
  configure(success);
  const result = invoke(undefined, environment);
  expect(result.status).toBe(0);
  expect(result.report).toMatchObject({
    status: 'file-generated',
    artifactIndexed: false,
    visualReview: 'not-performed',
    runtimeCleanup: 'complete',
    sourceSha256: createHash('sha256').update('source').digest('hex'),
  });
  const invocation = JSON.parse(fs.readFileSync(path.join(workspace, 'invocation.json'), 'utf8'));
  expect(invocation.flag).toBe('--royin-render-slidegen');
  expect(invocation.file).toBe(sourceName);
  for (const name of ['temp', 'appData', 'localAppData', 'userProfile']) {
    expect(path.dirname(invocation.env[name])).toBe(path.dirname(invocation.env.temp));
    expect(fs.existsSync(invocation.env[name])).toBe(false);
  }
  expect(invocation.env).not.toHaveProperty('runAsNode');
  expect(invocation.env).not.toHaveProperty('nodeOptions');
  expect(invocation.env).not.toHaveProperty('nodePath');
  expect(fs.readFileSync(path.join(workspace, sourceName), 'utf8')).toBe('source');
});

it('reports an unconfigured runtime without guessing a program or tool', () => {
  expect(invoke()).toMatchObject({
    status: 1,
    report: {
      status: 'runtime-unavailable',
      fileCreated: false,
      diagnostics: [{ code: 'render-runtime-not-configured' }],
    },
  });
  expect(fs.readdirSync(workspace)).toEqual([sourceName]);
});

it('reports a missing configured executable without exposing the config contents', () => {
  fs.writeFileSync(
    path.join(path.dirname(command), 'generate-runtime.json'),
    JSON.stringify({ schemaVersion: 1, executable: path.join(root, 'missing.exe'), args: [] }),
  );
  expect(invoke()).toMatchObject({
    status: 1,
    report: { status: 'runtime-unavailable', diagnostics: [{ code: 'render-runtime-unavailable' }] },
  });
});

it('returns exact source diagnostics and the child failure exit code', () => {
  configure(
    "console.log(JSON.stringify({schemaVersion:1,status:'source-invalid',fileCreated:false,artifactIndexed:false,diagnostics:[{code:'slidegen-unparsable',diagnostic:{offset:40,detail:'invalid closing tag'}}],visualReview:'not-performed'}));process.exitCode=1;",
  );
  expect(invoke()).toMatchObject({
    status: 1,
    report: {
      status: 'source-invalid',
      fileCreated: false,
      diagnostics: [{ code: 'slidegen-unparsable', diagnostic: { offset: 40 } }],
      runtimeCleanup: 'complete',
    },
  });
});

it.each(['malformed', 'exit', 'changed-file', 'changed-source'])(
  'does not claim a confirmed file after %s',
  (fault) => {
    configure(
      fault === 'malformed'
        ? "console.log('secret-token');"
        : success +
            (fault === 'exit'
              ? 'process.exitCode=1;'
              : fault === 'changed-file'
                ? "require('node:fs').writeFileSync('result.pptx','changed');"
                : "require('node:fs').writeFileSync(process.argv.at(-1),'changed');"),
    );
    const result = invoke();
    expect(result.status).toBe(1);
    expect(result.report).toMatchObject({
      status: 'output-unconfirmed',
      fileCreated: null,
      artifactIndexed: false,
      diagnostics: [{ code: 'render-output-unconfirmed' }],
    });
    expect(JSON.stringify(result.report)).not.toContain('secret-token');
  },
);

it('reports an actual child timeout without blindly retrying or claiming no file exists', () => {
  configure("require('node:fs').writeFileSync('started.txt','started');setInterval(()=>{},1000);");
  expect(invoke(undefined, { ROYIN_SLIDEGEN_TIMEOUT_MS: '1000' })).toMatchObject({
    status: 1,
    report: {
      status: 'output-unconfirmed',
      fileCreated: null,
      diagnostics: [{ code: 'render-command-timeout' }],
      runtimeCleanup: 'complete',
    },
  });
  expect(fs.readFileSync(path.join(workspace, 'started.txt'), 'utf8')).toBe('started');
});

it.each([{ args: [] }, { args: [sourceName, 'extra'] }])(
  'rejects invalid arguments before creating a runtime profile: $args',
  ({ args }) => {
    expect(invoke(args)).toMatchObject({
      status: 1,
      report: { status: 'source-invalid', fileCreated: false, diagnostics: [{ code: 'source-argument-invalid' }] },
    });
  },
);

const telemetry = (completed = 1, overrides: Record<string, unknown> = {}) =>
  'console.log(JSON.stringify(' +
  JSON.stringify({
    schemaVersion: 1,
    status: 'slidegen-progress',
    sourceSha256: createHash('sha256').update('source').digest('hex'),
    completed,
    total: 2,
    ...overrides,
  }) +
  '));';

async function invokeStreaming() {
  const frames: Array<{ text: string; fileAlreadyExists: boolean }> = [];
  const result = await new Promise<{ status: number | null; stdout: string }>((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const processChild = spawn(process.execPath, [command, sourceName], { cwd: workspace, env, windowsHide: true });
    let stdout = '';
    processChild.stdout.setEncoding('utf8');
    processChild.stdout.on('data', (text: string) => {
      stdout += text;
      frames.push({ text, fileAlreadyExists: fs.existsSync(path.join(workspace, 'result.pptx')) });
    });
    processChild.on('error', reject);
    processChild.on('close', (status) => resolve({ status, stdout }));
  });
  return { ...result, frames, stream: parseSlidegenToolStream(result.stdout) };
}

it('streams validated pages before the installed helper child creates its final file', async () => {
  configure(telemetry() + 'setTimeout(()=>{' + telemetry(2) + success + '},600);');
  const result = await invokeStreaming();
  expect(result.status).toBe(0);
  expect(result.frames.some((frame) => frame.text.includes('slidegen-progress') && !frame.fileAlreadyExists)).toBe(
    true,
  );
  expect(result.stream).toMatchObject({
    progress: { completed: 2, total: 2 },
    report: { status: 'file-generated', runtimeCleanup: 'complete', pages: 2 },
  });
});

it.each([
  ['wrong source', telemetry(1, { sourceSha256: 'b'.repeat(64) })],
  ['wrong total', telemetry(1, { total: 201 })],
  ['extra fields', telemetry(1, { leaked: 'secret-token' })],
  ['regression', telemetry(2) + telemetry(1)],
  ['final page mismatch', telemetry(1, { total: 3 })],
])('does not confirm a file for invalid producer telemetry: %s', async (_label, prefix) => {
  configure(prefix + success);
  const result = await invokeStreaming();
  expect(result.status).toBe(1);
  expect(result.stream?.report).toMatchObject({ status: 'output-unconfirmed', fileCreated: null });
  expect(result.stdout).not.toContain('secret-token');
});

it.each(['stdout', 'stderr'])('bounds actual child %s without exposing oversized output', async (channel) => {
  configure('process.' + channel + ".write('secret-token'.repeat(900000));setInterval(()=>{},1000);");
  const result = await invokeStreaming();
  expect(result.status).toBe(1);
  expect(result.stream?.report).toMatchObject({
    status: 'output-unconfirmed',
    fileCreated: null,
    runtimeCleanup: 'complete',
  });
  expect(result.stdout).not.toContain('secret-token');
});

it('preserves real page progress but reports unknown when the child times out afterward', async () => {
  configure(telemetry() + 'setInterval(()=>{},1000);');
  const envBefore = process.env.ROYIN_SLIDEGEN_TIMEOUT_MS;
  process.env.ROYIN_SLIDEGEN_TIMEOUT_MS = '1000';
  try {
    const result = await invokeStreaming();
    expect(result.status).toBe(1);
    expect(result.stream).toMatchObject({
      progress: { completed: 1, total: 2 },
      report: {
        status: 'output-unconfirmed',
        fileCreated: null,
        runtimeCleanup: 'complete',
        diagnostics: [{ code: 'render-command-timeout' }],
      },
    });
  } finally {
    if (envBefore === undefined) delete process.env.ROYIN_SLIDEGEN_TIMEOUT_MS;
    else process.env.ROYIN_SLIDEGEN_TIMEOUT_MS = envBefore;
  }
});
