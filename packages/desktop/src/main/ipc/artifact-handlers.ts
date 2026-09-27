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
import { resolveAgentWorkspace } from '../artifact/agent-workspace.js';
import { copyArtifactToDestination, inspectArtifactFile, readVerifiedArtifactFile } from '../artifact/access.js';
import { getGatewayClient } from '../ws/index.js';
import { parseAgentIdFromSessionKey } from '@clawwork/shared';
import {
  ArtifactTooLargeError,
  MAX_PLAIN_BINARY_SOURCE_BYTES,
  MAX_PLAIN_TEXT_SOURCE_BYTES,
} from '../artifact/too-large.js';
import { trackOnSuccess } from '../analytics/reporter.js';
import { buildArtifactPreview, previewKindFor } from '../preview/build-preview.js';

interface SaveParams {
  taskId: string;
  sourcePath: string;
  messageId: string;
  fileName?: string;
  mediaType?: string;
}

const MAX_THUMBNAIL_SOURCE_BYTES = 10 * 1024 * 1024;
/**
 * 预览能读多大的源文件。
 *
 * ⚠️ 上限是**为了 IPC**：预览要把内容（PDF 还要 base64）从主进程搬到渲染进程，
 *    几十兆的文件搬过去会让界面卡住。超了就**如实说"太大，用系统程序打开"**，
 *    不许假装读过。
 */
