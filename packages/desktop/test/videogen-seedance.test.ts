import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { readVideogenFirstFrame } from '../src/main/videogen/reference-image.js';
import { parseVideogenRequest } from '../src/main/videogen/request.js';
import { createVideogenRelayClient } from '../src/main/videogen/client.js';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';
import { closeDatabase, getSqlite, initDatabase } from '../src/main/db/index.js';

/**
 * Seedance 图生视频的两条边界：
 *
 *  ① **参考图读取**（`readVideogenFirstFrame`）：受信字节 / 工作区钉扎 / 越界与坏图拒绝；
 *  ② **生产入口接线**（R8-06，2026-10-15）：`generateVideosFromMessage` 必须把首帧**字节**
 *     和**稳定 requestId** 一起交给 relay 客户端 —— 这条曾经只有 helper 定义、零生产调用，
 *     r8 独立终审实测生产 JSON 里两个字段都不存在（`seedance-request-id-required`）。
 *
 * ② 的测试刻意**不打桩 client**：走真实 `createVideogenRelayClient`（只注入 fetchImpl 截获
 * HTTP body），断言的是"真正发出去的 JSON"，而不是"我们期望它传什么参数"。
 */

const mocks = vi.hoisted(() => ({
  saveArtifactFromBuffer: vi.fn(async (params: Record<string, unknown>) => ({
    id: `artifact-${String(params.fileName)}`,
    name: String(params.fileName),
    taskId: params.taskId,
    messageId: params.messageId,
    availability: 'available',
    ...params,
  })),
  findReplayArtifact: vi.fn<(messageId: string, sourceKey: string) => unknown>(() => null),
}));

vi.mock('../src/main/artifact/save.js', () => ({
  saveArtifactFromBuffer: mocks.saveArtifactFromBuffer,
  findReplayArtifact: mocks.findReplayArtifact,
  saveArtifact: vi.fn(),
  detectMimeType: () => 'application/octet-stream',
}));
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
// 仓库里的 better-sqlite3 是按 Electron ABI 编译的，vitest 跑在纯 node 里加载不了（同 db-fresh-init）。
vi.mock('better-sqlite3', async () => ({
  default: (await import('./helpers/node-sqlite-shim.js')).NodeSqliteShim,
}));

