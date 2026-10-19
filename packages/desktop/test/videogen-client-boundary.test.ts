import { describe, expect, it } from 'vitest';
import { createVideogenRelayClient } from '../src/main/videogen/client.js';
import type { VideogenRequest } from '../src/main/videogen/request.js';

/**
 * B5 视频 —— **真实 relay 客户端**（`createVideogenRelayClient`）的 HTTP 边界契约。
 *
 * 为什么单独钉这条：`videogen-generate.test.ts` / `videogen-start.test.ts` 都**注入桩客户端**，
 * 它们钉的是编排的决策；`videogen-seedance.test.ts` 只覆盖了 create 成功与 query 的失败态。
 * 「POST→GET 异步完成」「真实计费秒数」「取文件校验」这三条恰恰**只发生在真实客户端**里
 * —— 没有测试守着时，形状漂了（上游改名/换字段）在生产里表现为"静默拿不到结果或算成 0 秒"。
 *
 * 端点是 relay 侧的真源（B 树 `services/relay/src/index.ts` 的 `/v1/videos*` 与
 * `seedance-routes.ts` 的 `/v1/seedance/videos`）：H3 创建走 `/v1/videos`，
 * Seedance 创建走 `/v1/seedance/videos`，**轮询与取文件两者共用**
 * `/v1/videos/:taskId`、`/v1/videos/:taskId/file`。
 */

const h3Request: VideogenRequest = {
  prompt: '一只猫打盹',
  duration: 10,
  resolution: '768P',
  aspectRatio: '16:9',
  title: '',
};
const seedanceRequest: VideogenRequest = {
  model: 'seedance-2.5',
  prompt: '一只猫打盹',
  duration: 5,
  resolution: '720P',
  aspectRatio: '16:9',
  title: '',
};

function make(fetchImpl: typeof fetch) {
  return createVideogenRelayClient({ baseUrl: 'https://relay.example/relay/', relayKey: 'relay-key-1', fetchImpl });
}