const MAX_PREVIEW_SOURCE_BYTES = 40 * 1024 * 1024;

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
      // ⚠️ **逐行按它自己的根算**：一个任务会同时挂两批产物（应用根 + 助手根），
      //    拿同一个目录去算另一批的 availability 会让它们全变成 `missing`（界面上一片红）。
      return {
        ok: true,
        result: await Promise.all(
          rows.map(async (row) => {
            const rootPath = await rootForArtifact(row);
            return {
              ...row,
              availability: rootPath ? getArtifactAvailability(row.localPath, rootPath) : 'missing',
            };
          }),
        ),
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
      const rootPath = await rootForArtifact(rows[0]);
      return {
        ok: true,
        result: {
          ...rows[0],
          availability: rootPath ? getArtifactAvailability(rows[0].localPath, rootPath) : 'missing',
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle('artifact:save-as', async (_event, params: { artifactId: string; taskId?: string }) => {
    try {
      const artifact = loadArtifactForAction(params.artifactId, params.taskId);
      if (!artifact) return { ok: false, error: 'artifact not found' };
      // ⚠️ 根**在拿到 artifact 之后**才解析：`root:'agent'` 的行要按助手工作区解析，
      //    而不是应用工作区（解析不到就是 `workspace not configured`，不回落）。
      const rootPath = await rootForArtifact(artifact);
      if (!rootPath) return { ok: false, error: 'workspace not configured' };
      const win = BrowserWindow.getAllWindows()[0];
      const options = { defaultPath: artifact.name };
      const choice = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) {
        // ⚠️ 取消保存对话框也返回 ok:true（与 `context:import-files` 同一个坑）：
        //    「打开对话框又关掉」不算一次 artifact_saved。
        return { ok: true, result: { status: 'cancelled' as const } };
      }
      const result = await copyArtifactToDestination(rootPath, artifact.localPath, choice.filePath);
      return trackOnSuccess({ ok: true, result }, 'artifact_saved');
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
    }
  });

  /**
   * **朴素读法**：整份读出来给界面（文本进高亮 / 图片进 `<img>`）。
   *
   * ⚠️ 它现在是 `artifact:preview` 的**兜底**：富预览认不出（或 HTML 超了
   *    `MAX_HTML_PREVIEW_BYTES`）就掉到这里。所以上限**必须**在这条路上也判 ——
   *    否则"太大所以不给富预览"会变成"太大所以整份进高亮"，比不给预览还糟。
   *
   * ⚠️ 超限回的是 `{ tooLarge, size }` 而**不是** `{ ok: false }`：
   *    文件是好的，是我们不肯搬 —— 这两件事在界面上要说两句不同的话。
   */
  ipcMain.handle('artifact:read-file', async (_event, params: { artifactId: string; taskId?: string }) => {
    try {
      const artifact = loadArtifactForAction(params.artifactId, params.taskId);
      if (!artifact) return { ok: false, error: 'artifact not found' };
      const rootPath = await rootForArtifact(artifact);
      if (!rootPath) return { ok: false, error: 'workspace not configured' };
      const isText = isTextFile(artifact.localPath);
      const encoding = isText ? 'utf-8' : 'base64';
      const maxBytes = isText ? MAX_PLAIN_TEXT_SOURCE_BYTES : MAX_PLAIN_BINARY_SOURCE_BYTES;
      let buffer: Buffer;
      try {
        buffer = await readVerifiedArtifactFile(rootPath, artifact.localPath, { maxBytes });
      } catch (err) {
        if (err instanceof ArtifactTooLargeError) return { ok: true, result: { tooLarge: true, size: err.size } };
        throw err;
      }
      const content = buffer.toString(encoding);
      return { ok: true, result: { content, encoding } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  /**
   * **富预览**：把"我们能生成的那些文件"读成界面能直接渲染的形状。
   *
   * 为什么需要它：我们自己就产 `.docx` / `.xlsx` / `.pptx`（docgen），而 `FilePreview`
   * 只认图片 / Markdown / 代码 ⇒ **用户做完一份东西，在应用里看不见它**，只能导出去用 Office 开。
   *
   * ⚠️ 读**全在主进程**：`exceljs` 本来就跑在这儿（打包态那套传递依赖的坑也是在这儿修的，
   *    见 [[pnpm-flattening-drops-nested-deps]]），渲染进程再引一遍等于在新位置重踩一遍。
   * ⚠️ 一律**只读**、**不落临时文件**（红线：不许写到工作区外面）。
   */
  ipcMain.handle('artifact:preview', async (_event, params: { artifactId: string; taskId?: string }) => {
    try {
      const artifact = loadArtifactForAction(params.artifactId, params.taskId);
      if (!artifact) return { ok: false, error: 'artifact not found' };
      // ⚠️ **先问认不认得出，再决定读不读**：认不出就直接回 `unsupported`，
      //    否则每张 5 MB 的 PNG 都要被读进内存再丢掉。
      if (previewKindFor(artifact.name) === null) return { ok: true, result: { kind: 'unsupported' } };
      const rootPath = await rootForArtifact(artifact);
      if (!rootPath) return { ok: false, error: 'workspace not configured' };
      const buffer = await readVerifiedArtifactFile(rootPath, artifact.localPath, {
        maxBytes: MAX_PREVIEW_SOURCE_BYTES,
      });
      return { ok: true, result: await buildArtifactPreview(artifact.name, buffer) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown error';
      return { ok: false, error: msg };
    }
  });

  ipcMain.handle(
    'artifact:thumbnail',
    async (_event, params: { artifactId: string; taskId?: string; size?: number }) => {
      try {
        const artifact = loadArtifactForAction(params.artifactId, params.taskId);
        if (!artifact) return { ok: false, error: 'artifact not found' };
        const rootPath = await rootForArtifact(artifact);
        if (!rootPath) return { ok: false, error: 'workspace not configured' };
        const size = Math.min(Math.max(params.size ?? 128, 32), 256);
        const buffer = await readVerifiedArtifactFile(rootPath, artifact.localPath, {
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
        return trackOnSuccess({ ok: true, result: artifact }, 'artifact_saved');
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
        return trackOnSuccess({ ok: true, result: artifact }, 'artifact_saved');
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
      }
    },
  );

  ipcMain.handle('artifact:open-file', async (_event, params: { artifactId: string; taskId?: string }) => {
    try {
      const artifact = loadArtifactForAction(params.artifactId, params.taskId);
      if (!artifact) return { ok: false, error: 'artifact not found' };
      // ⚠️ 双重 inspect 都按**同一个根**解析（`root:'agent'` 的行用助手工作区）。
      const rootPath = await rootForArtifact(artifact);
      if (!rootPath) return { ok: false, error: 'workspace not configured' };
      const inspected = await inspectArtifactFile(rootPath, artifact.localPath);
      if (inspected.availability !== 'available' || !inspected.absolutePath) {
        return { ok: false, error: `artifact ${inspected.availability}` };
      }
      const revalidated = await inspectArtifactFile(rootPath, artifact.localPath);
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
    try {
      const artifact = loadArtifactForAction(params.artifactId, params.taskId);
      if (!artifact) return { ok: false, error: 'artifact not found' };
      const rootPath = await rootForArtifact(artifact);
      if (!rootPath) return { ok: false, error: 'workspace not configured' };
      const inspected = await inspectArtifactFile(rootPath, artifact.localPath);
      if (inspected.availability !== 'available' || !inspected.absolutePath) {
        return { ok: false, error: `artifact ${inspected.availability}` };
      }
      const revalidated = await inspectArtifactFile(rootPath, artifact.localPath);
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
): Pick<typeof artifacts.$inferSelect, 'id' | 'taskId' | 'name' | 'localPath' | 'root'> | null {
  if (!artifactId) return null;
  const rows = getDb().select().from(artifacts).where(eq(artifacts.id, artifactId)).all();
  const artifact = rows[0];
  if (!artifact || (taskId && artifact.taskId !== taskId)) return null;
  return artifact;
}

/**
 * 某个任务所属**助手的工作区** —— 读不到就是 `null`（**不回落**到应用工作区）。
 *
 * 走 `resolveAgentWorkspace` 的进程内缓存（成功 5 分钟 / 失败 20 秒），
 * 所以同一个任务里逐行调用**不会**重复发 RPC。
 *
 * ⚠️ 这里**只读**，什么都不建：助手工作区是网关的目录。
 */
async function agentWorkspaceForTask(taskId: string): Promise<string | null> {
  try {
    const row = getDb()
      .select({ gatewayId: tasks.gatewayId, sessionKey: tasks.sessionKey })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .all()[0];
    if (!row?.gatewayId || !row.sessionKey) return null;
    return await resolveAgentWorkspace({
      gatewayId: row.gatewayId,
      agentId: parseAgentIdFromSessionKey(row.sessionKey),
      listAgentFiles: (gatewayId, agentId) => {
        const client = getGatewayClient(gatewayId);
        if (!client) return Promise.reject(new Error('gateway client unavailable'));
        return client.listAgentFiles(agentId);
      },
    });
  } catch {
    return null;
  }
}

/**
 * 一条产物该按**哪个目录**解析 —— 看行上的 `root`。
 *
 * ⚠️ `root` 缺省 / 任何认不出的值 ⇒ 应用工作区（**= 加这一列之前的行为**）。
 *
 * ⚠️ 助手根读不到时回 `null`：那一行的 `availability` 会算成 `missing`、卡片按钮全灰。
 *    这是**刻意**的 —— 宁可"这个暂时打不开"，也**不能**拿**别的目录**去解析它
 *    （出错的方向会是"把别的目录的同名文件当成你的产物"）。
 */
async function rootForArtifact(artifact: { taskId: string; root?: string | null }): Promise<string | null> {
  if (artifact.root !== 'agent') return getWorkspacePath() || null;
  return agentWorkspaceForTask(artifact.taskId);
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
