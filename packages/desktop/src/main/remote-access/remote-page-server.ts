import { randomUUID } from 'node:crypto';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { resolve as resolvePath, basename, extname, sep } from 'node:path';
import { getWorkspacePath, readConfig } from '../workspace/config.js';
import { getSqlite } from '../db/index.js';
import { getKbRuntime } from '../kb/runtime.js';
import { getCommercialClient } from '../commercial/client.js';
import { collectDashboardData } from '../stats/aggregate.js';
import { getGatewayClient } from '../ws/index.js';
import { readProfileMirror } from '../ipc/profile-handlers.js';
import { generateDocumentsFromMessage } from '../docgen/generate.js';
import { readQuotaSnapshot } from '../commercial/auth.js';
import { captureTaskArtifactBaseline, reconcileTaskArtifacts } from '../artifact/reconcile.js';
import { createVoiceRelayClient } from '../voice/relay-client.js';
import { activeRelayBaseUrl } from '../commercial/relay-config.js';
import { getActiveRelayKey } from '../commercial/relay-key.js';
import { getLicenseGeneration } from '../commercial/license-generation.js';
import { isVoiceRequestId, parseTaskIdFromSessionKey } from '@clawwork/shared';
import { mobileInstallBundledSkill, mobileListBundledSkills, mobileRemoveBundledSkill } from '../skills/handlers.js';

/**
 * 远程页入口服务（技术方案 v1.1 §4.2 / §5.2，frp 版）。
 *
 * 一个 loopback 端口上做两件事，保证"设备页与网关同源"：
 *   1. `/app/*`  → 静态资源（`resources/app-remote/`，随包发版，`no-store`）
 *   2. 其余路径   → 反向代理到本机网关 `127.0.0.1:18789`（含 HTTP 与 WebSocket upgrade）
 *
 * 为什么需要它：网关只监听 loopback，隧道（frpc）只能连一个本地端口；
 * 手机要的是"同一个 host 下的页面 + API + WS"，所以必须有一个同源入口把
 * 静态页和网关拼在一起，否则 `controlUi.allowedOrigins` 与 CORS 都不成立。
 *
 * ⚠️ 只绑 loopback。公网可达性是隧道的事，这个进程永远不该被外部直连。
 */

export interface RemotePageServerOptions {
  /** `resources/app-remote/` 的绝对路径。缺目录时服务仍启动，`/app/` 返回 503 说明未打包。 */
  pageRoot: string;
  /** 本机网关 origin，例如 `http://127.0.0.1:18789`。 */
  gatewayOrigin: string;
  /** 默认 127.0.0.1。 */
  host?: string;
  /** 首选端口，默认 18780；占用则顺延到 maxPort。 */
  port?: number;
  maxPort?: number;
  logger?: (event: string, data?: Record<string, unknown>) => void;
}

const APP_PREFIX = '/app/';
const APP_BARE = '/app';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * 把 URL 路径解析成 pageRoot 下的绝对路径；SPA 路由（无扩展名）回落到 index.html。
 *
 * 导出的目的：路径穿越这类判断值得单独钉住（`..`、编码后的 `%2e%2e`、绝对路径注入）。
 * 三种结果分开表达，调用方才分得清"越界"（403）和"没有这个文件"（404）。
 */
export type StaticResolution = { kind: 'file'; filePath: string } | { kind: 'not-found' } | { kind: 'forbidden' };

export function resolveStaticPath(pageRoot: string, pathname: string): StaticResolution {
  const root = resolvePath(pageRoot);
  // `/m/*` 是 `/app/*` 的别名：Service Worker 的 scope 是 `/app/`，
  // 手机上装了旧版本后，`/app/` 会被缓存版 index.html 接管、新代码进不去。
  // `/m/` 不在那个 scope 里，用来做"绕过旧 SW"的调试入口。
  const normalizedPath = pathname.startsWith('/m/') ? `${APP_PREFIX}${pathname.slice('/m/'.length)}` : pathname;
  pathname = normalizedPath;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: 'forbidden' };
  }

  const relativeRaw = decoded.startsWith(APP_PREFIX) ? decoded.slice(APP_PREFIX.length) : '';
  const relative = relativeRaw.replace(/^\/+/, '');

  // 越界判定放在 SPA 回落之前：`/app/../x` 这种没有扩展名的路径会被当成前端路由，
  // 先吞下来就等于把穿越请求洗白了。
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '..') || relative.includes('\\')) {
    return { kind: 'forbidden' };
  }

  // SPA 路由：`/app/chat` 这类没有扩展名的路径交给前端路由处理。
  const isSpaRoute = !relative || extname(relative) === '';
  const target = isSpaRoute ? 'index.html' : relative;

  const candidate = resolvePath(root, target);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    return { kind: 'forbidden' };
  }

  try {
    if (!statSync(candidate).isFile()) return { kind: 'not-found' };
  } catch {
    return { kind: 'not-found' };
  }
  return { kind: 'file', filePath: candidate };
}
/**
 * 语音 relay 客户端（懒建）：手机端转写走主进程这个实例，
 * relay 密钥与 license 只活在主进程，手机端不接触。
 */