const { generateVideosFromMessage } = await import('../src/main/videogen/generate.js');
type Client = import('../src/main/videogen/client.js').VideogenRelayClient;

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64',
);
describe('Seedance candidate image boundary', () => {
  it('explicit Seedance branch accepts local first frame and enforces adaptive', () => {
    const parsed = parseVideogenRequest({
      model: 'seedance-2.5',
      prompt: 'flower',
      firstFrame: 'images/flower.png',
      duration: 5,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.resolution).toBe('720P');
      expect(parsed.request.aspectRatio).toBe('adaptive');
    }
    expect(parseVideogenRequest({ model: 'seedance-2.5', prompt: 'x', imageUrl: 'https://example.org/x' }).ok).toBe(
      false,
    );
    expect(parseVideogenRequest({ model: 'seedance-2.5', prompt: 'x', firstFrame: 'https://example.org/x' }).ok).toBe(
      false,
    );
    expect(
      parseVideogenRequest({ model: 'seedance-2.5', prompt: 'x', firstFrame: 'a.png', aspectRatio: '16:9' }).ok,
    ).toBe(false);
  });
  it('reads exact workspace bytes; rejects outside files unless task explicitly authorizes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'videogen-ref-'));
    try {
      const ws = join(root, 'ws');
      await mkdir(ws);
      await writeFile(join(ws, 'inside.png'), png);
      const outside = join(root, 'outside.png');
      await writeFile(outside, png);
      expect(await readVideogenFirstFrame({ workspacePath: ws, path: 'inside.png' })).toEqual({
        mimeType: 'image/png',
        content: png.toString('base64'),
      });
      await expect(readVideogenFirstFrame({ workspacePath: ws, path: outside })).rejects.toThrow();
      await expect(readVideogenFirstFrame({ workspacePath: ws, path: 'https://localhost/x' })).rejects.toThrow();
      expect(
        await readVideogenFirstFrame({ workspacePath: ws, path: outside, authorizedAttachmentPaths: [outside] }),
      ).toEqual({ mimeType: 'image/png', content: png.toString('base64') });
      await writeFile(join(ws, 'fake.png'), 'not a picture');
      await expect(readVideogenFirstFrame({ workspacePath: ws, path: 'fake.png' })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('client routes Seedance separately with stable id and bytes, no direct URL', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ taskId: 'job-1' }), { status: 200 });
    }) as typeof fetch;
    const client = createVideogenRelayClient({ baseUrl: 'https://relay.example', relayKey: 'fixture', fetchImpl });
    const parsed = parseVideogenRequest({ model: 'seedance-2.5', prompt: 'flower' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    await client.create(parsed.request, 'stable-12345678');
    expect(calls[0].url).toBe('https://relay.example/v1/seedance/videos');
    expect(JSON.parse(String(calls[0].init?.body))).toMatchObject({
      requestId: 'stable-12345678',
      prompt: 'flower',
      resolution: '720P',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R8-06：生产入口（generateVideosFromMessage）的首帧装载 + 稳定逻辑身份
// 断言对象是**真实 create 调用发出的 HTTP body**（不是手工调 helper、也不是人工塞 id）。
// ─────────────────────────────────────────────────────────────────────────────

const TASK_ID = 'task-video';
const MESSAGE_ID = 'msg-video';
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function seedanceBlock(json: Record<string, unknown>): string {
  return ['```videogen', JSON.stringify({ model: 'seedance-2.5', ...json }), '```'].join('\n');
}

function box(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

/** 结构性合法的 mp4（ftyp + moov + mdat）。 */
function mp4Buffer(): Buffer {
  return Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', Buffer.alloc(16)), box('mdat', Buffer.alloc(64))]);
}

interface CapturedCreate {
  url: string;
  body: Record<string, unknown>;
}

/**
 * 生产形状的客户端：`create` 是**真实实现**（只在 fetch 层截获 body），
 * 轮询/下载用最小的成功桩（本文件钉的是"创建请求的形状"，不是编排）。
 */
function capturingClient(): { client: Client; calls: CapturedCreate[]; createCount: () => number } {
  const calls: CapturedCreate[] = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ taskId: 'job-1' }), { status: 200 });
  }) as typeof fetch;
  const real = createVideogenRelayClient({ baseUrl: 'https://relay.example', relayKey: 'fixture', fetchImpl });
  return {
    calls,
    createCount: () => calls.length,
    client: {
      create: real.create,
      query: async () => ({
        status: 'finished',
        outputSeconds: 5,
        inputSeconds: 0,
        inputImageCount: 1,
        resolution: '720P',
      }),
      download: async () => ({ ok: true, buffer: mp4Buffer() }),
    },
  };
}

function zeroCreateClient(): { client: Client; createCount: () => number } {
  let created = 0;
  return {
    createCount: () => created,
    client: {
      create: async () => {
        created += 1;
        return { ok: true, taskId: 'must-not-happen' };
      },
      query: async () => ({ status: 'running' }),
      download: async () => ({ ok: false, failure: { code: 'videogen-download-failed' } }),
    },
  };
}

describe('Seedance 生产入口接线（R8-06）', () => {
  let dir = '';
  let workspace = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'videogen-entry-'));
    workspace = join(dir, 'ws');
    await mkdir(join(workspace, 'images'), { recursive: true });
    await writeFile(join(workspace, 'images', 'flower.png'), png);
    mocks.saveArtifactFromBuffer.mockClear();
    mocks.findReplayArtifact.mockReset();
    mocks.findReplayArtifact.mockReturnValue(null);
    // 工作区库：requestId 的稳定身份必须在收费调用之前落库。
    initDatabase(dir);
  });

  afterEach(async () => {
    closeDatabase();
    await rm(dir, { recursive: true, force: true });
  });

  it('⭐ 有效 PNG 首帧：真实 body 带稳定 requestId + 逐字节一致的首帧；进程重启后同操作同 id', async () => {
    const captured = capturingClient();
    const content = seedanceBlock({ prompt: 'flower', firstFrame: 'images/flower.png', duration: 5 });

    const first = await generateVideosFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
      client: captured.client,
      pollIntervalMs: 1,
    });
    expect(first.failed).toEqual([]);
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0].url).toBe('https://relay.example/v1/seedance/videos');

    const body = captured.calls[0].body;
    // ① 稳定逻辑身份：铸出来的一行**真的落进工作区库**（不是内存态、不是每次新随机）
    expect(body.requestId).toMatch(UUID_V4);
    const stored = getSqlite()!
      .prepare('SELECT operation_key, request_id, task_id FROM videogen_request_identities')
      .all() as Array<{ operation_key: string; request_id: string; task_id: string }>;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ request_id: body.requestId, task_id: TASK_ID });
    expect(stored[0].operation_key).toMatch(/^[0-9a-f]{64}$/);
    // ② 首帧是**真实字节**（不是路径、不是 URL）
    expect(body.firstFrame).toEqual({ mimeType: 'image/png', content: png.toString('base64') });
    expect(Buffer.from((body.firstFrame as { content: string }).content, 'base64').equals(png)).toBe(true);
    // ③ body 参数域：恰好这些键（多一个都会让 relay 的严格 schema 拒收）
    expect(Object.keys(body).sort()).toEqual([
      'aspectRatio',
      'duration',
      'firstFrame',
      'prompt',
      'requestId',
      'resolution',
    ]);
    expect(body.prompt).toBe('flower');
    expect(body.duration).toBe(5);
    expect(body.resolution).toBe('720P');
    expect(body.aspectRatio).toBe('adaptive');

    // 同一操作的重放（新消息 = 重试形态）：同 id、仍是那一份字节
    const replay = capturingClient();
    await generateVideosFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: 'msg-retry',
      content,
      client: replay.client,
      pollIntervalMs: 1,
    });
    expect(replay.calls[0].body.requestId).toBe(body.requestId);

    // 进程重启模拟：关库 → 重开同一个工作区库（内存态清空、只剩磁盘上的行）⇒ 同操作同 id
    closeDatabase();
    initDatabase(dir);
    const restarted = capturingClient();
    await generateVideosFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
      client: restarted.client,
      pollIntervalMs: 1,
    });
    expect(restarted.calls[0].body.requestId).toBe(body.requestId);

    // 新操作（换了提示词）⇒ 新 id
    const other = capturingClient();
    await generateVideosFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: seedanceBlock({ prompt: 'bean', firstFrame: 'images/flower.png', duration: 5 }),
      client: other.client,
      pollIntervalMs: 1,
    });
    expect(other.calls[0].body.requestId).toMatch(UUID_V4);
    expect(other.calls[0].body.requestId).not.toBe(body.requestId);
  });

  it('bad/out-of-workspace/missing first frame ⇒ 零创建（一个远端请求都不发）', async () => {
    await writeFile(join(workspace, 'images', 'fake.png'), 'not a picture');
    const outsideDir = join(dir, 'outside');
    await mkdir(outsideDir);
    const outside = join(outsideDir, 'outside.png');
    await writeFile(outside, png);

    for (const firstFrame of ['images/fake.png', outside, 'images/missing.png']) {
      const guarded = zeroCreateClient();
      const result = await generateVideosFromMessage({
        workspacePath: workspace,
        taskId: TASK_ID,
        messageId: MESSAGE_ID,
        content: seedanceBlock({ prompt: 'flower', firstFrame, duration: 5 }),
        client: guarded.client,
        pollIntervalMs: 1,
      });
      expect({ firstFrame, created: guarded.createCount() }).toEqual({ firstFrame, created: 0 });
      expect(result.saved).toEqual([]);
      expect(result.failed).toEqual([{ code: 'videogen-block-invalid' }]);
    }
  });

  it('请求处理途中工作区被换掉 ⇒ 零创建，不向旧任务投付费请求', async () => {
    const guarded = zeroCreateClient();
    // 模拟"进入本条请求之后、创建请求之前"用户切走了工作区：
    // 重放探测是 runOneRequest 里创建之前最早的一次回调，在那里换 scope 就落在这个窗口内。
    mocks.findReplayArtifact.mockImplementationOnce(() => {
      setWorkspaceDatabaseOwner({});
      return null;
    });
    const result = await generateVideosFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: seedanceBlock({ prompt: 'flower', firstFrame: 'images/flower.png', duration: 5 }),
      client: guarded.client,
      pollIntervalMs: 1,
    });
    expect(guarded.createCount()).toBe(0);
    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it('first-frame file read awaits cannot start a paid request after source cancellation', async () => {
    let current = true;
    const guarded = zeroCreateClient();
    const result = await generateVideosFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: seedanceBlock({ prompt: 'flower', firstFrame: 'images/flower.png', duration: 5 }),
      client: guarded.client,
      sourceCurrent: () => current,
      onActivity: () => {
        queueMicrotask(() => {
          current = false;
        });
      },
    });
    expect(guarded.createCount()).toBe(0);
    expect(result).toEqual({ saved: [], failed: [] });
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('文生视频（无首帧）不装载图片、不再造 id：H3 通道的 body 一个字节没变', async () => {
    const captured = capturingClient();
    const content = ['```videogen', JSON.stringify({ prompt: '一只猫', duration: 4 }), '```'].join('\n');
    await generateVideosFromMessage({
      workspacePath: workspace,
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
      client: captured.client,
      pollIntervalMs: 1,
    });
    // H3 通道走 /v1/videos（没有 Seedance 分支字段）
    expect(captured.calls[0].url).toBe('https://relay.example/v1/videos');
    expect(Object.keys(captured.calls[0].body).sort()).toEqual(['aspectRatio', 'duration', 'prompt', 'resolution']);
  });
});

