import http from 'node:http';
import { createHash } from 'node:crypto';

/** 只记指纹，**绝不记原文**。 */
const fp = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? createHash('sha256').update(v).digest('hex').slice(0, 16) : null;

function tokenFromBody(buf: Buffer): string | null {
  const raw = buf.toString('utf8');
  try {
    return (JSON.parse(raw) as { refresh_token?: string })?.refresh_token ?? null;
  } catch {
    return new URLSearchParams(raw).get('refresh_token');
  }
}

/**
 * 一个**反向代理**，专给「会话检查」注故障用。
 *
 * ## 为什么需要它
 *
 * 2B 要证的是：「**会话检查暂时失败 ⇒ 退避重试后自己恢复，用户不用重启**」。
 * 这需要一个**受控且可恢复**的暂时性故障 —— 但又不能把其它请求
 * （`org_members` / `activate_license` 那些）也弄坏，否则根本走不到"配置落地"，
 * 测的就不是我们要测的东西了。
 *
 * 做法：客户端把 `supabaseUrl` 指向本代理，代理**原样转发**到真 Supabase，
 * 对 **`/auth/v1/*`** 按开关**慢处理**：拖到 `delayMs` 之后**照常转发**。
 * 于是客户端的**自己的** 8 秒会话检查窗口会先超时（= 我们要复现的那个 bug），
 * 而底层请求**最终还是会完成**、连接也会释放。测试中途 `setFailing(false)`
 * 就相当于"网络恢复了"。
 *
 * ⚠️ 注入点选 `/auth/v1/*` 而**不是**只选 `/auth/v1/user`：实测（2026-09-13）
 * 会话的 access token 一旦过期，`getUser()` 会**先在 `/auth/v1/token?grant_type=
 * refresh_token` 那一步停下**，压根走不到 `/auth/v1/user` —— 只堵后者等于没堵，
 * 而且症状会伪装成"代理根本没被访问过"。
 *
 * ⚠️ 起始状态是**失败**：这样从启动第一刻起就是"暂时问不出来"，与真实事故一致。
 * ⚠️ 注入的**形状**很讲究，两种都试过、都不对：
 *    - **挂着不回**：连接池里永远躺着一个 in-flight 请求，后面的全排队 ⇒ 恢复后也永远好不了；
 *    - **直接掐连接**：会让 supabase-js 把这次刷新判死并**缓存失败**
 *      （`GoTrueClient.js:4319`，`REFRESH_FAILURE_COOLDOWN_MS` = 60s），
 *      冷却期内每次探测 0ms 就报错。⚠️ **注意：这是 60 秒冷却，不是永久中毒** ——
 *      2026-09-13 实测：冷却一过就会真的再发请求（见下）。
 *      而且这已经不是我们要修的那个故障了（那个是"请求还在路上、是我们的 8 秒窗口先到"）。
 *    ⇒ 只有"**慢**"是对的：客户端的窗口先超时，而请求本身最终成功。
 * ⚠️ 只用于测试进程，**不碰产品代码**。
 *
 * ## ⚠️ 计数口径（2026-09-13 更正，这条曾经把结论带偏）
 *
 * 旧版只有 `failingHits`，而它**只在 `failing === true` 时**增长。于是
 * "heal 前 = 3、heal 后 = 3" 被误读成"恢复之后 SDK 不再访问网络" ——
 * **这个推理是错的**：heal 之后 `failing` 为 false，`failingHits` 本来就**必然**冻住，
 * 它压根不观察 heal 之后的事。
 *
 * 现在三个计数器**相互独立**，`setFailing` 只影响 `phase`，不影响是否计数：
 *
 *   totalHits   到达代理的**所有**请求（唯一能回答"到底有没有再发请求"的量）
 *   failingHits 在 `failing === true` 期间到达的
 *   healthyHits 在 `failing === false` 之后到达的   ← **heal 后自愈的判据**
 *
 * 结论性判据只能是：**heal 之后 `totalHits` / `healthyHits` 是否增长**。
 *
 * ## 隐私
 *
 * 只记录：序号 / 相对时间 / phase / method / pathname / `grant_type` / status / 耗时。
 * **绝不**记录 `Authorization`、access/refresh token、cookie、任何请求体内容。
 */
