import { ipcMain, BrowserWindow, dialog, shell, nativeImage, type NativeImage } from 'electron';
import { readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'node:url';
import { resolve, sep } from 'path';
import { eq } from 'drizzle-orm';
import { getDb, getSqlite } from '../db/index.js';
import { artifacts, tasks, messages } from '../db/schema.js';
import { saveArtifact, saveArtifactFromBuffer } from '../artifact/save.js';
import { getWorkspacePath } from '../workspace/config.js';
import { searchArtifacts } from '../db/search.js';
import { safeFetch } from '../net/safe-fetch.js';
import { getArtifactAvailability } from '../artifact/reconcile.js';
import { copyArtifactToDestination, inspectArtifactFile, readVerifiedArtifactFile } from '../artifact/access.js';
import { trackOnSuccess } from '../analytics/reporter.js';

interface SaveParams {
  taskId: string;
  sourcePath: string;
  messageId: string;
  fileName?: string;
  mediaType?: string;
}

const MAX_THUMBNAIL_SOURCE_BYTES = 10 * 1024 * 1024;

function resizeThumbnailImage(image: NativeImage, size: number): NativeImage {
  const { width, height } = image.getSize();
  const maxDimension = Math.max(width, height);
  if (maxDimension <= size) return image;
  return width >= height ? image.resize({ width: size }) : image.resize({ height: size });
}

export function registerArtifactHandlers(): void {
  ipcMain.handle('artifact:save', async (_event, params: SaveParams) => {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      return { ok: false, error: 'workspace not configured' };
    }
    try {
      const realSource = realpathSync(params.sourcePath);
      const allowedPrefixes = [resolve(workspacePath) + sep, tmpdir() + sep];
      if (!allowedPrefixes.some((p) => realSource.startsWith(p))) {
        return { ok: false, error: 'source path outside allowed locations' };
      }

      const artifact = await saveArtifact({
        workspacePath,
        taskId: params.taskId,
        sourcePath: realSource,
        messageId: params.messageId,
        fileName: params.fileName,
        mediaType: params.mediaType,
      });

      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('artifact:saved', artifact);
      }

      return trackOnSuccess({ ok: true, result: artifact }, 'artifact_saved');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('artifact:list', async (_event, params: { taskId?: string }) => {
    try {
      const db = getDb();
      const rows = params.taskId
        ? db.select().from(artifacts).where(eq(artifacts.taskId, params.taskId)).all()
        : db.select().from(artifacts).all();
      const workspacePath = getWorkspacePath();
      return {
        ok: true,
        result: rows.map((row) => ({
          ...row,
          availability: workspacePath ? getArtifactAvailability(row.localPath, workspacePath) : 'missing',
        })),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('artifact:get', async (_event, params: { id: string }) => {
    try {
      const db = getDb();
      const rows = db.select().from(artifacts).where(eq(artifacts.id, params.id)).all();
      if (rows.length === 0) {
        return { ok: false, error: 'artifact not found' };
      }
      const workspacePath = getWorkspacePath();
      return {
        ok: true,
        result: {
          ...rows[0],
          availability: workspacePath ? getArtifactAvailability(rows[0].localPath, workspacePath) : 'missing',
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('artifact:save-as', async (_event, params: { artifactId: string; taskId?: string }) => {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return { ok: false, error: 'workspace not configured' };
    try {
      const artifact = loadArtifactForAction(params.artifactId, params.taskId);
      if (!artifact) return { ok: false, error: 'artifact not found' };
      const win = BrowserWindow.getAllWindows()[0];
      const options = { defaultPath: artifact.name };
      const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) {
        return { ok: true, result: { status: 'cancelled' as const } };
      }
      const result = await copyArtifactToDestination(workspacePath, artifact.localPath, choice.filePath);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  });

  ipcMain.handle('artifact:read-file', async (_event, params: { artifactId: string; taskId?: string }) => {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return { ok: false, error: 'workspace not configured' };
    try {
      const artifact = loadArtifactForAction(params.artifactId, params.taskId);
      if (!artifact) return { ok: false, error: 'artifact not found' };
      const encoding = isTextFile(artifact.localPath) ? 'utf-8' : 'base64';
      const buffer = await readVerifiedArtifactFile(workspacePath, artifact.localPath);
      const content = buffer.toString(encoding);
      return { ok: true, result: { content, encoding } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(
    'artifact:thumbnail',
    async (_event, params: { artifactId: string; taskId?: string; size?: number }) => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) return { ok: false, error: 'workspace not configured' };
      try {
        const artifact = loadArtifactForAction(params.artifactId, params.taskId);
        if (!artifact) return { ok: false, error: 'artifact not found' };
        const size = Math.min(Math.max(params.size ?? 128, 32), 256);
        const buffer = await readVerifiedArtifactFile(workspacePath, artifact.localPath, {
          maxBytes: MAX_THUMBNAIL_SOURCE_BYTES,
        });
        const image = nativeImage.createFromBuffer(buffer);
        if (image.isEmpty()) return { ok: false, error: 'thumbnail unavailable' };
        const resized = resizeThumbnailImage(image, size);
        return { ok: true, result: { dataUrl: resized.toDataURL() } };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error';
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'artifact:save-content',
    async (
      _event,
      params: { taskId: string; messageId: string; content: string; language?: string; fileName?: string },
    ) => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) return { ok: false, error: 'workspace not configured' };
      try {
        const LANG_EXT: Record<string, string> = {
          typescript: 'ts',
          javascript: 'js',
          python: 'py',
          rust: 'rs',
          go: 'go',
          java: 'java',
          md: 'md',
          markdown: 'md',
          tsx: 'tsx',
          jsx: 'jsx',
          json: 'json',
          css: 'css',
          html: 'html',
          sh: 'sh',
          bash: 'sh',
          sql: 'sql',
          yaml: 'yml',
          yml: 'yml',
        };
        const fileName =
          params.fileName ??
          (() => {
            const ext = (params.language && LANG_EXT[params.language.toLowerCase()]) ?? params.language ?? 'txt';
            return `snippet.${ext}`;
          })();
        const buffer = Buffer.from(params.content, 'utf-8');
        const artifact = await saveArtifactFromBuffer({
          workspacePath,
          taskId: params.taskId,
          messageId: params.messageId,
          fileName,
          buffer,
          artifactType: 'code',
          contentText: params.content,
        });
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send('artifact:saved', artifact);
        return { ok: true, result: artifact };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
      }
    },
  );

  ipcMain.handle(
    'artifact:save-image-url',
    async (_event, params: { taskId: string; messageId: string; url: string; alt?: string }) => {
      const workspacePath = getWorkspacePath();
      if (!workspacePath) return { ok: false, error: 'workspace not configured' };
      try {
        let buffer: Buffer;
        const url = params.url;
        if (/^https?:\/\//.test(url)) {
          buffer = await safeFetch(url);
        } else if (url.startsWith('file://')) {
          const filePath = resolve(fileURLToPath(url));
          if (!filePath.startsWith(resolve(workspacePath) + sep)) {
            return { ok: false, error: 'file path outside workspace' };
          }
          buffer = readFileSync(filePath);
        } else {
          return { ok: false, error: 'unsupported url scheme' };
        }
        const ext = url.split('.').pop()?.split('?')[0]?.toLowerCase() ?? 'png';
        const baseName = params.alt ? `${params.alt.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}` : `image.${ext}`;
        const artifact = await saveArtifactFromBuffer({
          workspacePath,
          taskId: params.taskId,
          messageId: params.messageId,
          fileName: baseName,
          buffer,
          artifactType: 'image',
        });
        const win = BrowserWindow.getAllWindows()[0];
        if (win) win.webContents.send('artifact:saved', artifact);
        return { ok: true, result: artifact };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
      }
    },
  );

  ipcMain.handle('artifact:open-file', async (_event, params: { artifactId: string; taskId?: string }) => {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return { ok: false, error: 'workspace not configured' };
    try {
      const artifact = loadArtifactForAction(params.artifactId, params.taskId);
      if (!artifact) return { ok: false, error: 'artifact not found' };
      const inspected = await inspectArtifactFile(workspacePath, artifact.localPath);
      if (inspected.availability !== 'available' || !inspected.absolutePath) {
        return { ok: false, error: `artifact ${inspected.availability}` };
      }
      const revalidated = await inspectArtifactFile(workspacePath, artifact.localPath);
      if (revalidated.availability !== 'available' || revalidated.absolutePath !== inspected.absolutePath) {
        return { ok: false, error: `artifact ${revalidated.availability}` };
      }
      const result = await shell.openPath(revalidated.absolutePath);
      if (result) return { ok: false, error: result };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  });

  ipcMain.handle('artifact:show-in-folder', async (_event, params: { artifactId: string; taskId?: string }) => {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return { ok: false, error: 'workspace not configured' };
    try {
      const artifact = loadArtifactForAction(params.artifactId, params.taskId);
      if (!artifact) return { ok: false, error: 'artifact not found' };
      const inspected = await inspectArtifactFile(workspacePath, artifact.localPath);
      if (inspected.availability !== 'available' || !inspected.absolutePath) {
        return { ok: false, error: `artifact ${inspected.availability}` };
      }
      const revalidated = await inspectArtifactFile(workspacePath, artifact.localPath);
      if (revalidated.availability !== 'available' || revalidated.absolutePath !== inspected.absolutePath) {
        return { ok: false, error: `artifact ${revalidated.availability}` };
      }
      shell.showItemInFolder(revalidated.absolutePath);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  });

  ipcMain.handle(
    'artifact:search',
    async (_event, params: { query: string; kind?: 'all' | 'image' | 'code' | 'file' | 'other' }) => {
      const sqlite = getSqlite();
      if (!sqlite) return { ok: false, error: 'db not ready' };
      try {
        const results = searchArtifacts(sqlite, params.query, { kind: params.kind });
        return { ok: true, result: results };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
      }
    },
  );

  ipcMain.handle('session:export-markdown', async (_event, params: { taskId: string }) => {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return { ok: false, error: 'workspace not configured' };
    try {
      const { md, safeName, lastMessageId } = loadSessionMarkdown(params.taskId);
      const buffer = Buffer.from(md, 'utf-8');

      const artifact = await saveArtifactFromBuffer({
        workspacePath,
        taskId: params.taskId,
        messageId: lastMessageId ?? params.taskId,
        fileName: `${safeName}.md`,
        buffer,
        artifactType: 'file',
        contentText: md,
      });

      const win = BrowserWindow.getAllWindows()[0];
      if (win) win.webContents.send('artifact:saved', artifact);
      return { ok: true, result: artifact };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
    }
  });

  ipcMain.handle('session:export-markdown-as', async (_event, params: { taskId: string }) => {
    try {
      const { md, safeName } = loadSessionMarkdown(params.taskId);
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return { ok: false, error: 'no window' };

      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: `${safeName}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (canceled || !filePath) return { ok: false, error: 'cancelled' };

      writeFileSync(filePath, md, 'utf-8');
      return { ok: true, result: { filePath } };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
    }
  });
}

function loadArtifactForAction(
  artifactId: string,
  taskId?: string,
): Pick<typeof artifacts.$inferSelect, 'id' | 'taskId' | 'name' | 'localPath'> | null {
  if (!artifactId) return null;
  const rows = getDb().select().from(artifacts).where(eq(artifacts.id, artifactId)).all();
  const artifact = rows[0];
  if (!artifact || (taskId && artifact.taskId !== taskId)) return null;
  return artifact;
}

const TEXT_EXTS = new Set([
  '.md',
  '.txt',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.json',
  '.html',
  '.css',
  '.sql',
  '.yaml',
  '.yml',
  '.xml',
  '.csv',
  '.sh',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.java',
  '.toml',
  '.env',
]);

function isTextFile(localPath: string): boolean {
  const dot = localPath.lastIndexOf('.');
  if (dot === -1) return true;
  return TEXT_EXTS.has(localPath.slice(dot).toLowerCase());
}

type TaskRow = typeof tasks.$inferSelect;
type MessageRow = typeof messages.$inferSelect;

interface ExportResult {
  md: string;
  safeName: string;
  lastMessageId: string | undefined;
}

function loadSessionMarkdown(taskId: string): ExportResult {
  const db = getDb();
  const taskRows = db.select().from(tasks).where(eq(tasks.id, taskId)).all();
  if (taskRows.length === 0) throw new Error('task not found');
  const task = taskRows[0];

  const msgRows = db.select().from(messages).where(eq(messages.taskId, taskId)).orderBy(messages.timestamp).all();

  const md = buildSessionMarkdown(task, msgRows);
  const safeName =
    task.title
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/[\t\n\r]/g, '_')
      .trim() || 'session';
  const lastMessageId = msgRows.length > 0 ? msgRows[msgRows.length - 1].id : undefined;
  return { md, safeName, lastMessageId };
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const Y = d.getFullYear();
  const M = String(d.getMonth() + 1).padStart(2, '0');
  const D = String(d.getDate()).padStart(2, '0');
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}`;
}

const ROLE_LABEL: Record<string, string> = {
  user: 'User',
  assistant: 'Assistant',
  system: 'System',
};

function buildSessionMarkdown(task: TaskRow, msgs: MessageRow[]): string {
  const lines: string[] = [];

  lines.push(`# ${task.title || 'Untitled Session'}`);
  lines.push('');
  lines.push(`**Created:** ${formatTimestamp(task.createdAt)}`);
  if (task.model) {
    const provider = task.modelProvider ? ` (${task.modelProvider})` : '';
    lines.push(`**Model:** ${task.model}${provider}`);
  }
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of msgs) {
    const label = ROLE_LABEL[msg.role] ?? msg.role;
    lines.push(`## ${label}`);
    lines.push(`*${formatTimestamp(msg.timestamp)}*`);
    lines.push('');
    lines.push(msg.content);

    if (msg.toolCalls) {
      let calls: { name?: string; status?: string }[] = [];
      try {
        calls = JSON.parse(msg.toolCalls as string);
      } catch {}
      if (calls.length > 0) {
        lines.push('');
        lines.push('<details>');
        lines.push('<summary>Tool Calls</summary>');
        lines.push('');
        for (const tc of calls) {
          const status = tc.status ? ` [${tc.status}]` : '';
          lines.push(`- \`${tc.name ?? 'unknown'}\`${status}`);
        }
        lines.push('');
        lines.push('</details>');
      }
    }

    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
