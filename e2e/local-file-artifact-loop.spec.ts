import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchApp } from './helpers/electron-app';

interface ArtifactRow {
  id: string;
  taskId: string;
  name: string;
  localPath: string;
  availability?: 'available' | 'missing';
}

interface ContextSourceRow {
  id: string;
  taskId: string;
  displayName: string;
  availability: 'available' | 'missing';
}

interface ImportedFileRow {
  fileName: string;
  localPath: string;
}

interface IpcResult<T> {
  ok: boolean;
  result?: T;
  error?: string;
}

let app: ElectronApplication | null = null;
let page: Page | null = null;
let cleanup: (() => void) | null = null;
let userDataDir = '';
let workspaceDir = '';

async function bootExistingProfile(): Promise<void> {
  const launched = await launchApp({ userDataDir, workspaceDir });
  app = launched.app;
  page = launched.page;
  cleanup ??= launched.cleanup;
  await page.waitForFunction(() => typeof window.clawwork === 'object');
  await expect.poll(() => page!.evaluate(() => window.clawwork.isWorkspaceConfigured())).toBe(true);
}

async function closeApp(): Promise<void> {
  if (!app) return;
  await app.close().catch(() => undefined);
  app = null;
  page = null;
}

async function stubOpenDialog(paths: string[]): Promise<void> {
  await app!.evaluate(({ dialog }, selectedPaths) => {
    Object.defineProperty(dialog, 'showOpenDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePaths: selectedPaths }),
    });
  }, paths);
}

async function stubSaveDialog(destination: string): Promise<void> {
  await app!.evaluate(({ dialog }, filePath) => {
    Object.defineProperty(dialog, 'showSaveDialog', {
      configurable: true,
      value: async () => ({ canceled: false, filePath }),
    });
  }, destination);
}

