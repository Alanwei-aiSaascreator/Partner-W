import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;
const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const probePath = fileURLToPath(new URL('./helpers/context-source-service-probe.ts', import.meta.url));
let runnerDir: string;
let compiledProbePath: string;

interface SourceShape {
  id: string;
  taskId: string;
  kind: string;
  absolutePath: string;
  displayName: string;
  availability: string;
}

interface CaptureResult {
  value?: unknown;
  error?: string;
}

interface ProbeResult {
  replacementSupported: boolean;
  replacement: CaptureResult;
  driftFiles: CaptureResult;
  driftRead: CaptureResult;
  source: SourceShape;
  duplicate: SourceShape;
  listed: SourceShape[];
  files: Array<{ relativePath: string }>;
  queried: unknown[];
  read: Record<string, unknown>;
  parentEscape: CaptureResult;
  absolute: CaptureResult;
  empty: CaptureResult;
  nul: CaptureResult;
  symlink: CaptureResult;
  otherTaskResolve: CaptureResult;
  wrongTaskRevoke: boolean;
  stillReadable: CaptureResult;
  revoked: boolean;
  afterRevoke: CaptureResult;
}

function runProbe(scenario: string, grantedPath: string, outsidePath?: string): ProbeResult {
  const workspacePath = mkdtempSync(join(tmpdir(), 'clawwork-context-db-'));
  try {
    const child = spawnSync(
      electronPath,
      [compiledProbePath, workspacePath, scenario, grantedPath, outsidePath ?? ''],
      {
        cwd: packageDir,
        encoding: 'utf8',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 30_000,
      },
    );
    if (child.status !== 0) throw new Error(`probe failed (${child.status}):\n${child.stdout}\n${child.stderr}`);
    const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith('CONTEXT_SOURCE_RESULT='));
    if (!line) throw new Error(`probe returned no result:\n${child.stdout}\n${child.stderr}`);
    return JSON.parse(line.slice('CONTEXT_SOURCE_RESULT='.length)) as ProbeResult;
  } finally {
    rmSync(workspacePath, { recursive: true, force: true });
  }
}

describe('task-scoped folder source service', () => {
  beforeAll(async () => {
    runnerDir = mkdtempSync(join(packageDir, '.context-source-probe-'));
    compiledProbePath = join(runnerDir, 'probe.mjs');
    await build({
      configFile: false,
      logLevel: 'silent',
      root: packageDir,
      ssr: { noExternal: true, external: ['better-sqlite3'] },
      build: {
        emptyOutDir: true,
        minify: false,
        outDir: runnerDir,
        ssr: probePath,
        rollupOptions: { output: { entryFileNames: 'probe.mjs' } },
      },
    });
  }, 30_000);

  afterAll(() => rmSync(runnerDir, { recursive: true, force: true }));

  it('creates, restores, deduplicates, scans, and reads an available folder source', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-grant-'));
    try {
      writeFileSync(join(root, 'inside.txt'), 'inside content');
      writeFileSync(join(root, 'blocked.exe'), 'no');
      const result = runProbe('lifecycle', root);

      expect(result.source).toEqual(
        expect.objectContaining({
          taskId: 'task-1',
          kind: 'folder',
          absolutePath: root,
          availability: 'available',
          displayName: expect.any(String),
        }),
      );
      expect(result.source.id).toBe(result.duplicate.id);
      expect(result.listed).toEqual([expect.objectContaining({ id: result.source.id, availability: 'available' })]);
      expect(result.files.map((entry: { relativePath: string }) => entry.relativePath)).toEqual(['inside.txt']);
      expect(result.queried).toHaveLength(1);
      expect(result.read).toEqual(expect.objectContaining({ content: 'inside content', tier: 'text' }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves a missing folder record and reports it as missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-missing-grant-'));
    const result = runProbe('missing', root);
    expect(result.listed).toEqual([expect.objectContaining({ taskId: 'task-1', availability: 'missing' })]);
  });

  it('rejects a grant root replaced by a symlink or junction to another directory', ({ skip }) => {
    const rootParent = mkdtempSync(join(tmpdir(), 'clawwork-drift-parent-'));
    const root = join(rootParent, 'granted');
    const outside = mkdtempSync(join(tmpdir(), 'clawwork-drift-outside-'));
    try {
      mkdirSync(root);
      writeFileSync(join(outside, 'outside.txt'), 'outside');

      const result = runProbe('root-drift', root, outside);
      if (!result.replacementSupported)
        skip(`filesystem link unavailable: ${result.replacement.error ?? 'unknown error'}`);
      expect(result.listed).toEqual([expect.objectContaining({ availability: 'missing' })]);
      expect(result.driftFiles.error).toMatch(/changed|unavailable/i);
      expect(result.driftRead.error).toMatch(/changed|unavailable/i);
    } finally {
      rmSync(rootParent, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('enforces task ownership, revocation, and canonical containment', () => {
    const root = mkdtempSync(join(tmpdir(), 'clawwork-secure-grant-'));
    const outside = mkdtempSync(join(tmpdir(), 'clawwork-outside-'));
    try {
      writeFileSync(join(root, 'inside.txt'), 'inside');
      const outsideFile = join(outside, 'outside.txt');
      writeFileSync(outsideFile, 'outside');
      let symlinkSupported = true;
      try {
        symlinkSync(outsideFile, join(root, 'linked.txt'), 'file');
      } catch {
        symlinkSupported = false;
      }

      const result = runProbe('security', root, outsideFile);
      for (const key of ['parentEscape', 'absolute', 'empty', 'nul', 'otherTaskResolve'] as const) {
        expect(result[key].error, key).toBeTruthy();
      }
      if (symlinkSupported) expect(result.symlink.error).toBeTruthy();
      expect(result.wrongTaskRevoke).toBe(false);
      expect(result.stillReadable.value).toEqual(expect.objectContaining({ content: 'inside' }));
      expect(result.revoked).toBe(true);
      expect(result.afterRevoke.error).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects a new grant when its folder does not exist', () => {
    const missing = join(tmpdir(), `clawwork-never-created-${Date.now()}`);
    expect(() => runProbe('lifecycle', missing)).toThrow();
  });
});