let voiceRelayClient: ReturnType<typeof createVoiceRelayClient> | null = null;
function getVoiceRelayClient(): ReturnType<typeof createVoiceRelayClient> {
  if (!voiceRelayClient) {
    voiceRelayClient = createVoiceRelayClient({
      baseUrl: activeRelayBaseUrl,
      relayKey: getActiveRelayKey,
      generation: getLicenseGeneration,
      fetch: (...args) => fetch(...args),
    });
  }
  return voiceRelayClient;
}

export class RemotePageServer {
  private readonly pageRoot: string;
  private readonly gatewayHost: string;
  private readonly gatewayPort: number;
  private readonly host: string;
  private readonly preferredPort: number;
  private readonly maxPort: number;
  private readonly logger?: RemotePageServerOptions['logger'];

  private server?: Server;
  private boundPort = 0;
  private readonly sockets = new Set<Socket>();

  constructor(options: RemotePageServerOptions) {
    this.pageRoot = options.pageRoot;

    const upstream = new URL(options.gatewayOrigin);
    this.gatewayHost = upstream.hostname;
    this.gatewayPort = Number(upstream.port || (upstream.protocol === 'https:' ? 443 : 80));

    this.host = options.host ?? '127.0.0.1';
    this.preferredPort = options.port ?? 18780;
    this.maxPort = options.maxPort ?? 18799;
    this.logger = options.logger;
  }

  get port(): number {
    return this.boundPort;
  }

  async start(): Promise<number> {
    if (this.server) return this.boundPort;

    const server = createServer((req, res) => {
      void this.handle(req, res);
    });

    server.on('upgrade', (req, socket, head) => {
      this.handleUpgrade(req, socket as Socket, head);
    });

    server.on('connection', (socket) => {
      this.sockets.add(socket);
      socket.on('close', () => this.sockets.delete(socket));
    });

    let lastError: unknown;
    for (let port = this.preferredPort; port <= this.maxPort; port += 1) {
      try {
        await this.listen(server, port);
        this.server = server;
        this.boundPort = port;
        this.logger?.('remote.page.listening', { host: this.host, port, pageRoot: this.pageRoot });
        return port;
      } catch (err) {
        lastError = err;
        if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') break;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('remote page server failed to bind');
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;

    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // keep-alive / 已升级的连接不一定受 close 管，兜底断掉再来一次。
      server.closeAllConnections?.();
      const timer = setTimeout(resolve, 500);
      timer.unref?.();
    });
    this.logger?.('remote.page.closed', { port: this.boundPort });
    this.boundPort = 0;
  }

  private listen(server: Server, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, this.host);
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const rawUrl = req.url ?? '/';
    const pathname = rawUrl.split('?')[0] ?? '/';

    if (pathname === APP_BARE) {
      const query = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
      res.writeHead(301, { Location: `${APP_BARE}/${query}` });
      res.end();
      return;
    }

    if (pathname === '/m') {
      const query = rawUrl.includes('?') ? rawUrl.slice(rawUrl.indexOf('?')) : '';
      res.writeHead(301, { Location: `/m/${query}` });
      res.end();
      return;
    }

    if (pathname.startsWith(APP_PREFIX) || pathname.startsWith('/m/')) {
      this.serveStatic(req, res, pathname);
      return;
    }

    // 手机端要的工作区浏览/下载：走同一个 host，省得再开一条隧道。
    if (pathname.startsWith('/api/mobile/')) {
      await this.handleMobileApi(req, res, pathname, rawUrl);
      return;
    }

