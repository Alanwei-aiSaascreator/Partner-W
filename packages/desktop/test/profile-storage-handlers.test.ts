/**
 * M3（BUG-034）主进程侧合同测试：`profile:flush-storage` handler。
 *
 * 覆盖：受信 sender（prod file:// 白名单内 / dev 同源）→ `requested:true` 且真实调用
 * `flushStorageData`；非受信来源 / senderFrame 缺失 → 拒绝且不调用；flush 抛错 →
 * 明确失败（不冒充成功）；handler 不读渲染层参数；退出路径 helper 绝不外抛。
 *
 * ⚠️ `requested:true` 只代表"已发起刷新请求"——Electron 34 该 API 无完成回执，
 *    用例断言的是调用事实，不是物理落盘。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler);
    }),
  },
  shell: { openExternal: vi.fn() },
}));

const loggerInfo = vi.fn();
const loggerWarn = vi.fn();
vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => ({ info: loggerInfo, warn: loggerWarn }),
}));

import {
  registerProfileStorageHandlers,
  requestSessionFlushBestEffort,
} from '../src/main/ipc/profile-storage-handlers.js';

let root = '';
let rendererDir = '';
let indexUrl = '';

beforeEach(() => {
  handleMap.clear();
  loggerInfo.mockClear();
  loggerWarn.mockClear();
  root = mkdtempSync(join(tmpdir(), 'profile-flush-'));
  rendererDir = join(root, 'renderer');
  mkdirSync(rendererDir, { recursive: true });
  writeFileSync(join(rendererDir, 'index.html'), '<html></html>');
  indexUrl = pathToFileURL(join(rendererDir, 'index.html')).href;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function register(options?: { appRendererDir?: string; devOrigin?: string | null }): (...args: unknown[]) => unknown {
  registerProfileStorageHandlers({ appRendererDir: rendererDir, devOrigin: null, ...options });
  const handler = handleMap.get('profile:flush-storage');
  expect(handler).toBeTypeOf('function');
  return handler as (...args: unknown[]) => unknown;
}

function makeEvent(
  url: string | null,
  flushStorageData: ReturnType<typeof vi.fn> = vi.fn(),
): { event: unknown; flushStorageData: ReturnType<typeof vi.fn> } {
  const event = {
    senderFrame: url === null ? null : { url },
    sender: { session: { flushStorageData } },
  };
  return { event, flushStorageData };
}

describe('profile:flush-storage（M3 / BUG-034）', () => {
  it('受信渲染页面（prod file:// 白名单内）→ requested:true，且真实调用了 flushStorageData', async () => {
    const handler = register();
    const { event, flushStorageData } = makeEvent(indexUrl);
    const result = await handler(event);
    expect(result).toEqual({ ok: true, result: { requested: true } });
    expect(flushStorageData).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalled();
  });

  it('dev 同源（ELECTRON_RENDERER_URL）→ 放行', async () => {
    const handler = register({ devOrigin: 'http://localhost:5173' });
    const { event, flushStorageData } = makeEvent('http://localhost:5173/index.html');
    const result = await handler(event);
    expect(result).toEqual({ ok: true, result: { requested: true } });
    expect(flushStorageData).toHaveBeenCalledTimes(1);
  });

  it('白名单外的 file:// → 拒绝且不调用 flush', async () => {
    const outsider = join(root, 'outside.html');
    writeFileSync(outsider, '<html></html>');
    const handler = register();
    const { event, flushStorageData } = makeEvent(pathToFileURL(outsider).href);
    const result = await handler(event);
    expect(result).toEqual({ ok: false, error: 'untrusted sender', errorCode: 'profile-flush-untrusted-sender' });
    expect(flushStorageData).not.toHaveBeenCalled();
  });

  it('http(s)/javascript/系统盘 file 等非应用来源 → 一律拒绝', async () => {
    const handler = register();
    for (const url of [
      'https://example.com/',
      'javascript:void(0)',
      'http://localhost:5173/index.html', // dev 未开启时同源也不算
      'file:///C:/Windows/does-not-exist-evil.html',
    ]) {
      const { event, flushStorageData } = makeEvent(url);
      const result = (await handler(event)) as { ok: boolean };
      expect(result.ok).toBe(false);
      expect(flushStorageData).not.toHaveBeenCalled();
    }
  });

  it('senderFrame 缺失 → 拒绝且不调用 flush', async () => {
    const handler = register();
    const { event, flushStorageData } = makeEvent(null);
    const result = await handler(event);
    expect(result).toEqual({ ok: false, error: 'untrusted sender', errorCode: 'profile-flush-untrusted-sender' });
    expect(flushStorageData).not.toHaveBeenCalled();
  });

  it('flushStorageData 抛错 → 明确失败（不冒充成功）', async () => {
    const handler = register();
    const { event } = makeEvent(
      indexUrl,
      vi.fn(() => {
        throw new Error('disk gone');
      }),
    );
    const result = await handler(event);
    expect(result).toEqual({ ok: false, error: 'flush request failed', errorCode: 'profile-flush-failed' });
    expect(loggerWarn).toHaveBeenCalled();
  });

  it('渲染层传任意参数也左右不了目标 —— handler 不读第二个参数', async () => {
    const handler = register();
    const { event, flushStorageData } = makeEvent(indexUrl);
    const result = await handler(event, { partition: 'persist:evil', path: 'C:/x' });
    expect(result).toEqual({ ok: true, result: { requested: true } });
    expect(flushStorageData).toHaveBeenCalledTimes(1);
  });
});

describe('requestSessionFlushBestEffort（退出路径 helper）', () => {
  it('正常 session → true 且调用', () => {
    const flush = vi.fn();
    expect(requestSessionFlushBestEffort({ flushStorageData: flush })).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('null / 无方法 → false，不抛', () => {
    expect(requestSessionFlushBestEffort(null)).toBe(false);
    expect(requestSessionFlushBestEffort(undefined)).toBe(false);
    expect(requestSessionFlushBestEffort({})).toBe(false);
  });

  it('抛错 → false，绝不外抛', () => {
    expect(
      requestSessionFlushBestEffort({
        flushStorageData: () => {
          throw new Error('boom');
        },
      }),
    ).toBe(false);
  });
});
