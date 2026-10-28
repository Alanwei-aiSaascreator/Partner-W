import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { RemotePageServer, resolveStaticPath } from '../../src/main/remote-access/remote-page-server.js';

/**
 * 远程页入口（frp 版）：一个 loopback 端口同时服务 `/app/` 静态页与网关反代。
 *
 * 这些用例跑真 HTTP / 真 WebSocket（假网关 + 临时目录），不打桩：
 * 路径穿越、SPA 回落、WS upgrade 透传这几件事，只有真连一遍才算数。
 */

let pageRoot: string;
let gateway: Server;
let gatewayPort = 0;
let gatewaySeen: string[] = [];
let gatewayHeaders: Array<Record<string, string | string[] | undefined>> = [];
let gatewayUpgradeHeaders: Array<Record<string, string | string[] | undefined>> = [];
let pageServer: RemotePageServer | null = null;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

async function startGateway(): Promise<void> {
  gateway = createServer((req, res) => {
    gatewaySeen.push(req.url ?? '');
    gatewayHeaders.push(req.headers);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, seen: req.url, host: req.headers.host }));
  });

  const wss = new WebSocketServer({ noServer: true });
  gateway.on('upgrade', (req, socket, head) => {
    gatewayUpgradeHeaders.push(req.headers);
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws) => {
    ws.on('message', (data) => ws.send(`echo:${String(data)}`));
  });

  gatewayPort = await listen(gateway);
}

function httpGet(
  port: number,
  path: string,
  method = 'GET',
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, agent: false, headers: extraHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk as Buffer));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
    server.closeAllConnections?.();
    setTimeout(resolve, 300).unref?.();
  });
}
beforeEach(async () => {
  pageRoot = mkdtempSync(join(tmpdir(), 'remote-page-'));
  mkdirSync(join(pageRoot, 'assets'), { recursive: true });
  writeFileSync(join(pageRoot, 'index.html'), '<!doctype html><title>REMOTE-UI-MARKER</title>');
  writeFileSync(join(pageRoot, 'assets', 'app.js'), 'console.log("hi")');
  writeFileSync(join(pageRoot, 'manifest.webmanifest'), '{"name":"x"}');

  gatewaySeen = [];
  gatewayHeaders = [];
  gatewayUpgradeHeaders = [];
  await startGateway();
});

afterEach(async () => {
  await pageServer?.stop();
  pageServer = null;
  await closeServer(gateway);
  rmSync(pageRoot, { recursive: true, force: true });
});

describe('resolveStaticPath', () => {
  it('解析普通资源与 SPA 路由', () => {
    expect(resolveStaticPath(pageRoot, '/app/index.html')).toMatchObject({ kind: 'file' });
    expect(resolveStaticPath(pageRoot, '/app/chat')).toMatchObject({ kind: 'file' });
    expect(resolveStaticPath(pageRoot, '/app/')).toMatchObject({ kind: 'file' });
  });

  it('拒绝路径穿越（含编码形式）', () => {
    expect(resolveStaticPath(pageRoot, '/app/../../etc/passwd')).toMatchObject({ kind: 'forbidden' });
    expect(resolveStaticPath(pageRoot, '/app/%2e%2e/%2e%2e/etc/passwd')).toMatchObject({ kind: 'forbidden' });
  });

  it('缺文件报 not-found，不越权', () => {
    expect(resolveStaticPath(pageRoot, '/app/missing.js')).toMatchObject({ kind: 'not-found' });
  });
});

