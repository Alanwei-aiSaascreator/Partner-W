import type { ImagegenRequest, ImagegenFailureCode } from './request.js';
/**
 * 目前接线的生图型号。`qwen-image-plus` 是历史标签：relay 仍受理它，但上游一律走
 * `qwen-image-2.1-turbo`（`qwen-image-plus` 已从百炼下线）。两个名字都接受，是为了
 * 不打断已经生成出来的技能块和旧版客户端。
 */
const WIRED_IMAGE_MODELS: ReadonlySet<string> = new Set(['qwen-image-plus', 'qwen-image-2.1-turbo']);
export interface ImagegenRelayClient {
  capabilities(size: string): Promise<boolean>;
  create(
    request: ImagegenRequest,
    requestId: string,
  ): Promise<{ ok: true; queued?: boolean; retryAfterSeconds?: number } | { ok: false; code: ImagegenFailureCode }>;
  query(
    requestId: string,
  ): Promise<
    | { status: 'running' | 'finished' }
    | { status: 'queued'; retryAfterSeconds?: number }
    | { status: 'failed'; code: ImagegenFailureCode }
  >;
  download(requestId: string): Promise<{ ok: true; bytes: Buffer } | { ok: false; code: ImagegenFailureCode }>;
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}
/** 排队重试间隔：1–30 秒，缺省 6 秒（与 relay 的 BUSY_RETRY_SECONDS 对齐）。 */
function retrySeconds(value: unknown): number {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.max(Math.ceil(seconds), 1), 30) : 6;
}
export function createImagegenRelayClient(options: {
  baseUrl: string;
  relayKey: string;
  fetchImpl?: typeof fetch;
}): ImagegenRelayClient {
  const base = options.baseUrl.replace(/\/+$/, ''),
    doFetch = options.fetchImpl ?? fetch;
  const headers = { Authorization: `Bearer ${options.relayKey}` };
  return {
    async capabilities(size) {
      try {
        const res = await doFetch(`${base}/v1/imagegen/capabilities`, {
          headers,
          signal: AbortSignal.timeout(15000),
          redirect: 'error',
        });
        const data = record(await res.json());
        return (
          res.ok &&
          data.enabled === true &&
          typeof data.model === 'string' &&
          WIRED_IMAGE_MODELS.has(data.model) &&
          Array.isArray(data.sizes) &&
          data.sizes.includes(size)
        );
      } catch {
        return false;
      }
    },
    async create(request, requestId) {
      try {
        const res = await doFetch(`${base}/v1/imagegen`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId, model: request.model, prompt: request.prompt, size: request.size }),
          signal: AbortSignal.timeout(45000),
          redirect: 'error',
        });
        const body = record(await res.json());
        if (res.status === 202 && body.requestId === requestId) {
          // `queued` = 上游排队。不是失败：调用方应等 retryAfterSeconds 后用同一 requestId 重试。
          return body.status === 'queued'
            ? { ok: true, queued: true, retryAfterSeconds: retrySeconds(body.retryAfterSeconds) }
            : { ok: true, queued: false };
        }
        return { ok: false, code: res.status === 503 ? 'imagegen-unavailable' : 'imagegen-request-unconfirmed' };
      } catch {
        return { ok: false, code: 'imagegen-request-unconfirmed' };
      }
    },
    async query(requestId) {
      try {
        const res = await doFetch(`${base}/v1/imagegen/${encodeURIComponent(requestId)}`, {
          headers,
          signal: AbortSignal.timeout(60000),
          redirect: 'error',
        });
        const body = record(await res.json());
        if (res.ok && body.status === 'queued')
          return { status: 'queued', retryAfterSeconds: retrySeconds(body.retryAfterSeconds) };
        if (res.ok && (body.status === 'running' || body.status === 'finished')) return { status: body.status };
        return {
          status: 'failed',
          code: res.status === 422 ? 'imagegen-generation-failed' : 'imagegen-result-unconfirmed',
        };
      } catch {
        return { status: 'failed', code: 'imagegen-result-unconfirmed' };
      }
    },
    async download(requestId) {
      try {
        const res = await doFetch(`${base}/v1/imagegen/${encodeURIComponent(requestId)}/file`, {
          headers,
          signal: AbortSignal.timeout(60000),
          redirect: 'error',
        });
        const limit = 10 * 1024 * 1024;
        if (
          !res.ok ||
          res.headers.get('content-type')?.split(';')[0] !== 'image/png' ||
          Number(res.headers.get('content-length')) > limit ||
          !res.body
        )
          return { ok: false, code: 'imagegen-image-invalid' };
        const reader = res.body.getReader(),
          parts: Uint8Array[] = [];
        let length = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            length += part.value.length;
            if (length > limit) throw new Error('image-size');
            parts.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
        return { ok: true, bytes: Buffer.concat(parts) };
      } catch {
        return { ok: false, code: 'imagegen-image-invalid' };
      }
    },
  };
}
