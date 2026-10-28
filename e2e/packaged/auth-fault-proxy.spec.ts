import { expect, test } from '@playwright/test';
import http from 'node:http';
import zlib from 'node:zlib';
import { startAuthFaultProxy } from './auth-fault-proxy.js';

/**
 * **代理透明性回归** —— 不需要 packaged app、不需要 provision，秒级跑完。
 *
 * ## 为什么必须有这个文件
 *
 * `auth-fault-proxy` 为了 telemetry 会解析 upstream 的响应体。**观察不能改变语义**：
 * 如果它把响应重写了一遍（`JSON.parse` → `JSON.stringify`、漏/错配 `content-encoding`、
 * 截断 body），下游 SDK 收到的就不是一个正常的 auth 响应 —— 那会制造出**看起来像
 * SDK/网络错误**的假故障，把整条 2B 结论带偏。
 *
 * 所以这里用**本地 mock upstream**（合成值，绝不碰真实 Supabase）钉住两条 invariant：
 *
 *   1. **下游收到的 body 逐字节等于上游写出的 body**（sha256 相等）
 *   2. **上游没压缩时，下游不得出现 `content-encoding`**（否则客户端会去 gunzip 纯 JSON）
 *
 * 第 2 条是实测中最容易踩的：`fetch` 会**自动解压**，若原样回传
 * `content-encoding: gzip` 就会「body 已解压 + header 说 gzip」⇒ 解码失败。
 */

/** 一份**合成**的 auth 响应（明显的假值，不是任何真实凭证）。 */
const SYNTH_SESSION = {
  access_token: 'SYNTHETIC-ACCESS-TOKEN-FOR-TRANSPARENCY-TEST',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  refresh_token: 'SYNTHETIC-REFRESH-TOKEN-FOR-TRANSPARENCY-TEST',
  user: { id: '00000000-0000-0000-0000-000000000000', aud: 'authenticated', role: 'authenticated' },
};

interface MockUpstream {
  url: string;
  close: () => Promise<void>;
}

/**
 * 起一个本地 mock upstream。
 *
 * @param gzip 是否**带** `content-encoding: gzip` 回（用来暴露解压/头不一致的坑）。
 */
async function startMockUpstream(gzip: boolean): Promise<MockUpstream> {
  const server = http.createServer((req, res) => {
    const payload = Buffer.from(JSON.stringify(SYNTH_SESSION), 'utf8');
    const body = gzip ? zlib.gzipSync(payload) : payload;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
    };
    if (gzip) headers['content-encoding'] = 'gzip';
    res.writeHead(200, { ...headers, 'content-length': String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('mock 没拿到端口');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** 直接走 http 请求代理（不用 fetch，免得 fetch 自己又替我们解压一层，模糊结论）。 */
function getThroughProxy(
  proxyUrl: string,
  path: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, proxyUrl);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ refresh_token: 'SYNTHETIC-REFRESH-TOKEN-FOR-TRANSPARENCY-TEST' }));
  });
}

test('代理透明性：identity 响应逐字节透传，且不引入 content-encoding', async () => {
  const mock = await startMockUpstream(false);
  const proxy = await startAuthFaultProxy(mock.url);
  proxy.setMode('fail-before-upstream');
  proxy.setFailing(false); // healthy：纯转发路径
  try {
    const expected = Buffer.from(JSON.stringify(SYNTH_SESSION), 'utf8');
    const got = await getThroughProxy(proxy.url, '/auth/v1/token?grant_type=refresh_token');

    expect(got.status, '状态码被改了').toBe(200);
    // ⭐ invariant 1：逐字节相等
    expect(
      Buffer.compare(got.body, expected),
      `下游 body 与上游 body 不一致（up=${expected.length}B down=${got.body.length}B）`,
    ).toBe(0);
    // ⭐ invariant 2：上游没压缩 ⇒ 下游不得带 content-encoding
    expect(got.headers['content-encoding'], '凭空多出了 content-encoding，客户端会解码失败').toBeUndefined();
    // body 仍然是一个**能被正常解析**的 auth 响应
    const parsed = JSON.parse(got.body.toString('utf8')) as Record<string, unknown>;
    expect(parsed.access_token).toBe(SYNTH_SESSION.access_token);
    expect(parsed.refresh_token).toBe(SYNTH_SESSION.refresh_token);
    expect(parsed.expires_in).toBe(3600);

    // telemetry 确实观察到了，但没有改变字节
    const ev = proxy.events().at(-1)!;
    expect(ev.upstreamStatus).toBe(200);
    expect(ev.upstreamHasAccessToken).toBe(true);
    expect(ev.upstreamHasRefreshToken).toBe(true);
    expect(ev.upstreamRtHash, 'telemetry 应当算出了 refresh token 指纹').toBeTruthy();
    expect(ev.downstreamFinish, '下游没有 finish').toBe(true);
  } finally {
    await proxy.close();
    await mock.close();
  }
});

test('代理透明性：上游带 gzip 时，下游 header 与实际 body 必须自洽', async () => {
  const mock = await startMockUpstream(true);
  const proxy = await startAuthFaultProxy(mock.url);
  proxy.setMode('fail-before-upstream');
  proxy.setFailing(false);
  try {
    const got = await getThroughProxy(proxy.url, '/auth/v1/token?grant_type=refresh_token');
    expect(got.status).toBe(200);

    // ⭐ 关键：要么"原始 gzip 字节 + content-encoding: gzip"，要么"已解压 + 无 content-encoding"。
    //   绝不允许"已解压 + 仍然说 gzip"。
    const enc = got.headers['content-encoding'];
    if (enc) {
      // 说是压缩的 ⇒ 必须真的能按它解出来
      expect(enc).toBe('gzip');
      const inflated = zlib.gunzipSync(got.body);
      expect(JSON.parse(inflated.toString('utf8')).refresh_token).toBe(SYNTH_SESSION.refresh_token);
    } else {
      // 说没压缩 ⇒ 必须是能直接解析的明文
      expect(JSON.parse(got.body.toString('utf8')).refresh_token).toBe(SYNTH_SESSION.refresh_token);
    }
  } finally {
    await proxy.close();
    await mock.close();
  }
});