describe('RemotePageServer · 静态页', () => {
  it('GET /app/ 返回首页且禁止缓存', async () => {
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    const res = await httpGet(port, '/app/');
    expect(res.status).toBe(200);
    expect(res.body).toContain('REMOTE-UI-MARKER');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(String(res.headers['content-type'])).toContain('text/html');
  });

  it('静态资源带正确 MIME', async () => {
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    const js = await httpGet(port, '/app/assets/app.js');
    expect(js.status).toBe(200);
    expect(String(js.headers['content-type'])).toContain('text/javascript');

    const manifest = await httpGet(port, '/app/manifest.webmanifest');
    expect(String(manifest.headers['content-type'])).toContain('application/manifest+json');
  });

  it('/app 无尾斜杠时 301 到 /app/', async () => {
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    const res = await httpGet(port, '/app?x=1');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/app/?x=1');
  });

  it('HEAD 不带 body，POST 拒绝', async () => {
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    const head = await httpGet(port, '/app/index.html', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');

    const post = await httpGet(port, '/app/index.html', 'POST');
    expect(post.status).toBe(405);
    expect(post.headers.allow).toBe('GET, HEAD');
  });

  it('穿越请求被 403 挡住', async () => {
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    const res = await httpGet(port, '/app/../../package.json');
    expect(res.status).toBe(403);
  });

  it('前端包缺失时给出 503 说明', async () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), 'remote-page-empty-'));
    pageServer = new RemotePageServer({ pageRoot: emptyRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    const res = await httpGet(port, '/app/');
    expect(res.status).toBe(503);
    expect(res.body).toContain('not packaged');
    rmSync(emptyRoot, { recursive: true, force: true });
  });
});

describe('RemotePageServer · 网关反代', () => {
  it('非 /app/ 路径透传给网关，保持原始 path 与 query', async () => {
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    const res = await httpGet(port, '/startupz?probe=1');
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).seen).toBe('/startupz?probe=1');
    expect(gatewaySeen).toContain('/startupz?probe=1');
  });

  it('WebSocket upgrade 双向透传', async () => {
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('ws timeout'));
      }, 3000);
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (data) => {
        clearTimeout(timer);
        ws.close();
        resolve(String(data));
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    expect(reply).toBe('echo:ping');
  });

  it('剥掉 x-forwarded-* / x-real-ip，不让网关因代理性归属 403', async () => {
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    await httpGet(port, '/startupz', 'GET', {
      'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'test0001.rym.example.com',
      'x-real-ip': '203.0.113.9',
    });

    const seen = gatewayHeaders[gatewayHeaders.length - 1];
    expect(seen['x-forwarded-for']).toBeUndefined();
    expect(seen['x-forwarded-proto']).toBeUndefined();
    expect(seen['x-forwarded-host']).toBeUndefined();
    expect(seen['x-real-ip']).toBeUndefined();
  });

  it('WebSocket upgrade 同样剥掉 forwarded 头', async () => {
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${gatewayPort}` });
    const port = await pageServer.start();

    const reply = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: {
          'x-forwarded-for': '203.0.113.9',
          'x-forwarded-proto': 'https',
          'x-real-ip': '203.0.113.9',
        },
      });
      ws.on('open', () => ws.send('ping'));
      ws.on('message', (data) => {
        ws.close();
        resolve(String(data));
      });
      ws.on('error', reject);
    });

    expect(reply).toBe('echo:ping');
    const seen = gatewayUpgradeHeaders[gatewayUpgradeHeaders.length - 1];
    expect(seen['x-forwarded-for']).toBeUndefined();
    expect(seen['x-forwarded-proto']).toBeUndefined();
    expect(seen['x-real-ip']).toBeUndefined();
  });

  it('网关不可达时返回 502，不挂起', async () => {
    const deadPort = gatewayPort;
    await closeServer(gateway);
    gateway = createServer();
    pageServer = new RemotePageServer({ pageRoot, gatewayOrigin: `http://127.0.0.1:${deadPort}` });
    const port = await pageServer.start();

    const res = await httpGet(port, '/startupz');
    expect(res.status).toBe(502);
    expect(res.body).toContain('gateway unreachable');
  });
});

describe('RemotePageServer · 端口', () => {
  it('首选端口被占时顺延', async () => {
    const blocker = createServer();
    const blockedPort = await listen(blocker);

    pageServer = new RemotePageServer({
      pageRoot,
      gatewayOrigin: `http://127.0.0.1:${gatewayPort}`,
      port: blockedPort,
      maxPort: blockedPort + 3,
    });
    const port = await pageServer.start();

    expect(port).toBeGreaterThan(blockedPort);
    expect(port).toBeLessThanOrEqual(blockedPort + 3);
    await closeServer(blocker);
  });
});