/**
 * 注入模式。**两件事不同，别混**：
 *
 *   - `slow`                 —— 延迟 12s **后照常转发**。请求**到达并成功**了上游，
 *                              只是客户端 8s 窗口先到 ⇒ 属于 **response-loss /
 *                              ambiguous completion**（上游已处理、客户端没收到）。
 *   - `fail-before-upstream` —— 到代理为止，**绝不转发给上游**。
 *                              这才是"后端不可达 / 网络瞬断"的忠实模型，
 *                              也是**主 6b** 用的模式（invariant：`forwardedHits == 0`）。
 */
export type AuthFaultMode = 'slow' | 'fail-before-upstream';

export interface AuthFaultProxy {
  /** 给 `supabaseUrlOverride` 用（http://127.0.0.1:<随机端口>）。 */
  url: string;
  /** 开关：true = `/auth/v1/*` 按当前 mode 注入故障。**只影响处理方式与 phase，不影响计数**。 */
  setFailing: (failing: boolean) => void;
  /** 切注入模式（默认 `slow`，6a 沿用；主 6b 用 `fail-before-upstream`）。 */
  setMode: (mode: AuthFaultMode) => void;
  mode: () => AuthFaultMode;
  /** 当前 phase（排障用）。 */
  isFailing: () => boolean;
  /** 到达代理的**所有**请求数 —— 唯一能回答"heal 后有没有真的再发请求"的量。 */
  totalHits: () => number;
  /** `failing === true` 期间到达的请求数。⚠️ **不能**用它推断 heal 之后的行为。 */
  failingHits: () => number;
  /** `failing === false` 之后到达的请求数 —— heal 后自愈的判据。 */
  healthyHits: () => number;
  /** 转发成功的次数 —— 用来确认"其它请求没被误伤"。 */
  proxiedHits: () => number;
  /**
   * **真正转发给 Supabase upstream** 的请求数。
   * ⚠️ 主 6b 的 failing 相必须恒为 **0** —— 这是"后端没被碰到"的 invariant。
   */
  forwardedHits: () => number;
  /** upstream 返回 **2xx** 的次数（真的被服务端成功处理了）。 */
  upstreamSuccessHits: () => number;
  /** 收到过的请求路径（排障用：分辨"应用压根没连过来"和"路径对不上"）。 */
  requestPaths: () => string[];
  /** 结构化时间线（**不含任何凭证**），用来和 bootstrap 的 probe 日志按时间对齐。 */
  events: () => AuthFaultProxyEvent[];
  /** 人读时间线，直接贴进报告。 */
  timeline: () => string;
  close: () => Promise<void>;
}

export interface AuthFaultProxyEvent {
  /** 从代理启动算起的序号，1 开始。 */
  seq: number;
  /** 相对代理启动的毫秒数。 */
  tMs: number;
  /** 请求到达时开关处于哪一相。 */
  phase: 'failing' | 'healthy';
  method: string;
  pathname: string;
  /**
   * 只记 `grant_type`（例如 `refresh_token`）——
   * **绝不**记 body 里的 token 本体。
   */
  grantType: string | null;
  /** 上游/代理返回的状态码；被掐断或未完成时为 null。 */
  status: number | null;
  /** 这次真的转发到 upstream 了吗（主 6b 的 failing 相必须全 false）。 */
  forwarded: boolean;
  /** 请求 body 里 refresh_token 的**指纹**（绝不记原文）。 */
  requestRtHash: string | null;
  forwardedAt: number | null;
  upstreamStatus: number | null;
  upstreamResponseAt: number | null;
  /** upstream 响应里有没有 access_token / refresh_token（只记存在性）。 */
  upstreamHasAccessToken: boolean | null;
  upstreamHasRefreshToken: boolean | null;
  /** upstream 响应里**新** refresh_token 的指纹。 */
  upstreamRtHash: string | null;
  /** 我们是否把完整响应写完了（`res` 的 `finish`）。 */
  downstreamFinish: boolean;
  downstreamFinishAt: number | null;
  /** 客户端在我们写完之前就断了（`close` 先于 `finish` / `req` aborted）。 */
  clientAborted: boolean;
  /** 从到达到响应结束的毫秒数。 */
  elapsedMs: number | null;
}