test.describe('local file and artifact delivery loop', () => {
  test.beforeAll(async () => {
    const launched = await launchApp();
    userDataDir = launched.userDataDir;
    workspaceDir = launched.workspaceDir;
    app = launched.app;
    page = launched.page;
    cleanup = launched.cleanup;
    await page.waitForFunction(() => typeof window.clawwork === 'object');
    await expect.poll(() => page!.evaluate(() => window.clawwork.isWorkspaceConfigured())).toBe(true);
  });

  test.afterAll(async () => {
    await closeApp();
    cleanup?.();
  });

  test('imports task material, restores a folder grant, and delivers a real restart-safe artifact', async () => {
    test.setTimeout(120_000);

    const taskId = `artifact-loop-${Date.now()}`;
    const sessionKey = `agent:partner-w-office:clawwork:task:${taskId}`;
    const now = new Date().toISOString();
    const task = {
      id: taskId,
      sessionKey,
      sessionId: '',
      title: '季度材料整理',
      status: 'active',
      createdAt: now,
      updatedAt: now,
      tags: [],
      artifactDir: taskId,
      gatewayId: 'local-runtime',
    };
    const persisted = await page!.evaluate((value) => window.clawwork.persistTask(value), task);
    expect(persisted.ok).toBe(true);
    const assistantMessageId = `assistant-${taskId}`;
    const persistedMessage = await page!.evaluate((message) => window.clawwork.persistMessage(message), {
      id: assistantMessageId,
      taskId,
      role: 'assistant',
      content: '已生成季度总结文件。',
      timestamp: now,
      sessionKey,
    });
    expect(persistedMessage.ok, JSON.stringify(persistedMessage)).toBe(true);

    const fixtureRoot = join(workspaceDir, '.e2e-fixtures', taskId);
    const grantRoot = join(fixtureRoot, 'reference-folder');
    mkdirSync(grantRoot, { recursive: true });
    const inputPath = join(fixtureRoot, 'quarterly-report.csv');
    writeFileSync(inputPath, 'month,revenue\n8,120000\n9,136000\n', 'utf8');
    writeFileSync(join(grantRoot, 'brief.txt'), '重点说明：关注九月增长。', 'utf8');

    await stubOpenDialog([inputPath]);
    const imported = await page!.evaluate(
      (id) => window.clawwork.importTaskFiles(id) as Promise<IpcResult<{ imported: ImportedFileRow[] }>>,
      taskId,
    );
    expect(imported.ok).toBe(true);
    const importedRow = imported.result?.imported[0];
    expect(importedRow).toEqual(
      expect.objectContaining({ fileName: expect.stringMatching(/^quarterly-report(?:-[a-f0-9]+)?\.csv$/) }),
    );
    if (!importedRow) throw new Error('Imported file metadata was not returned');
    expect(importedRow.localPath).toMatch(new RegExp(`^${taskId}/inbox/quarterly-report(?:-[a-f0-9]+)?\\.csv$`));

    await stubOpenDialog([grantRoot]);
    const granted = await page!.evaluate(
      (id) => window.clawwork.grantTaskContextFolder(id) as Promise<IpcResult<ContextSourceRow | null>>,
      taskId,
    );
    expect(granted.ok).toBe(true);
    expect(granted.result).toEqual(
      expect.objectContaining({ taskId, displayName: 'reference-folder', availability: 'available' }),
    );

    const sourceFile = await page!.evaluate(
      ({ id, sourceId }) => window.clawwork.readTaskContextFile(id, sourceId, 'brief.txt'),
      { id: taskId, sourceId: granted.result!.id },
    );
    expect(sourceFile.ok).toBe(true);
    expect(sourceFile.result).toEqual(expect.objectContaining({ content: '重点说明：关注九月增长。' }));

    const generatedDir = join(fixtureRoot, 'generated');
    mkdirSync(generatedDir, { recursive: true });
    const generatedPath = join(generatedDir, 'quarterly-summary.md');
    writeFileSync(generatedPath, '# 季度总结\n\n九月收入较八月增长。\n', 'utf8');
    const saved = await page!.evaluate(
      (params) => window.clawwork.saveArtifact(params) as Promise<IpcResult<ArtifactRow>>,
      {
        taskId,
        sourcePath: generatedPath,
        messageId: assistantMessageId,
        fileName: 'quarterly-summary.md',
        mediaType: 'text/markdown',
      },
    );
    expect(saved.ok, JSON.stringify(saved)).toBe(true);
    expect(saved.result).toEqual(
      expect.objectContaining({ taskId, name: expect.stringMatching(/^quarterly-summary-[a-f0-9]+\.md$/) }),
    );
    const savedRow = saved.result;
    if (!savedRow) throw new Error('Saved artifact metadata was not returned');

    const saveAsPath = join(fixtureRoot, 'exported-summary.md');
    await stubSaveDialog(saveAsPath);
    const saveAs = await page!.evaluate(({ artifactId, id }) => window.clawwork.saveArtifactAs(artifactId, id), {
      artifactId: savedRow.id,
      id: taskId,
    });
    expect(saveAs.ok).toBe(true);
    expect(readFileSync(saveAsPath, 'utf8')).toContain('九月收入较八月增长');

    await closeApp();
    await bootExistingProfile();

    const restored = await page!.evaluate(async (id) => {
      const [files, sources, artifacts] = await Promise.all([
        window.clawwork.listImportedTaskFiles(id),
        window.clawwork.listTaskContextSources(id),
        window.clawwork.listArtifacts(id),
      ]);
      return { files, sources, artifacts };
    }, taskId);
    expect(restored.files.result).toEqual([
      expect.objectContaining({ fileName: importedRow.fileName, localPath: importedRow.localPath }),
    ]);
    expect(restored.sources.result).toEqual([
      expect.objectContaining({ id: granted.result!.id, availability: 'available' }),
    ]);
    expect(restored.artifacts.result).toEqual([
      expect.objectContaining({ id: savedRow.id, name: savedRow.name, availability: 'available' }),
    ]);

    rmSync(grantRoot, { recursive: true, force: true });
    const missingSources = await page!.evaluate(
      (id) => window.clawwork.listTaskContextSources(id) as Promise<IpcResult<ContextSourceRow[]>>,
      taskId,
    );
    expect(missingSources.result).toEqual([
      expect.objectContaining({ id: granted.result!.id, availability: 'missing' }),
    ]);
  });
});
