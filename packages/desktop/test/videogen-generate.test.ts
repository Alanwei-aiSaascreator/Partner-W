import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';

/**
 * 2026-10-12 视频接入：`generateVideosFromMessage` 的编排（create → poll → download →
 * verify → save）与全部失败路径。
 *
 * 把 `save.js` 打桩（不碰 DB）与 `debug` 打桩（不写日志文件），客户端整个注入 ——
 * 这个文件钉的是**编排的决策**：什么时候**不发请求**（重放）、什么时候**不发第二次**
 * （网络容忍）、什么时候**不落盘**（下载不完整）、失败码是不是用户能读懂的那个。
 *
 * ⚠️ 最值钱的一条是**重放跳过发生在创建之前**：视频是付费远端任务，
 *    重复处理 = 重复付钱。`client.create` 的调用次数就是断言对象。
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

const { generateVideosFromMessage } = await import('../src/main/videogen/generate.js');
type Client = import('../src/main/videogen/client.js').VideogenRelayClient;

const TASK_ID = 'task-video';
const MESSAGE_ID = 'msg-video';

function block(json: unknown): string {
  return ['```videogen', JSON.stringify(json), '```'].join('\n');
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

function fakeClient(overrides: Partial<Client> = {}): Client & {
  create: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
} {
  const queryQueue: unknown[] = [];
  const client = {
    create: vi.fn(async () => ({ ok: true as const, taskId: 'task-1' })),
    query: vi.fn(async () => queryQueue.shift() ?? { status: 'running' as const }),
    download: vi.fn(async () => ({ ok: true as const, buffer: mp4Buffer() })),
    ...overrides,
  };
  (client as unknown as { __queryQueue: unknown[] }).__queryQueue = queryQueue;
  return client as never;
}

function makeQueue(client: ReturnType<typeof fakeClient>, items: unknown[]): void {
  (client as unknown as { __queryQueue: unknown[] }).__queryQueue.push(...items);
}

beforeEach(() => {
  setWorkspaceDatabaseOwner({});
  mocks.saveArtifactFromBuffer.mockClear();
  mocks.findReplayArtifact.mockReset();
  mocks.findReplayArtifact.mockReturnValue(null);
});

describe('generateVideosFromMessage（编排）', () => {
  it('全链：create → 轮询到 FINISH → 下载 → 校验 → 落盘（活动相位如实上报）', async () => {
    const client = fakeClient();
    makeQueue(client, [
      { status: 'running' },
      { status: 'finished', outputSeconds: 4, inputSeconds: 0, inputImageCount: 0, resolution: '768P' },
    ]);
    const phases: string[] = [];

    const result = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: '一只猫打盹', duration: 4, title: '小猫' }),
      client,
      onActivity: (phase) => phases.push(phase),
      pollIntervalMs: 1,
    });

    expect(result.failed).toEqual([]);
    expect(result.saved).toHaveLength(1);
    expect(client.create).toHaveBeenCalledTimes(1);
    // 第二个参数 = 稳定逻辑身份（R8-06）；H3 通道不产出 id，所以是显式的 undefined。
    expect(client.create).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '一只猫打盹', duration: 4 }),
      undefined,
    );
    expect(client.query).toHaveBeenCalledTimes(2);
    expect(client.download).toHaveBeenCalledWith('task-1');
    const saveParams = mocks.saveArtifactFromBuffer.mock.calls[0][0] as Record<string, unknown>;
    expect(saveParams.fileName).toBe('小猫.mp4');
    // ⭐ BUG-120：视频登记专属类型 `video`（改型前是 'file'，与 docx/pptx 混在一档）。
    expect(saveParams.artifactType).toBe('video');
    expect(String(saveParams.sourceKey)).toMatch(/^videogen:[0-9a-f]{16}$/);
    expect(phases).toEqual(['generating-video', 'saving-artifacts']);
  });

  it('⭐ 重放：同消息同内容已有可用产物 ⇒ **一个远端请求都不发**（防重复付费）', async () => {
    const client = fakeClient();
    const existing = { id: 'old-1', name: '小猫.mp4', availability: 'available' };
    mocks.findReplayArtifact.mockReturnValue(existing);

    const result = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: '一只猫打盹', title: '小猫' }),
      client,
      pollIntervalMs: 1,
    });

    expect(client.create).not.toHaveBeenCalled();
    expect(result.saved).toEqual([existing]);
    expect(result.failed).toEqual([]);
  });

  it('内容安全拦截（ErrCode 70000 经 relay 透传）⇒ content-rejected；零费、不下载、不落盘', async () => {
    const client = fakeClient();
    makeQueue(client, [{ status: 'failed', failure: { code: 'videogen-content-rejected' } }]);

    const result = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: '被拦的描述' }),
      client,
      pollIntervalMs: 1,
    });

    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([{ code: 'videogen-content-rejected' }]);
    expect(client.download).not.toHaveBeenCalled();
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('轮询网络瞬断容忍：连续失败 2 次后成功 ⇒ 不判死（付费任务不该被一次断网毁掉）', async () => {
    const client = fakeClient();
    makeQueue(client, [
      { status: 'failed', failure: { code: 'videogen-task-failed', upstreamCode: null } },
      { status: 'failed', failure: { code: 'videogen-task-failed', upstreamCode: null } },
      { status: 'finished', outputSeconds: 4, inputSeconds: 0, inputImageCount: 0, resolution: '768P' },
    ]);
    const result = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: 'x' }),
      client,
      pollIntervalMs: 1,
    });
    expect(result.saved).toHaveLength(1);
    expect(result.failed).toEqual([]);
  });

  it('连续失败到容忍上限 ⇒ 判失败（不会无限转下去）', async () => {
    const client = fakeClient();
    const failItem = { status: 'failed', failure: { code: 'videogen-task-failed', upstreamCode: null } };
    makeQueue(client, [failItem, failItem, failItem, failItem]);
    const result = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: 'x' }),
      client,
      pollIntervalMs: 1,
    });
    expect(result.failed).toEqual([{ code: 'videogen-task-failed', upstreamCode: null }]);
  });

  it('超时：deadline 到仍在 running ⇒ videogen-timeout（带 waitedMs），不下载不落盘', async () => {
    const client = fakeClient();
    let t = 0;
    const result = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: 'x' }),
      client,
      pollIntervalMs: 1000,
      deadlineMs: 5000,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(result.saved).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].code).toBe('videogen-timeout');
    if (result.failed[0].code === 'videogen-timeout') expect(result.failed[0].waitedMs).toBeGreaterThanOrEqual(5000);
    expect(client.download).not.toHaveBeenCalled();
  });

  it('下载不完整（截断 mp4）⇒ download-failed；**不进登记门**', async () => {
    const client = fakeClient();
    makeQueue(client, [
      { status: 'finished', outputSeconds: 4, inputSeconds: 0, inputImageCount: 0, resolution: '768P' },
    ]);
    const full = mp4Buffer();
    client.download = vi.fn(async () => ({ ok: true as const, buffer: full.subarray(0, full.length - 10) }));

    const result = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: 'x' }),
      client,
      pollIntervalMs: 1,
    });
    expect(result.failed).toEqual([{ code: 'videogen-download-failed' }]);
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  });

  it('create 被拒 ⇒ create-failed(带 httpStatus)；save 抛错 ⇒ save-failed（都不外抛）', async () => {
    const rejected = fakeClient({
      create: vi.fn(async () => ({
        ok: false as const,
        failure: { code: 'videogen-create-failed' as const, httpStatus: 402 },
      })),
    });
    const first = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: 'x' }),
      client: rejected,
      pollIntervalMs: 1,
    });
    expect(first.failed).toEqual([{ code: 'videogen-create-failed', httpStatus: 402 }]);

    const okClient = fakeClient();
    makeQueue(okClient, [
      { status: 'finished', outputSeconds: 4, inputSeconds: 0, inputImageCount: 0, resolution: '768P' },
    ]);
    mocks.saveArtifactFromBuffer.mockRejectedValueOnce(new Error('disk full'));
    const second = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: '写盘失败的' }),
      client: okClient,
      pollIntervalMs: 1,
    });
    expect(second.failed).toEqual([{ code: 'videogen-save-failed' }]);
  });

  it('块校验失败照旧上报；多块一份坏一份好 ⇒ 好的照做', async () => {
    const client = fakeClient();
    makeQueue(client, [
      { status: 'finished', outputSeconds: 4, inputSeconds: 0, inputImageCount: 0, resolution: '768P' },
    ]);
    const content = [block({ prompt: 'x', imageUrl: 'y' }), block({ prompt: '好的' })].join('\n');
    const result = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content,
      client,
      pollIntervalMs: 1,
    });
    expect(result.failed).toEqual([{ code: 'videogen-unsupported-field', field: 'imageUrl' }]);
    expect(result.saved).toHaveLength(1);
    expect(client.create).toHaveBeenCalledTimes(1);
  });
});

it('billing pending is a terminal generation failure: no retry loop, download or artifact', async () => {
  const client = fakeClient();
  makeQueue(client, [{ status: 'failed', failure: { code: 'videogen-billing-pending' } }]);
  const result = await generateVideosFromMessage({
    workspacePath: 'C:/ws',
    taskId: TASK_ID,
    messageId: MESSAGE_ID,
    content: block({ prompt: 'flower' }),
    client,
    pollIntervalMs: 1,
  });
  expect(result.failed).toEqual([{ code: 'videogen-billing-pending' }]);
  expect(result.saved).toEqual([]);
  expect(client.query).toHaveBeenCalledTimes(1);
  expect(client.download).not.toHaveBeenCalled();
  expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
});

it('canceled source before entry makes no create, replay, or activity calls', async () => {
  const client = fakeClient(),
    activity = vi.fn();
  const result = await generateVideosFromMessage({
    workspacePath: 'C:/ws',
    taskId: TASK_ID,
    messageId: MESSAGE_ID,
    content: block({ prompt: 'flower' }),
    client,
    sourceCurrent: () => false,
    onActivity: activity,
  });
  expect(result).toEqual({ saved: [], failed: [] });
  expect(client.create).not.toHaveBeenCalled();
  expect(mocks.findReplayArtifact).not.toHaveBeenCalled();
  expect(activity).not.toHaveBeenCalled();
});
it.each(['create', 'query', 'download', 'save'] as const)(
  'source cancellation while awaiting %s prevents subsequent side effects',
  async (stage) => {
    let current = true;
    const client = fakeClient();
    client.create.mockImplementationOnce(async () => {
      if (stage === 'create') current = false;
      return { ok: true, taskId: 'provider-1' };
    });
    client.query.mockImplementationOnce(async () => {
      if (stage === 'query') current = false;
      return { status: 'finished', outputSeconds: 4, inputSeconds: 0, inputImageCount: 0, resolution: '768P' };
    });
    client.download.mockImplementationOnce(async () => {
      if (stage === 'download') current = false;
      return { ok: true, buffer: mp4Buffer() };
    });
    if (stage === 'save')
      mocks.saveArtifactFromBuffer.mockImplementationOnce(async (params) => {
        current = false;
        return {
          id: 'late',
          name: String(params.fileName),
          taskId: params.taskId,
          messageId: params.messageId,
          availability: 'available',
          ...params,
        };
      });
    const result = await generateVideosFromMessage({
      workspacePath: 'C:/ws',
      taskId: TASK_ID,
      messageId: MESSAGE_ID,
      content: block({ prompt: 'flower' }),
      client,
      sourceCurrent: () => current,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ saved: [], failed: [] });
    if (stage === 'create') expect(client.query).not.toHaveBeenCalled();
    if (stage === 'create' || stage === 'query') expect(client.download).not.toHaveBeenCalled();
    if (stage !== 'save') expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  },
);

it('canceling from the saving activity callback prevents persistence', async () => {
  let current = true;
  const client = fakeClient();
  makeQueue(client, [
    { status: 'finished', outputSeconds: 4, inputSeconds: 0, inputImageCount: 0, resolution: '768P' },
  ]);
  const result = await generateVideosFromMessage({
    workspacePath: 'C:/ws',
    taskId: TASK_ID,
    messageId: MESSAGE_ID,
    content: block({ prompt: 'flower' }),
    client,
    sourceCurrent: () => current,
    onActivity: (phase) => {
      if (phase === 'saving-artifacts') current = false;
    },
  });
  expect(result).toEqual({ saved: [], failed: [] });
  expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
});
it('source cancellation during polling sleep cannot make a second query', async () => {
  let current = true;
  const client = fakeClient();
  makeQueue(client, [{ status: 'running' }]);
  const result = await generateVideosFromMessage({
    workspacePath: 'C:/ws',
    taskId: TASK_ID,
    messageId: MESSAGE_ID,
    content: block({ prompt: 'flower' }),
    client,
    sourceCurrent: () => current,
    sleep: async () => {
      current = false;
    },
  });
  expect(result).toEqual({ saved: [], failed: [] });
  expect(client.query).toHaveBeenCalledTimes(1);
  expect(client.download).not.toHaveBeenCalled();
});
