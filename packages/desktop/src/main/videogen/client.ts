import type { VideogenFailure } from '@clawwork/shared';
import type { VideogenRequest } from './request.js';

/**
 * relay 视频端点的客户端（主进程直呼；**不经过网关**）。
 *
 * 为什么不过网关：视频不是 chat completion，网关的 provider 形状装不下"创建异步任务 →
 * 轮询 → 下载"这套生命周期；relay 的三个端点（`/v1/videos` 系）就是为客户端直呼设计的。
 * 身份用的是**同一把 relay key**（激活时写进网关配置的那把，见 `resolveVideogenRelayAuth`）。
 *
 * ⚠️ 隐私/安全纪律：
 *  · 真 key 只进 `Authorization` 头，不上屏、不落日志；
 *  · 上游的文件地址**不出现在**客户端 —— relay 只回自己的 `/v1/videos/:id/file`，
 *    下载走我们自己的域名（端脑的临时存储 URL 是服务端的事）。
 *
 * 本模块无全局状态、fetch 可注入（测试用），超时各自有界。
 */

export const VIDEOGEN_CREATE_TIMEOUT_MS = 30_000;
export const VIDEOGEN_QUERY_TIMEOUT_MS = 15_000;
export const VIDEOGEN_DOWNLOAD_TIMEOUT_MS = 180_000;

export type VideogenCreateResult = { ok: true; taskId: string } | { ok: false; failure: VideogenFailure };

export type VideogenQueryResult =
  | { status: 'running' }
  | {
      status: 'finished';
      outputSeconds: number;
      inputSeconds: number;
      inputImageCount: number;
      resolution: string | null;
    }
  | { status: 'failed'; failure: VideogenFailure };

export type VideogenDownloadResult = { ok: true; buffer: Buffer } | { ok: false; failure: VideogenFailure };

export interface VideogenRelayClient {
  create(request: VideogenRequest): Promise<VideogenCreateResult>;
  query(taskId: string): Promise<VideogenQueryResult>;
  download(taskId: string): Promise<VideogenDownloadResult>;
}

export interface VideogenRelayClientOptions {
  /** relay 基址（含 `/relay` 前缀，与网关配置同源；`activeRelayBaseUrl()` 的输出）。 */
  baseUrl: string;
  relayKey: string;
  fetchImpl?: typeof fetch;
}

type FetchImpl = typeof fetch;

function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** 端脑内容安全拦截码（经 relay 透传）。**零费**——文案要说"改提示词"，不是"重试"。 */
const CONTENT_SAFETY_CODE = 70000;

export function createVideogenRelayClient(options: VideogenRelayClientOptions): VideogenRelayClient {
  const base = trimBase(options.baseUrl);
  const doFetch: FetchImpl = options.fetchImpl ?? fetch;
  const authHeaders = { Authorization: `Bearer ${options.relayKey}` };

  return {
    async create(request: VideogenRequest): Promise<VideogenCreateResult> {
      const url = `${base}/v1/videos`;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'POST',
          headers: { ...authHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({
            prompt: request.prompt,
            duration: request.duration,
            resolution: request.resolution,
            aspectRatio: request.aspectRatio,
          }),
          signal: AbortSignal.timeout(VIDEOGEN_CREATE_TIMEOUT_MS),
        });
      } catch (err) {
        console.warn(
          JSON.stringify({
            event: 'videogen.create-net-error',
            url,
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        return { ok: false, failure: { code: 'videogen-create-failed', httpStatus: 0 } };
      }
      const body = (await res.json().catch(() => null)) as { taskId?: unknown } | null;
      if (!res.ok || typeof body?.taskId !== 'string' || !body.taskId.trim()) {
        // url 无秘密（不含 key）；带上是为 401 类故障定案（2026-10-12 真机 E2E 的现场教训）。
        console.warn(
          JSON.stringify({
            event: 'videogen.create-rejected',
            url,
            status: res.status,
            head: JSON.stringify(body).slice(0, 200),
          }),
        );
        return { ok: false, failure: { code: 'videogen-create-failed', httpStatus: res.status } };
      }
      return { ok: true, taskId: body.taskId.trim() };
    },

    async query(taskId: string): Promise<VideogenQueryResult> {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/videos/${encodeURIComponent(taskId)}`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(VIDEOGEN_QUERY_TIMEOUT_MS),
        });
      } catch {
        // 网络瞬断：调用方（generate 的轮询环）有连续失败计数，单次不给结论。
        return { status: 'failed', failure: { code: 'videogen-task-failed', upstreamCode: null } };
      }
      const body = (await res.json().catch(() => null)) as {
        status?: unknown;
        usage?: { outputSeconds?: unknown; inputSeconds?: unknown; inputImageCount?: unknown };
        resolution?: unknown;
        code?: unknown;
      } | null;
      if (!res.ok || !body) {
        return { status: 'failed', failure: { code: 'videogen-task-failed', upstreamCode: null } };
      }
      if (body.status === 'running') return { status: 'running' };
      if (body.status === 'failed') {
        const code = typeof body.code === 'number' ? body.code : null;
        if (code === CONTENT_SAFETY_CODE) return { status: 'failed', failure: { code: 'videogen-content-rejected' } };
        return { status: 'failed', failure: { code: 'videogen-task-failed', upstreamCode: code } };
      }
      if (body.status === 'finished') {
        const asCount = (v: unknown): number => (Number.isFinite(v) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
        return {
          status: 'finished',
          outputSeconds: asCount(body.usage?.outputSeconds),
          inputSeconds: asCount(body.usage?.inputSeconds),
          inputImageCount: asCount(body.usage?.inputImageCount),
          resolution: typeof body.resolution === 'string' && body.resolution.trim() ? body.resolution.trim() : null,
        };
      }
      // 未知状态 = 上游形状变了。当作"还没好"继续等（有 deadline 兜底），不要武断判败。
      return { status: 'running' };
    },

    async download(taskId: string): Promise<VideogenDownloadResult> {
      let res: Response;
      try {
        res = await doFetch(`${base}/v1/videos/${encodeURIComponent(taskId)}/file`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(VIDEOGEN_DOWNLOAD_TIMEOUT_MS),
        });
      } catch {
        return { ok: false, failure: { code: 'videogen-download-failed' } };
      }
      if (!res.ok) return { ok: false, failure: { code: 'videogen-download-failed' } };
      try {
        return { ok: true, buffer: Buffer.from(await res.arrayBuffer()) };
      } catch {
        return { ok: false, failure: { code: 'videogen-download-failed' } };
      }
    },
  };
}
