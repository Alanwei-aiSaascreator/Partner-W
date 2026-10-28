import { describe, expect, it } from 'vitest';
import { createImagegenRelayClient } from '../src/main/imagegen/client.js';
import type { ImagegenRequest } from '../src/main/imagegen/request.js';

/**
 * B3 图片 —— **真实 relay 客户端**（`createImagegenRelayClient`）的 HTTP 边界契约。
 *
 * `imagegen-client.test.ts` 钉的是失败态（网络失败 / 能力缺失 / 错误 MIME / 超长）。
 * 「create 接受（202 且回显同一 requestId）」「query 的 running/finished」「download 的
 * 流式取字节」这三条成功路径**此前没有测试**，而它们正是"一次付费请求被正确认领"与
 * "PNG 本体被取回"的落点。形状漂了会表现为静默重复提交或误报失败。
 *
 * 端点是 relay 真源（B 树 `services/relay/src/imagegen-routes.ts`）：`GET /v1/imagegen/capabilities`、
 * `POST /v1/imagegen`（成功 202 `{requestId}`）、`GET /v1/imagegen/:requestId`、`GET /v1/imagegen/:requestId/file`。
 */

const request: ImagegenRequest = {
  model: 'qwen-image-plus',
  prompt: 'A mountain',
  size: '1328*1328',
  title: 'Mountain',
  operationId: 'mountain-001',
};
const REQUEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function make(fetchImpl: typeof fetch) {
  return createImagegenRelayClient({ baseUrl: 'https://relay.example/relay', relayKey: 'customer-key', fetchImpl });
}

/** 最小合法 PNG（供 download 成功路径断言逐字节一致）。 */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000530000005300802000000000000000000000049454e4400000000',
  'hex',
);

describe('imagegen relay client — create（认领一次付费请求）', () => {
  it('202 且回显同一 requestId ⇒ ok；请求体只含 model/prompt/size/requestId', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      calls.push([String(url), init]);
      return Response.json({ requestId: REQUEST_ID }, { status: 202 });
    }) as typeof fetch;
    expect(await make(fetchImpl).create(request, REQUEST_ID)).toEqual({ ok: true, queued: false });
    expect(calls[0][0]).toBe('https://relay.example/relay/v1/imagegen');
    expect(calls[0][1]?.method).toBe('POST');
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer customer-key');
    expect(JSON.parse(String(calls[0][1]?.body))).toEqual({
      requestId: REQUEST_ID,
      model: request.model,
      prompt: request.prompt,
      size: request.size,
    });
  });

  it('2xx 但不是 202，或回显了别的 requestId ⇒ 未确认（绝不当作已认领）', async () => {
    const replay = make((async () => Response.json({ requestId: REQUEST_ID }, { status: 200 })) as typeof fetch);
    expect(await replay.create(request, REQUEST_ID)).toEqual({ ok: false, code: 'imagegen-request-unconfirmed' });
    const mismatch = make((async () =>
      Response.json({ requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, { status: 202 })) as typeof fetch);
    expect(await mismatch.create(request, REQUEST_ID)).toEqual({ ok: false, code: 'imagegen-request-unconfirmed' });
  });

  it('媒体关闭（503）⇒ imagegen-unavailable（与"结果未确认"分开，前者不该保留操作号重试）', async () => {
    const fetchImpl = (async () =>
      Response.json({ error: { code: 'imagegen-unavailable' } }, { status: 503 })) as typeof fetch;
    expect(await make(fetchImpl).create(request, REQUEST_ID)).toEqual({ ok: false, code: 'imagegen-unavailable' });
  });

  it('409（占额被拒 / 冲突）⇒ 未确认，且只发一次 POST（不重试、不换 id）', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return Response.json({ error: { code: 'imagegen-request-conflict' } }, { status: 409 });
    }) as typeof fetch;
    expect(await make(fetchImpl).create(request, REQUEST_ID)).toEqual({
      ok: false,
      code: 'imagegen-request-unconfirmed',
    });
    expect(calls).toBe(1);
  });
});

describe('imagegen relay client — capabilities（能力门）', () => {
  it('enabled + 正确模型 + 含请求尺寸 ⇒ true（三者缺一即 false）', async () => {
    const caps = (body: unknown) => make((async () => Response.json(body)) as typeof fetch);
    expect(
      await caps({ enabled: true, model: 'qwen-image-plus', sizes: ['1328*1328'] }).capabilities('1328*1328'),
    ).toBe(true);
    expect(await caps({ enabled: true, model: 'other-model', sizes: ['1328*1328'] }).capabilities('1328*1328')).toBe(
      false,
    );
    expect(
      await caps({ enabled: false, model: 'qwen-image-plus', sizes: ['1328*1328'] }).capabilities('1328*1328'),
    ).toBe(false);
  });
});

describe('imagegen relay client — query（异步完成）', () => {
  it('running 与 finished 原样透传', async () => {
    const running = make((async () => Response.json({ status: 'running' })) as typeof fetch);
    expect(await running.query(REQUEST_ID)).toEqual({ status: 'running' });
    const finished = make((async () =>
      Response.json({ status: 'finished', width: 1328, height: 1328 })) as typeof fetch);
    expect(await finished.query(REQUEST_ID)).toEqual({ status: 'finished' });
  });

  it('422 ⇒ 生成失败；其余非 2xx（404/409/502/503）⇒ 结果未确认（不谎报失败也不谎报成功）', async () => {
    const code422 = make((async () =>
      Response.json({ error: { code: 'imagegen-generation-failed' } }, { status: 422 })) as typeof fetch);
    expect(await code422.query(REQUEST_ID)).toEqual({ status: 'failed', code: 'imagegen-generation-failed' });
    for (const status of [404, 409, 502, 503]) {
      const client = make((async () => Response.json({}, { status })) as typeof fetch);
      expect(await client.query(REQUEST_ID)).toEqual({ status: 'failed', code: 'imagegen-result-unconfirmed' });
    }
  });
});

describe('imagegen relay client — download（取 PNG 本体）', () => {
  it('image/png 且流完整 ⇒ 逐字节返回', async () => {
    const fetchImpl = (async () =>
      new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })) as typeof fetch;
    const result = await make(fetchImpl).download(REQUEST_ID);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.equals(PNG)).toBe(true);
  });

  it('缺少 image/png 声明 ⇒ image-invalid（不把 JSON 错误页当图片）', async () => {
    const fetchImpl = (async () =>
      Response.json({ error: { code: 'imagegen-request-pending' } }, { status: 409 })) as typeof fetch;
    expect(await make(fetchImpl).download(REQUEST_ID)).toEqual({ ok: false, code: 'imagegen-image-invalid' });
  });
});