/**
 * 注入的延迟。**必须 > 客户端自己的会话检查窗口（8s）**，否则探不到超时那条路。
 * 取 12s：稳稳越过 8s，又不至于让整条用例等太久。
 */
const FAULT_DELAY_MS = 12_000;

/** 只取 `grant_type`，其余 query 一概不记（避免把 token 之类的东西写进日志）。 */
function extractGrantType(rawUrl: string): string | null {
  const q = rawUrl.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(rawUrl.slice(q + 1));
  return params.get('grant_type');
}

/** 路径里可能带 token 的片段一律截掉，只留结构。 */
function safePathname(rawUrl: string): string {
  return (rawUrl.split('?')[0] ?? '/').replace(/\/[A-Za-z0-9_-]{20,}/g, '/<redacted>');
}

export async function startAuthFaultProxy(targetBase: string): Promise<AuthFaultProxy> {
  let failing = true;
  let mode: AuthFaultMode = 'slow';
  let totalHits = 0;
  let failingHits = 0;
  let healthyHits = 0;
  let proxiedHits = 0;
  let forwardedHits = 0;
  let upstreamSuccessHits = 0;
  const requestPaths: string[] = [];
  const events: AuthFaultProxyEvent[] = [];
  const startedAt = Date.now();
  // 慢响应的定时器：关代理时一并清掉，否则 server.close() 可能不回调。
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const server = http.createServer((req, res) => {
    void (async () => {
      const rawUrl = req.url ?? '/';
      const pathname = safePathname(rawUrl);
      const arrivedAt = Date.now();
      const phase: AuthFaultProxyEvent['phase'] = failing ? 'failing' : 'healthy';

      // ⚠️ 计数发生在**到达时**，且**与 failing 无关地**累加 totalHits ——
      //    这正是旧版缺的那一条：heal 之后也必须继续计数。
      totalHits += 1;
      if (failing) failingHits += 1;
      else healthyHits += 1;

      if (requestPaths.length < 20) requestPaths.push(rawUrl);
      const event: AuthFaultProxyEvent = {
        seq: totalHits,
        tMs: arrivedAt - startedAt,
        phase,
        method: req.method ?? 'GET',
        pathname,
        grantType: extractGrantType(rawUrl),
        status: null,
        forwarded: false,
        requestRtHash: null,
        forwardedAt: null,
        upstreamStatus: null,
        upstreamResponseAt: null,
        upstreamHasAccessToken: null,
        upstreamHasRefreshToken: null,
        upstreamRtHash: null,
        downstreamFinish: false,
        downstreamFinishAt: null,
        clientAborted: false,
        elapsedMs: null,
      };
      events.push(event);

      // ⭐ 交付语义：`upstream 200` ≠ `客户端收到完整响应`。分开记。
      res.on('finish', () => {
        event.downstreamFinish = true;
        event.downstreamFinishAt = Date.now() - startedAt;
      });
      res.on('close', () => {
        if (!event.downstreamFinish) event.clientAborted = true;
      });
      req.on('aborted', () => {
        event.clientAborted = true;
      });

      if (failing && rawUrl.startsWith('/auth/v1/') && mode === 'fail-before-upstream') {
        // ⭐ 主 6b：**绝不转发**。上游压根看不到这次请求 ⇒ token 不会被消费。
        //    回 503（retryable）而不是掐连接 —— 实测掐连接同样只值一个 60s 冷却，
        //    但 503 是干净的 HTTP 语义、且不会让连接池留半开状态。
        event.status = 503;
        event.elapsedMs = Date.now() - arrivedAt;
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'injected_before_upstream', error_description: 'auth backend unreachable' }));
        return;
      }

      if (failing && rawUrl.startsWith('/auth/v1/')) {
        // slow —— **最终照常转发**：客户端 8 秒窗口先超时，而上游其实成功了。
        await new Promise((resolve) => setTimeout(resolve, FAULT_DELAY_MS));
      }

      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks);
        event.requestRtHash = fp(tokenFromBody(body));

        // ⚠️ 丢掉几个**逐跳/会打架**的头：
        //   host / connection / content-length —— 由 fetch 自己重算
        //   accept-encoding —— 否则上游可能回 gzip，而我们要原样转发字节
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const key = k.toLowerCase();
          if (['host', 'connection', 'content-length', 'accept-encoding', 'transfer-encoding'].includes(key)) continue;
          if (typeof v === 'string') headers[key] = v;
          else if (Array.isArray(v)) headers[key] = v.join(', ');
        }

        forwardedHits += 1;
        event.forwarded = true;
        event.forwardedAt = Date.now() - startedAt;
        const upstream = await fetch(new URL(rawUrl, targetBase), {
          method: req.method,
          headers,
          body: body.length > 0 ? new Uint8Array(body) : undefined,
          redirect: 'manual',
        });
        const out = Buffer.from(await upstream.arrayBuffer());
        event.upstreamStatus = upstream.status;
        event.upstreamResponseAt = Date.now() - startedAt;
        // 只解析"有没有 token"和"新 token 的指纹"，**其余正文一概不落日志**。
        if ((upstream.headers.get('content-type') ?? '').includes('json')) {
          try {
            const j = JSON.parse(out.toString('utf8')) as { access_token?: string; refresh_token?: string };
            event.upstreamHasAccessToken = typeof j.access_token === 'string' && j.access_token.length > 0;
            event.upstreamHasRefreshToken = typeof j.refresh_token === 'string' && j.refresh_token.length > 0;
            event.upstreamRtHash = fp(j.refresh_token);
          } catch {
            /* 非 JSON / 解析失败：保持 null，不猜 */
          }
        }
        // ⚠️ **绝不能**透传 `content-encoding`：`fetch` 已经自动解压过 body，
        //    再声称 gzip 就等于「明文 + 说是压缩的」⇒ 下游 gunzip 直接 `incorrect header check`。
        //    这种假故障看起来**非常像** SDK/网络错误，会把整条结论带偏
        //    （实测：2026-09-13 被 `auth-fault-proxy.spec.ts` 的 gzip 用例抓到）。
        //    ⇒ 我们只给下游 **identity**，`content-length` 交给 `res.end` 重算。
        const outHeaders: Record<string, string> = {
          'content-type': upstream.headers.get('content-type') ?? 'application/json',
        };
        proxiedHits += 1;
        if (upstream.status >= 200 && upstream.status < 300) upstreamSuccessHits += 1;
        event.status = upstream.status;
        event.elapsedMs = Date.now() - arrivedAt;
        res.writeHead(upstream.status, outHeaders);
        res.end(out);
      } catch (error) {
        event.status = 502;
        event.elapsedMs = Date.now() - arrivedAt;
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ proxyError: error instanceof Error ? error.message : String(error) }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('代理没拿到端口');

  return {
    url: `http://127.0.0.1:${address.port}`,
    setFailing: (v: boolean) => {
      failing = v;
    },
    setMode: (m: AuthFaultMode) => {
      mode = m;
    },
    mode: () => mode,
    isFailing: () => failing,
    totalHits: () => totalHits,
    failingHits: () => failingHits,
    healthyHits: () => healthyHits,
    proxiedHits: () => proxiedHits,
    forwardedHits: () => forwardedHits,
    upstreamSuccessHits: () => upstreamSuccessHits,
    requestPaths: () => requestPaths,
    events: () => events.map((e) => ({ ...e })),
    timeline: () =>
      events
        .map(
          (e) =>
            `#${String(e.seq).padStart(3)} t=${String(e.tMs).padStart(6)}ms ${e.phase.padEnd(7)} ` +
            `${e.method} ${e.pathname}${e.grantType ? `?grant_type=${e.grantType}` : ''} ` +
            `→ ${e.status ?? '-'} (${e.elapsedMs ?? '-'}ms)${e.forwarded ? ' [fwd]' : ''}` +
            `  reqRT=${e.requestRtHash ?? '-'}` +
            (e.upstreamStatus !== null ? `  up=${e.upstreamStatus} upRT=${e.upstreamRtHash ?? '-'}` : '') +
            `  finish=${e.downstreamFinish ? 'Y' : 'N'}${e.clientAborted ? ' ABORTED' : ''}`,
        )
        .join('\n'),
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.close(() => resolve());
      }),
  };
}