    this.proxyHttp(req, res);
  }

  /** 读 POST 的 JSON body（体积小，直接拼字符串即可）。 */
  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (chunk) => {
        data += chunk;
      });
      req.on('end', () => resolve(data));
    });
    try {
      return JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  /** 手机端 API 的鉴权：用网关 token（手机端配对时本来就拿到了）。 */
  private mobileAuthorized(req: IncomingMessage): boolean {
    const token = String(req.headers['x-gateway-token'] ?? '');
    if (!token) return false;
    const expected = readConfig()?.gateways?.find((gateway) => gateway.id === 'local-runtime')?.token;
    return Boolean(expected) && token === expected;
  }

  /**
   * `/api/mobile/files?path=<相对工作区路径>`   → 目录列表
   * `/api/mobile/files/download?path=<...>`     → 文件流
   *
   * 只允许在工作区根目录内读写：`resolve` 之后必须仍以工作区为前缀，
   * 否则 `../../` 就能翻到系统盘。
   */
  private async handleMobileApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
    rawUrl: string,
  ): Promise<void> {
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };

    // 原生壳（Capacitor）页面 origin 是 https://localhost，调远程 API 属跨域：
    // 不放行就会变成"请求打不到"，或浏览器直接拦下来（真机上是 JSON 解析报错）。
    const origin = String(req.headers.origin ?? '');
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'x-gateway-token, content-type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 技能装/卸是写操作，只允许 POST；其余接口是只读。
    const writeApis = new Set([
      '/api/mobile/skills/install',
      '/api/mobile/skills/remove',
      '/api/mobile/community/post',
      '/api/mobile/market/create',
      '/api/mobile/cron/action',
      '/api/mobile/docgen',
      '/api/mobile/artifacts/sync',
      '/api/mobile/teams/create',
      '/api/mobile/voice/transcribe',
    ]);
    const isSkillWrite = writeApis.has(pathname);
    const expectedMethod = isSkillWrite ? 'POST' : null;
    if (expectedMethod ? req.method !== expectedMethod : req.method !== 'GET' && req.method !== 'HEAD') {
      json(405, { error: 'method not allowed' });
      return;
    }
    if (!this.mobileAuthorized(req)) {
      json(401, { error: 'unauthorized' });
      return;
    }

    const root = getWorkspacePath();
    if (!root) {
      json(503, { error: 'workspace not configured' });
      return;
    }

    const url = new URL(rawUrl, 'http://127.0.0.1');
    const relativePath = url.searchParams.get('path') ?? '';
    const rootResolved = resolvePath(root);
    const target = resolvePath(rootResolved, relativePath);
    const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : `${rootResolved}${sep}`;
    if (target !== rootResolved && !target.startsWith(rootPrefix)) {
      json(403, { error: 'path escapes workspace' });
      return;
    }

    let stat;
    try {
      stat = statSync(target);
    } catch {
      json(404, { error: 'not found' });
      return;
    }

    if (pathname === '/api/mobile/files') {
      if (!stat.isDirectory()) {
        json(400, { error: 'not a directory' });
        return;
      }
      const entries = readdirSync(target, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => {
          const full = resolvePath(target, entry.name);
          let size = 0;
          let mtime = 0;
          try {
            const info = statSync(full);
            size = info.size;
            mtime = info.mtimeMs;
          } catch {
            /* 权限/竞态：仍列出但没大小 */
          }
          return { name: entry.name, isDir: entry.isDirectory(), size, mtime };
        })
        .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      json(200, { path: relativePath, entries });
      return;
    }

    // 任务产物（桌面端「文件管理」展示的就是这些，不是工作区目录树）
    /**
     * 手机端语音转写（2026-10-22）：手机录音（16kHz PCM WAV base64）POST 上来，
     * 主进程走与桌面端语音同一套 relay ASR（中文识别好、任何手机系统可用——
     * 不依赖 Android 系统语音引擎，小米等 ROM 停用语音服务也能用）。
     * 参数与桌面端 voice:transcribe IPC 同形状（requestId 幂等身份）。
     */
    if (req.method === 'POST' && pathname === '/api/mobile/voice/transcribe') {
      const body = await this.readJsonBody(req);
      const audio = typeof body.audio === 'string' ? body.audio : null;
      const requestId = typeof body.requestId === 'string' ? body.requestId : null;
      if (audio === null || requestId === null || !isVoiceRequestId(requestId)) {
        json(400, { error: 'voice-invalid-request' });
        return;
      }
      let wav: Buffer;
      try {
        wav = Buffer.from(audio, 'base64');
      } catch {
        json(400, { error: 'voice-invalid-audio' });
        return;
      }
      if (wav.length < 46 || wav.length > 44 + 16000 * 2 * 60) {
        json(400, { error: 'voice-invalid-audio' });
        return;
      }
      try {
        const transcript = await getVoiceRelayClient().transcribe(wav, requestId, new AbortController().signal);
        json(200, { transcript });
      } catch (err) {
        const msg = err instanceof Error && /^voice-[a-z-]+$/.test(err.message) ? err.message : 'voice-upstream-error';
        json(502, { error: msg });
      }
      return;
    }

    /**
     * 手机端文档生成（docgen）。
     *
     * 为什么需要：模型回复里带的 ```` ```docgen {...} ```` 块要由**客户端**渲染成 .docx，
     * 手机（PWA）没有 Electron 的渲染管线 ⇒ 真机现象是"AI 早就回完了，屏幕上一大坨 JSON，
     * 产物栏永远空着"。这里把渲染收到主进程：手机把那条消息的正文发过来，
     * 主进程用桌面端同一套 docgen 生成器出文件并入库，手机再去产物页下载。
     */
    if (req.method === 'POST' && pathname === '/api/mobile/docgen') {
      const body = await readJsonBody(req).catch(() => null);
      const sessionKey = typeof body?.sessionKey === 'string' ? body.sessionKey : '';
      const content = typeof body?.content === 'string' ? body.content : '';
      const taskId = parseTaskIdFromSessionKey(sessionKey);
      const workspacePath = getWorkspacePath();
      if (!taskId || !workspacePath) {
        json(400, { error: 'invalid sessionKey or workspace' });
        return;
      }
      /*
       * ⚠️ 手机端拿到的 `message.content` 可能是**序列化后的数组**（`[{"type":"text","text":"…"}]`），
       * 直接丢给 extractDocgenBlocks 会一个块都认不出来（真机实测：接口 200、saved 空、产物页永远空）。
       * 这里统一抽成纯文本。
       */
      ensureTaskRow(taskId, sessionKey);
      const plain = extractPlainText(content);
      const messageId = typeof body?.messageId === 'string' && body.messageId ? body.messageId : `mobile-${Date.now()}`;
      ensureMessageRow(taskId, messageId, plain);
      if (!plain.includes('docgen')) {
        json(400, { error: 'no docgen block' });
        return;
      }
      try {
        const result = await generateDocumentsFromMessage({
          workspacePath,
          taskId,
          messageId,
          content: plain,
          skipPptx: true,
        });
        json(200, { saved: result.saved, failed: result.failed });
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : 'docgen failed' });
      }
      return;
    }

    /**
     * 手机端主动触发产物对账：把任务工作区里新写出来的文件登记进 artifacts 表。
     *
     * 默认对账发生在桌面端打开产物面板/同步会话时；手机跑的任务没人点那个面板，
     * 于是"文件明明生成了，产物页却是空的"。
     */
    if (req.method === 'POST' && pathname === '/api/mobile/artifacts/sync') {
      const body = await readJsonBody(req).catch(() => null);
      const sessionKey = typeof body?.sessionKey === 'string' ? body.sessionKey : '';
      const taskId = parseTaskIdFromSessionKey(sessionKey);
      const workspacePath = getWorkspacePath();
      if (!taskId || !workspacePath) {
        json(400, { error: 'invalid sessionKey or workspace' });
        return;
      }
      ensureTaskRow(taskId, sessionKey);
      try {
        const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId });
        const result = await reconcileTaskArtifacts({
          workspacePath,
          taskId,
          messageId: `mobile-sync-${Date.now()}`,
          baseline,
        });
        json(200, { ok: true, saved: result.saved.length, updated: result.updated.length });
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : 'sync failed' });
      }
      return;
    }

    if (pathname === '/api/mobile/artifacts') {
      const sqlite = getSqlite();
      if (!sqlite) {
        json(503, { error: 'database not ready' });
        return;
      }
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 100) || 100, 300);
      const rows = sqlite
        .prepare(
          `SELECT a.id, a.task_id AS taskId, a.name, a.size, a.mime_type AS mimeType,
                  a.created_at AS createdAt, a.local_path AS localPath, t.title AS taskTitle
             FROM artifacts a LEFT JOIN tasks t ON t.id = a.task_id
            ORDER BY a.created_at DESC LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;
      json(200, {
        artifacts: rows.map((row) => ({ ...row, localPath: undefined })),
      });
      return;
    }

    if (pathname === '/api/mobile/artifacts/download') {
      const sqlite = getSqlite();
      if (!sqlite) {
        json(503, { error: 'database not ready' });
        return;
      }
      const id = url.searchParams.get('id') ?? '';
      const row = sqlite.prepare('SELECT local_path AS localPath, name, root FROM artifacts WHERE id = ?').get(id) as
        | { localPath: string; name: string; root?: string }
        | undefined;
      if (!row?.localPath) {
        json(404, { error: 'artifact not found' });
        return;
      }

      // ⚠️ `local_path` 是**相对路径**（`<taskId>/<file>`），相对 workspace 或该助手的工作区。
      //    直接 statSync 相对路径必然 404（真机反馈"点文件就 404"）。
      const base = getWorkspacePath();
      if (!base) {
        json(503, { error: 'workspace not configured' });
        return;
      }
      const baseResolved = resolvePath(base);
      const candidates = [resolvePath(baseResolved, row.localPath)];
      if (row.root === 'agent') {
        // 助手工作区在 workspace 下的 `partner-w-agents/<agentId>/`，宽一点多试两处。
        const segments = row.localPath.split(/[\\/]/).filter(Boolean);
        if (segments.length > 1) {
          candidates.push(resolvePath(baseResolved, 'partner-w-agents', ...segments));
        }
      }
      const full = candidates.find((candidate) => {
        if (candidate !== baseResolved && !candidate.startsWith(`${baseResolved}${sep}`)) return false;
        try {
          return statSync(candidate).isFile();
        } catch {
          return false;
        }
      });
      if (!full) {
        json(404, { error: 'file missing on disk' });
        return;
      }
      try {
        const info = statSync(full);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(info.size),
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`,
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        createReadStream(full).pipe(res);
      } catch {
        json(404, { error: 'file missing on disk' });
      }
      return;
    }

    // 身份画像（与桌面端同一份镜像文件；没走过引导时为 null）
    if (pathname === '/api/mobile/profile') {
      json(200, { profile: readProfileMirror() });
      return;
    }

    // 使用概览：直接用桌面端 Dashboard 的聚合器，字段天然一致
    /**
     * 积分快照（手机端「本轮消耗 / 本次任务累计」的取数口）。
     *
     * 手机没有桌面那条 `commercial:quota-snapshot` IPC，但两侧读的必须是**同一本账**，
     * 所以这里直接转调主进程那一个函数；手机端自己按"上一轮余额 - 这一轮余额"算差分。
     */
    if (pathname === '/api/mobile/quota') {
      try {
        const snapshot = await readQuotaSnapshot();
        json(200, snapshot);
      } catch (err) {
        json(500, { ok: false, error: err instanceof Error ? err.message : 'quota failed' });
      }
      return;
    }

    /**
     * 手机端建团队 —— 对齐桌面端「创建团队」向导的**执行段**（图：团队信息 → 智能体 → 确认创建）。
     *
     * 三件事缺一不可（少哪件都会"两端都看不到这个团队"）：
     *   1. `agents.create` 建 agent（id 必须 `[a-z0-9]`，中文名走 FNV-1a 兜底，与桌面端 `toSlug` 同规则）
     *   2. `agents.files.set` 写 `IDENTITY.md`
     *   3. **写 `teams` / `team_agents` 两张表** —— 团队列表（含手机端 `/api/mobile/teams`）
     *      读的就是这两张表；只建 agent 不写表，界面上永远没有这个团队。
     */
    if (req.method === 'POST' && pathname === '/api/mobile/teams/create') {
      const sqlite = getSqlite();
      const body = await readJsonBody(req).catch(() => null);
      const teamName = typeof body?.teamName === 'string' ? body.teamName.trim() : '';
      const rawMembers = Array.isArray(body?.members) ? body.members : [];
      if (!sqlite) {
        json(503, { error: 'database not ready' });
        return;
      }
      if (!teamName || rawMembers.length === 0) {
        json(400, { error: 'teamName and members are required' });
        return;
      }
      const gw = getGatewayClient('local-runtime');
      if (!gw?.isConnected) {
        json(503, { error: 'gateway not connected' });
        return;
      }

      /*
       * 名字 → agent id。**不能保留中文**：网关会拒（实测报 `Agent name "负责人" has no valid
       * id characters`）。与桌面端 `toSlug` 同一套规则：非 [a-z0-9] 折叠成 '-'，
       * 全被折掉时用名字的 FNV-1a 哈希兜底（同名字同结果，不同名字不同结果）。
       */
      const nameSuffix = (value: string): string => {
        let h = 2166136261;
        for (let i = 0; i < value.length; i += 1) {
          h ^= value.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36);
      };
      const toSlug = (value: string): string => {
        const slug = value
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 64)
          .replace(/-$/, '');
        return slug || `agent-${nameSuffix(value.trim())}`;
      };

      const now = new Date().toISOString();
      const description = typeof body?.description === 'string' ? body.description.trim() : '';
      const emoji = typeof body?.emoji === 'string' ? body.emoji.trim().slice(0, 8) : '';

      /*
       * ⚠️ **同名团队复用，不新建**。
       * 之前每点一次「创建团队」就往 teams 插一行 —— 用户反复点几次，团队列表里
       * 会堆出好几张同名的卡（其中很多是 0 成员的失败残留）。
       */
      const existingTeam = sqlite
        .prepare("SELECT id FROM teams WHERE name = ? AND gateway_id = 'local-runtime' LIMIT 1")
        .get(teamName) as { id?: string } | undefined;
      const teamReused = typeof existingTeam?.id === 'string';
      const teamId = teamReused ? (existingTeam!.id as string) : randomUUID();

      try {
        if (teamReused) {
          sqlite
            .prepare('UPDATE teams SET description = ?, emoji = ?, updated_at = ? WHERE id = ?')
            .run(description || null, emoji || null, now, teamId);
        } else {
          sqlite
            .prepare(
              `INSERT INTO teams (id, name, emoji, description, gateway_id, source, version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 'local', '1.0.0', ?, ?)`,
            )
            .run(teamId, teamName, emoji, description, 'local-runtime', now, now);
        }
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : 'team insert failed' });
        return;
      }

      /*
       * ⚠️ 先拉一次已有 agent。中文名会哈希成**固定 id**（「负责人」永远得到同一个 slug），
       *    所以"同一个名字再建一次"必然撞 `already exists` —— 用户看到的就是满屏红字。
       *    正确语义：**已存在就复用**（桌面的 `createAgentWithRollback` 也是这个口径），
       *    然后把这位成员照常挂到新团队下。
       */
      const existingAgentIds = new Set<string>();
      try {
        const listed = (await gw.listAgents()) as unknown as {
          agents?: Array<{ id?: string; name?: string }>;
          result?: { agents?: Array<{ id?: string; name?: string }> };
        };
        const list = listed.agents ?? listed.result?.agents ?? [];
        for (const agent of list) {
          if (typeof agent?.id === 'string') existingAgentIds.add(agent.id);
        }
      } catch {
        /* 拉不到就当没有：最坏结果还是报 already exists，不会误删东西 */
      }

      const results: Array<{ name: string; agentId?: string; ok: boolean; reused?: boolean; error?: string }> = [];
      const usedIds = new Set<string>();
      for (const raw of rawMembers) {
        const member = raw as {
          name?: unknown;
          identity?: unknown;
          position?: unknown;
          role?: unknown;
          skills?: unknown;
        };
        const displayName = typeof member.name === 'string' ? member.name.trim() : '';
        if (!displayName) continue;
        const position = typeof member.position === 'string' ? member.position.trim() : displayName;
        const isCoordinator = member.role === 'coordinator';
        const rawSkills = Array.isArray(member.skills) ? member.skills : [];
        const skills: string[] = rawSkills
          .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          .map((s) => s.trim());
        let agentId = toSlug(displayName);
        if (['main', 'openclaw', 'crestodian'].includes(agentId)) agentId = `agent-${agentId}`;
        // 同一批里重名 → 加 -2/-3（与桌面端 withAgentIds 同口径）
        if (usedIds.has(agentId)) {
          let n = 2;
          let candidate = `${agentId}-${n}`;
          while (usedIds.has(candidate)) {
            n += 1;
            candidate = `${agentId}-${n}`;
          }
          agentId = candidate;
        }
        usedIds.add(agentId);

        try {
          let createdId: string | undefined;
          const reused = existingAgentIds.has(agentId);
          if (reused) {
            createdId = agentId;
          } else {
            const created = (await gw.createAgent({ name: agentId, workspace: `agents/${agentId}` })) as {
              agentId?: string;
            };
            createdId = typeof created?.agentId === 'string' ? created.agentId : undefined;
            if (createdId) existingAgentIds.add(createdId);
          }
          const identity = typeof member.identity === 'string' ? member.identity : '';
          if (createdId && identity && !reused) {
            await gw.setAgentFile(createdId, 'IDENTITY.md', identity);
          }
          if (createdId) {
            // ⭐ 手机端团队创建也要能对单个 agent 绑技能（对齐桌面端 AgentDraftCard 的
            //    skills 勾选 → installSkill 落地到该 agent 的 managed 技能目录）。
            const skillErrors: string[] = [];
            for (const slug of skills) {
              try {
                const skillResult = await mobileInstallBundledSkill('local-runtime', slug, createdId);
                if (!skillResult.ok) skillErrors.push(`${slug}: ${skillResult.error ?? 'install failed'}`);
              } catch (err) {
                skillErrors.push(`${slug}: ${err instanceof Error ? err.message : 'install failed'}`);
              }
            }
            sqlite
              .prepare(
                `INSERT OR REPLACE INTO team_agents (team_id, agent_id, role, is_manager, position)
                 VALUES (?, ?, ?, ?, ?)`,
              )
              .run(teamId, createdId, isCoordinator ? 'coordinator' : 'executor', isCoordinator ? 1 : 0, position);
            results.push({
              name: displayName,
              agentId: createdId,
              ok: true,
              reused,
              ...(skillErrors.length > 0 ? { skillWarnings: skillErrors } : {}),
            });
          } else {
            results.push({ name: displayName, agentId: createdId, ok: Boolean(createdId), reused });
          }
        } catch (err) {
          results.push({ name: displayName, ok: false, error: err instanceof Error ? err.message : 'create failed' });
        }
      }

      const succeeded = results.filter((item) => item.ok).length;
      if (succeeded === 0 && !teamReused) {
        // 一个成员都没建成 ⇒ 这张团队卡是纯垃圾，删掉（否则列表里会多一张 0 成员的空卡）
        sqlite.prepare('DELETE FROM team_agents WHERE team_id = ?').run(teamId);
        sqlite.prepare('DELETE FROM teams WHERE id = ?').run(teamId);
        json(200, { teamId: null, teamName, members: results, rollback: true });
        return;
      }
      sqlite.prepare('UPDATE teams SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), teamId);
      json(200, { teamId, teamName, teamReused, members: results });
      return;
    }

    if (pathname === '/api/mobile/dashboard') {
      const sqlite = getSqlite();
      if (!sqlite) {
        json(503, { error: 'database not ready' });
        return;
      }
      try {
        json(200, await collectDashboardData(sqlite));
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : 'dashboard failed' });
      }
      return;
    }

    // 创作者中心：我的模板 / 新建模板
    if (pathname === '/api/mobile/market/templates') {
      const client = getCommercialClient();
      if (!client) {
        json(503, { error: 'not authenticated', errorCode: 'not_authenticated' });
        return;
      }
      const { data, error } = await client.rpc('creator_templates_mine', {});
      if (error) {
        json(502, { error: error.message ?? 'rpc failed' });
        return;
      }
      json(200, { rows: Array.isArray(data) ? data : data == null ? [] : [data] });
      return;
    }

    if (pathname === '/api/mobile/market/create') {
      const body = await this.readJsonBody(req);
      const client = getCommercialClient();
      if (!client) {
        json(503, { error: 'not authenticated', errorCode: 'not_authenticated' });
        return;
      }
      const { data, error } = await client.rpc('creator_template_create', {
        p_name: String(body.name ?? ''),
        p_description: String(body.description ?? ''),
        p_category: String(body.category ?? 'other'),
        p_emoji: String(body.emoji ?? '🧩'),
        p_instructions: String(body.instructions ?? ''),
      });
      if (error) {
        json(502, { error: error.message ?? 'rpc failed' });
        return;
      }
      json(200, { row: Array.isArray(data) ? data[0] : data });
      return;
    }

    // 广场发帖
    if (pathname === '/api/mobile/community/post') {
      const body = await this.readJsonBody(req);
      const client = getCommercialClient();
      if (!client) {
        json(503, { error: 'not authenticated', errorCode: 'not_authenticated' });
        return;
      }
      const { data, error } = await client.rpc('community_post_create', {
        p_body: String(body.body ?? ''),
        p_visibility: String(body.visibility ?? 'team'),
      });
      if (error) {
        json(502, { error: error.message ?? 'rpc failed' });
        return;
      }
      json(200, { row: Array.isArray(data) ? data[0] : data });
      return;
    }

    // 定时任务操作：运行 / 删除 / 启用停用
    if (pathname === '/api/mobile/cron/action') {
      const body = await this.readJsonBody(req);
      const jobId = String(body.jobId ?? '');
      const action = String(body.action ?? '');
      if (!jobId || !action) {
        json(400, { error: 'jobId and action are required' });
        return;
      }
      const client = getGatewayClient('local-runtime');
      if (!client?.isConnected) {
        json(503, { error: 'gateway not connected' });
        return;
      }
      try {
        if (action === 'run') await client.sendReq('cron.run', { jobId });
        else if (action === 'remove') await client.sendReq('cron.remove', { jobId });
        else if (action === 'toggle')
          await client.sendReq('cron.update', { jobId, patch: { enabled: body.enabled === true } });
        else {
          json(400, { error: 'unknown action' });
          return;
        }
        json(200, { ok: true });
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : 'cron action failed' });
      }
      return;
    }

    if (pathname === '/api/mobile/commercial') {
      // 白名单：只放手机端真正需要的几条只读 RPC，参数由这里固定，
      // 不接受客户端传任意 fn/params（那等于把整套后端接口暴露出去）。
      const whitelist: Record<string, { fn: string; params: Record<string, unknown> }> = {
        feed: { fn: 'community_feed', params: { p_limit: 20, p_before: null } },
        members: { fn: 'team_members', params: {} },
        growth: { fn: 'growth_summary', params: {} },
        dailyTasks: { fn: 'daily_task_list', params: {} },
        bounty: { fn: 'bounty_list', params: { p_status: null } },
        market: { fn: 'market_templates', params: { p_limit: 30, p_offset: 0 } },
      };
      const key = url.searchParams.get('fn') ?? '';
      const entry = whitelist[key];
      if (!entry) {
        json(400, { error: 'unknown fn' });
        return;
      }
      const client = getCommercialClient();
      if (!client) {
        json(503, { error: 'not authenticated', errorCode: 'not_authenticated' });
        return;
      }
      try {
        const { data, error } = await client.rpc(entry.fn, entry.params);
        if (error) {
          json(502, { error: error.message ?? 'rpc failed' });
          return;
        }
        json(200, { rows: Array.isArray(data) ? data : data == null ? [] : [data] });
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : 'rpc failed' });
      }
      return;
    }

    if (pathname === '/api/mobile/skills') {
      try {
        json(200, await mobileListBundledSkills('local-runtime'));
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : 'skills failed' });
      }
      return;
    }

    if (pathname === '/api/mobile/skills/install' || pathname === '/api/mobile/skills/remove') {
      const raw = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', (chunk) => {
          data += chunk;
        });
        req.on('end', () => resolve(data));
      });
      let slug = '';
      let agentId: string | undefined;
      try {
        const parsed = JSON.parse(raw || '{}') as { slug?: string; agentId?: string };
        slug = String(parsed.slug ?? '');
        if (typeof parsed.agentId === 'string' && parsed.agentId.trim()) agentId = parsed.agentId.trim();
      } catch {
        json(400, { error: 'invalid json body' });
        return;
      }
      if (!slug) {
        json(400, { error: 'slug is required' });
        return;
      }
      try {
        const result =
          pathname === '/api/mobile/skills/install'
            ? await mobileInstallBundledSkill('local-runtime', slug, agentId)
            : await mobileRemoveBundledSkill('local-runtime', slug, agentId);
        json(200, result);
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : 'skill action failed' });
      }
      return;
    }

    if (pathname === '/api/mobile/teams') {
      const sqlite = getSqlite();
      if (!sqlite) {
        json(503, { error: 'database not ready' });
        return;
      }
      const teams = sqlite
        .prepare(
          'SELECT id, name, emoji, description, gateway_id AS gatewayId, source, updated_at AS updatedAt FROM teams ORDER BY updated_at DESC',
        )
        .all() as Array<Record<string, unknown>>;
      const members = sqlite
        .prepare(
          'SELECT team_id AS teamId, agent_id AS agentId, role, position, is_manager AS isManager FROM team_agents',
        )
        .all() as Array<{ teamId: string; agentId: string; role?: string; position?: string; isManager?: number }>;
      const counts = new Map<string, number>();
      const byTeam = new Map<string, typeof members>();
      for (const member of members) {
        counts.set(member.teamId, (counts.get(member.teamId) ?? 0) + 1);
        const list = byTeam.get(member.teamId) ?? [];
        list.push(member);
        byTeam.set(member.teamId, list);
      }
      json(200, {
        teams: teams.map((team) => ({
          ...team,
          memberCount: counts.get(String(team.id)) ?? 0,
          members: byTeam.get(String(team.id)) ?? [],
        })),
      });
      return;
    }

    if (pathname === '/api/mobile/kb') {
      const runtime = getKbRuntime();
      if (!runtime) {
        json(200, { ready: false, stats: null, sources: [] });
        return;
      }
      try {
        json(200, { ready: true, stats: runtime.service.getStats(), sources: runtime.service.listSources() });
      } catch (err) {
        json(500, { error: err instanceof Error ? err.message : 'kb failed' });
      }
      return;
    }

    if (pathname === '/api/mobile/files/download') {
      if (!stat.isFile()) {
        json(400, { error: 'not a file' });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(stat.size),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(basename(target))}`,
        'Cache-Control': 'no-store',
      });
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      createReadStream(target).pipe(res);
      return;
    }

    json(404, { error: 'unknown api' });
  }

  private serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const resolved = resolveStaticPath(this.pageRoot, pathname);

    if (resolved.kind === 'forbidden') {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('forbidden');
      return;
    }

    if (resolved.kind === 'not-found') {
      // 连 index.html 都没有 = 前端包根本没打进来，给一句能指导排查的话；
      // 否则就是普通的"这个资源不存在"。
      const hasBundle = resolveStaticPath(this.pageRoot, `${APP_PREFIX}index.html`).kind === 'file';
      res.writeHead(hasBundle ? 404 : 503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(hasBundle ? 'not found' : 'remote UI bundle is not packaged yet (resources/app-remote missing)');
      return;
    }

    let size: number;
    try {
      size = statSync(resolved.filePath).size;
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('not found');
      return;
    }

    const type = MIME_TYPES[extname(resolved.filePath).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = createReadStream(resolved.filePath);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  private proxyHttp(req: IncomingMessage, res: ServerResponse): void {
    const headers = { ...req.headers } as Record<string, string | string[] | undefined>;

    // ⚠️ 绝不注入 `x-forwarded-*` / `x-real-ip`。
    //    网关一旦看到这类头就要求 `gateway.trustedProxies` 配好、且由代理重建客户端头，
    //    否则直接 403（实测报错：Proxy client attribution is required）。
    //    方案 §2.1 也写明不依赖转发头做信任判定；真实来源查 nginx/frps 日志。
    delete headers['x-forwarded-for'];
    delete headers['x-forwarded-host'];
    delete headers['x-forwarded-proto'];
    delete headers['x-real-ip'];

    const upstream = httpRequest(
      {
        host: this.gatewayHost,
        port: this.gatewayPort,
        method: req.method,
        path: req.url,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );

    upstream.on('error', (err: Error) => {
      this.logger?.('remote.page.proxy.error', { message: err.message });
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      }
      res.end('gateway unreachable');
    });

    req.pipe(upstream);
  }

  private handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const target = netConnect({ host: this.gatewayHost, port: this.gatewayPort });

    const fail = (message: string) => {
      this.logger?.('remote.page.upgrade.error', { message });
      socket.destroy();
      target.destroy();
    };

    target.once('error', (err: Error) => fail(err.message));
    socket.once('error', (err: Error) => fail(err.message));

    target.once('connect', () => {
      const headers: string[] = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`];
      for (const [key, value] of Object.entries(req.headers)) {
        const lower = key.toLowerCase();
        // 同 proxyHttp：网关看到 forwarded 头就要求 trustedProxies，否则 403。
        if (lower.startsWith('x-forwarded-') || lower === 'x-real-ip') continue;
        if (Array.isArray(value)) {
          for (const entry of value) headers.push(`${key}: ${entry}`);
        } else if (value !== undefined) {
          headers.push(`${key}: ${value}`);
        }
      }
      headers.push('', '');
      target.write(headers.join('\r\n'));
      if (head?.length) target.write(head);

      // 两端必须互相关联：一端断开就拆另一端，否则网关侧会留下永远不断的半开连接。
      socket.once('close', () => target.destroy());
      target.once('close', () => socket.destroy());

      socket.pipe(target);
      target.pipe(socket);
    });
  }
}