describe('Seedance terminal billing state at the real relay client boundary', () => {
  it('preserves pending billing as a dedicated failure and never treats it as a refund', async () => {
    const client = createVideogenRelayClient({
      baseUrl: 'https://relay.example',
      relayKey: 'fixture',
      fetchImpl: async () => Response.json({ status: 'failed', code: 0, billingPending: true }),
    });
    expect(await client.query('seedance:operation-1234')).toEqual({
      status: 'failed',
      failure: { code: 'videogen-billing-pending' },
    });
  });
  it('pending billing takes precedence over a provider content rejection code', async () => {
    const client = createVideogenRelayClient({
      baseUrl: 'https://relay.example',
      relayKey: 'fixture',
      fetchImpl: async () => Response.json({ status: 'failed', code: 70000, billingPending: true }),
    });
    expect(await client.query('seedance:operation-1234')).toEqual({
      status: 'failed',
      failure: { code: 'videogen-billing-pending' },
    });
  });
  it('false or absent billingPending retains the ordinary failure without asserting a refund', async () => {
    for (const billingPending of [false, undefined, 'true']) {
      const client = createVideogenRelayClient({
        baseUrl: 'https://relay.example',
        relayKey: 'fixture',
        fetchImpl: async () => Response.json({ status: 'failed', code: 0, billingPending }),
      });
      expect(await client.query('seedance:operation-1234')).toEqual({
        status: 'failed',
        failure: { code: 'videogen-task-failed', upstreamCode: 0 },
      });
    }
  });
});