function capture(responses: Array<Response | Error>): {
  fetchImpl: typeof fetch;
  calls: Array<[string, RequestInit | undefined]>;
} {
  const calls: Array<[string, RequestInit | undefined]> = [];
  let index = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    calls.push([String(url), init]);
    const next = responses[index++];
    if (next instanceof Error) throw next;
    return next ?? new Response(null, { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe('videogen relay client — create', () => {
  it('H3 创建：POST /v1/videos，恰好四个参数键，带 Bearer 认证', async () => {
    const { fetchImpl, calls } = capture([Response.json({ taskId: 'job-1' })]);
    const result = await make(fetchImpl).create(h3Request);
    expect(result).toEqual({ ok: true, taskId: 'job-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('https://relay.example/relay/v1/videos');
    expect(calls[0][1]?.method).toBe('POST');
    const headers = calls[0][1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer relay-key-1');
    expect(headers['content-type']).toBe('application/json');
    expect(Object.keys(JSON.parse(String(calls[0][1]?.body)) as Record<string, unknown>).sort()).toEqual([
      'aspectRatio',
      'duration',
      'prompt',
      'resolution',
    ]);
  });

  it('Seedance 创建：POST /v1/seedance/videos，requestId 与首帧字节随体发出', async () => {
    const { fetchImpl, calls } = capture([Response.json({ taskId: 'seedance:abc-12345678' })]);
    const result = await make(fetchImpl).create(
      { ...seedanceRequest, firstFrameData: { mimeType: 'image/png', content: 'AAAA' } },
      'abc-12345678',
    );
    expect(result).toEqual({ ok: true, taskId: 'seedance:abc-12345678' });
    expect(calls[0][0]).toBe('https://relay.example/relay/v1/seedance/videos');
    expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({
      requestId: 'abc-12345678',
      firstFrame: { mimeType: 'image/png', content: 'AAAA' },
    });
  });

  it('2xx 但没有 taskId ⇒ create-failed 且带真实状态码（不误判成功、不静默）', async () => {
    const { fetchImpl } = capture([Response.json({ ok: true })]);
    expect(await make(fetchImpl).create(h3Request)).toEqual({
      ok: false,
      failure: { code: 'videogen-create-failed', httpStatus: 200 },
    });
    const blank = capture([Response.json({ taskId: '   ' })]);
    expect(await make(blank.fetchImpl).create(h3Request)).toEqual({
      ok: false,
      failure: { code: 'videogen-create-failed', httpStatus: 200 },
    });
  });

  it('媒体关闭（relay 503）⇒ create-failed 带 503（上游未创建任务，不假装已提交）', async () => {
    const { fetchImpl } = capture([Response.json({ error: { code: 'seedance-unavailable' } }, { status: 503 })]);
    expect(await make(fetchImpl).create(seedanceRequest, 'abc-12345678')).toEqual({
      ok: false,
      failure: { code: 'videogen-create-failed', httpStatus: 503 },
    });
  });

  it('网络层失败 ⇒ httpStatus 0（与"服务端拒绝"区分，前端文案判定要用它）', async () => {
    const { fetchImpl } = capture([new Error('socket hang up')]);
    expect(await make(fetchImpl).create(h3Request)).toEqual({
      ok: false,
      failure: { code: 'videogen-create-failed', httpStatus: 0 },
    });
  });
});

describe('videogen relay client — query（POST→GET 异步完成）', () => {
  it('running 状态原样透传（调用方继续轮询）', async () => {
    const { fetchImpl, calls } = capture([Response.json({ status: 'running', taskId: 'job-1' })]);
    expect(await make(fetchImpl).query('job-1')).toEqual({ status: 'running' });
    expect(calls[0][0]).toBe('https://relay.example/relay/v1/videos/job-1');
    expect(calls[0][1]?.method).toBeUndefined();
  });

  it('finished：真实计费秒数逐字段解析（输出+输入+首帧计数+分辨率）', async () => {
    const { fetchImpl } = capture([
      Response.json({
        status: 'finished',
        taskId: 'job-1',
        resolution: '2K',
        usage: { outputSeconds: 10, inputSeconds: 3, inputImageCount: 1 },
      }),
    ]);
    expect(await make(fetchImpl).query('job-1')).toEqual({
      status: 'finished',
      outputSeconds: 10,
      inputSeconds: 3,
      inputImageCount: 1,
      resolution: '2K',
    });
  });

  it('finished：缺 usage/空白分辨率 ⇒ 归零与 null（不臆造秒数，不把空串当分辨率）', async () => {
    const { fetchImpl } = capture([Response.json({ status: 'finished', resolution: '   ' })]);
    expect(await make(fetchImpl).query('job-1')).toEqual({
      status: 'finished',
      outputSeconds: 0,
      inputSeconds: 0,
      inputImageCount: 0,
      resolution: null,
    });
  });

  it('finished：负数/非整秒被夹取（-5 ⇒ 0，3.9 ⇒ 3），不向上游要负数账', async () => {
    const { fetchImpl } = capture([
      Response.json({ status: 'finished', usage: { outputSeconds: -5, inputSeconds: 3.9, inputImageCount: 1.2 } }),
    ]);
    expect(await make(fetchImpl).query('job-1')).toMatchObject({
      status: 'finished',
      outputSeconds: 0,
      inputSeconds: 3,
      inputImageCount: 1,
    });
  });

  it('未知状态 ⇒ 当作还没好继续等（有 deadline 兜底，不武断判败）', async () => {
    const { fetchImpl } = capture([Response.json({ status: 'queued' })]);
    expect(await make(fetchImpl).query('job-1')).toEqual({ status: 'running' });
  });

  it('网络瞬断与 HTTP 非 2xx ⇒ task-failed(upstreamCode:null)（调用方按连续容忍计数处理）', async () => {
    const net = capture([new Error('timeout')]);
    expect(await make(net.fetchImpl).query('job-1')).toEqual({
      status: 'failed',
      failure: { code: 'videogen-task-failed', upstreamCode: null },
    });
    const http = capture([new Response('boom', { status: 502 })]);
    expect(await make(http.fetchImpl).query('job-1')).toEqual({
      status: 'failed',
      failure: { code: 'videogen-task-failed', upstreamCode: null },
    });
  });

  it('上游失败码透传：非 70000 保留 code，70000 归一成内容安全拦截', async () => {
    const other = capture([Response.json({ status: 'failed', code: 1002 })]);
    expect(await make(other.fetchImpl).query('job-1')).toEqual({
      status: 'failed',
      failure: { code: 'videogen-task-failed', upstreamCode: 1002 },
    });
    const safety = capture([Response.json({ status: 'failed', code: 70000 })]);
    expect(await make(safety.fetchImpl).query('job-1')).toEqual({
      status: 'failed',
      failure: { code: 'videogen-content-rejected' },
    });
  });
});

describe('videogen relay client — download（取文件）', () => {
  it('成功：GET …/file，Authorization 只进头，返回原始字节', async () => {
    const payload = Buffer.from('mp4-bytes');
    const { fetchImpl, calls } = capture([new Response(payload, { status: 200 })]);
    const result = await make(fetchImpl).download('seedance:abc');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.buffer.equals(payload)).toBe(true);
    expect(calls[0][0]).toBe('https://relay.example/relay/v1/videos/seedance%3Aabc/file');
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer relay-key-1');
  });

  it('非 2xx（含媒体关闭）与网络失败一律 download-failed，绝不落盘', async () => {
    const http = capture([new Response('nope', { status: 404 })]);
    expect(await make(http.fetchImpl).download('job-1')).toEqual({
      ok: false,
      failure: { code: 'videogen-download-failed' },
    });
    const net = capture([new Error('aborted')]);
    expect(await make(net.fetchImpl).download('job-1')).toEqual({
      ok: false,
      failure: { code: 'videogen-download-failed' },
    });
  });
});