/**
 * 读 JSON 请求体（只给 `/api/mobile/*` 的 POST 用）。
 * 上限 2 MB：docgen 只是一段 JSON 文本，正常几十 KB。
 */
/**
 * 把消息正文抽成纯文本。
 *
 * 网关 `chat.history` 里的 assistant 消息 content 可能是 `[{type:'text',text:'…'}, {type:'thinking',…}]`；
 * 一路传到手机再传回来时，有的路径会把它 JSON.stringify 成字符串。
 * docgen 块的识别依赖真实换行和反引号，所以这里统一摊平。
 */
/**
 * 保证 `tasks` 表里有这一行。
 *
 * 为什么：`artifacts.task_id` 有外键指向 `tasks.id`。手机 App 建的任务只活在网关里，
 * 桌面端的任务列表还没登记它 —— 于是产物保存直接 `FOREIGN KEY constraint failed`
 * （真机表现：AI 回复正常，产物栏永远空）。
 */
function ensureTaskRow(taskId: string, sessionKey: string): void {
  const sqlite = getSqlite();
  if (!sqlite) return;
  try {
    const now = new Date().toISOString();
    const row = sqlite.prepare('SELECT 1 AS ok FROM tasks WHERE id = ?').get(taskId);
    if (!row) {
      const fallbackGateway = sqlite
        .prepare('SELECT gateway_id AS gid FROM tasks ORDER BY updated_at DESC LIMIT 1')
        .get() as { gid?: string } | undefined;
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO tasks (id, session_key, title, status, created_at, updated_at, gateway_id)
           VALUES (?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(taskId, sessionKey, '手机任务', now, now, fallbackGateway?.gid ?? 'local');
    }
  } catch {
    /* 登记失败就让后续 FK 失败照常暴露，不吞成静默 */
  }
}

/**
 * 保证 `messages` 表里有这一行。
 *
 * `artifacts.message_id` 也是外键（`REFERENCES messages(id)`）—— 只补 tasks 行，
 * docgen 保存照样 `FOREIGN KEY constraint failed`（这就是"手机出文档永远失败"的第二层原因）。
 */
function ensureMessageRow(taskId: string, messageId: string, content: string): void {
  const sqlite = getSqlite();
  if (!sqlite) return;
  try {
    const row = sqlite.prepare('SELECT 1 AS ok FROM messages WHERE id = ?').get(messageId);
    if (row) return;
    sqlite
      .prepare(
        `INSERT OR IGNORE INTO messages (id, task_id, role, content, timestamp)
         VALUES (?, ?, 'assistant', ?, ?)`,
      )
      .run(messageId, taskId, content.slice(0, 20000), new Date().toISOString());
  } catch {
    /* 同上：不静默吞掉真实错误 */
  }
}

function extractPlainText(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return raw;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const parts = Array.isArray(parsed) ? parsed : [parsed];
    const texts = parts
      .map((part) =>
        part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .filter(Boolean);
    return texts.length > 0 ? texts.join('\n') : raw;
  } catch {
    return raw;
  }
}

function readJsonBody(req: IncomingMessage, limit = 2 * 1024 * 1024): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null);
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}
