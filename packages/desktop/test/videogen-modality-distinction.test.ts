import { beforeEach, expect, it, vi } from 'vitest';
import { setWorkspaceDatabaseOwner } from '../src/main/workspace/scope.js';
import { parseVideogenRequest } from '../src/main/videogen/request.js';

/**
 * B5 —— **文字 / 首帧图 / 参考视频** 三种形态必须被区分，不许静默降级。
 *
 * 产品边界（README C75 已如实登记）：Seedance 通道"当前仅文本 + 首帧图"，
 * 参考视频（编辑/延长）**未接**。未接不等于可以装作没看见 —— 一个带参考视频字段的
 * 请求必须被**显式拒绝并回显字段名**，绝不能被当成"文生视频"照发（那会花一笔真钱、
 * 出一个与用户意图不符的片子）。
 *
 * 本文件把三条形态判据分别钉住（判据真源：`src/main/videogen/request.ts` 的白名单）。
 */

const mocks = vi.hoisted(() => ({
  saveArtifactFromBuffer: vi.fn(async (params: Record<string, unknown>) => ({
    id: 'artifact',
    name: String(params.fileName),
    availability: 'available',
    ...params,
  })),
  findReplayArtifact: vi.fn(() => null),
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

beforeEach(() => {
  setWorkspaceDatabaseOwner({});
  mocks.saveArtifactFromBuffer.mockClear();
  mocks.findReplayArtifact.mockReset();
  mocks.findReplayArtifact.mockReturnValue(null);
});

it('文生视频：仅 prompt（H3 通道默认 10s / 768P / 16:9），不装载任何图片', () => {
  const parsed = parseVideogenRequest({ prompt: '一只猫打盹' });
  expect(parsed.ok).toBe(true);
  if (parsed.ok) {
    expect(parsed.request.model).toBeUndefined();
    expect(parsed.request.firstFrame).toBeUndefined();
    expect(parsed.request.duration).toBe(10);
    expect(parsed.request.resolution).toBe('768P');
    expect(parsed.request.aspectRatio).toBe('16:9');
  }
});

it('首帧图：只有显式 model=seedance-2.5 才认 firstFrame；比例必须 adaptive', () => {
  // 未点名候选模型却写 firstFrame ⇒ 拒（不许把 H3 当图生视频用）
  expect(parseVideogenRequest({ prompt: 'x', firstFrame: 'images/a.png' }).ok).toBe(false);
  const ok = parseVideogenRequest({ model: 'seedance-2.5', prompt: 'x', firstFrame: 'images/a.png' });
  expect(ok.ok).toBe(true);
  if (ok.ok) {
    expect(ok.request.firstFrame).toBe('images/a.png');
    expect(ok.request.aspectRatio).toBe('adaptive');
    expect(ok.request.resolution).toBe('720P');
  }
  // 带首帧却给非 adaptive 比例 ⇒ 拒（比例由首帧决定，不许用户/模型自行拍板）
  expect(
    parseVideogenRequest({ model: 'seedance-2.5', prompt: 'x', firstFrame: 'a.png', aspectRatio: '16:9' }).ok,
  ).toBe(false);
});

it.each(['videoUrl', 'referenceVideo', 'sourceVideo', 'imageUrl'])(
  '参考视频/参考图字段「%s」⇒ 显式 unsupported-field 且零创建，绝不降级成文生视频',
  async (field) => {
    const parsed = parseVideogenRequest({ model: 'seedance-2.5', prompt: '把这段素材延长 5 秒', [field]: 'clip.mp4' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.failure).toEqual({ code: 'videogen-unsupported-field', field });
    }

    // 生产入口：坏块 ⇒ 一个远端请求都不发（create 调用次数 = 付费边界）
    let created = 0;
    const content = [
      '```videogen',
      JSON.stringify({ model: 'seedance-2.5', prompt: '把这段素材延长 5 秒', [field]: 'clip.mp4' }),
      '```',
    ].join('\n');
    const result = await generateVideosFromMessage({
      workspacePath: 'C:/work',
      taskId: 'task',
      messageId: `msg-${field}`,
      content,
      pollIntervalMs: 1,
      client: {
        create: async () => {
          created += 1;
          return { ok: true, taskId: 'must-not-happen' };
        },
        query: async () => ({ status: 'running' }),
        download: async () => ({ ok: false, failure: { code: 'videogen-download-failed' } }),
      },
    });
    expect(created).toBe(0);
    expect(result.saved).toEqual([]);
    expect(result.failed).toEqual([{ code: 'videogen-unsupported-field', field }]);
    expect(mocks.saveArtifactFromBuffer).not.toHaveBeenCalled();
  },
);

it('同一块里既写 firstFrame 又写参考视频字段 ⇒ 整块拒（不挑一个字段悄悄执行）', () => {
  const parsed = parseVideogenRequest({
    model: 'seedance-2.5',
    prompt: 'x',
    firstFrame: 'images/a.png',
    videoUrl: 'clip.mp4',
  });
  expect(parsed.ok).toBe(false);
  if (!parsed.ok) expect(parsed.failure).toEqual({ code: 'videogen-unsupported-field', field: 'videoUrl' });
});
