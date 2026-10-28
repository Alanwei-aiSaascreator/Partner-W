// @vitest-environment jsdom

/**
 * 「这条侧会话是不是我建的」——`useSystemSession` 的卸载清理边界（2026-10-05）。
 *
 * 背景（AI 创建建队排查）：侧会话 store 是**全局单例**，而 `start()` 在别人正占着时
 * 会回 `SESSION_BUSY`。旧实现无条件把 `activeRef` 置 true，于是：
 * 目标分析正在跑 → 用户打开「AI 创建」→ start 被拒 → 组件卸载时那次清理
 * **把目标分析的会话 `end()` 掉了**（掐掉别人的活儿，且不留痕迹）。
 *
 * 判据：只有 `SESSION_BUSY` 之外的失败才可能是"我们自己留下来的会话"（服务在
 * createSession/patchSession 失败时已自行回滚；首条消息发送失败则会话仍在我们名下）。
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_SESSION_BUSY } from '@clawwork/core';

const service = vi.hoisted(() => ({
  start: vi.fn(async () => ({ ok: true }) as { ok: boolean; error?: string; errorCode?: string }),
  send: vi.fn(async () => ({ ok: true })),
  end: vi.fn(async () => undefined),
}));

vi.mock('../src/renderer/platform', () => ({
  systemSessionService: service,
  useSystemSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ status: 'idle', messages: [], error: null, sessionKey: null }),
}));

import { useSystemSession } from '../src/renderer/hooks/useSystemSession';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let api: ReturnType<typeof useSystemSession> | null = null;

function Harness() {
  api = useSystemSession();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  api = null;
});

afterEach(() => {
  // 用例里可能已经自己卸载过（要观察卸载那一刻的清理），第二次卸载容错即可
  try {
    act(() => root.unmount());
  } catch {
    /* already unmounted */
  }
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(<Harness />);
  });
}

async function start(): Promise<{ ok: boolean; error?: string; errorCode?: string }> {
  let res: { ok: boolean; error?: string; errorCode?: string } = { ok: false };
  await act(async () => {
    res = await api!.start({ gatewayId: 'gw-1', agentId: 'main', purpose: 'team-builder' });
  });
  return res;
}

describe('useSystemSession 的会话归属', () => {
  it('⭐ SESSION_BUSY（会话是别人的）⇒ 卸载清理不许替别人 end()', async () => {
    service.start.mockResolvedValueOnce({
      ok: false,
      error: 'system session already active',
      errorCode: SYSTEM_SESSION_BUSY,
    });
    await mount();
    const res = await start();
    expect(res.ok).toBe(false);

    act(() => root.unmount());
    expect(service.end).not.toHaveBeenCalled();
  });

  it('自己建起的会话 ⇒ 卸载清理照旧收尾（正向对照，证明上面那条不是把清理关掉了）', async () => {
    service.start.mockResolvedValueOnce({ ok: true });
    await mount();
    await start();

    act(() => root.unmount());
    expect(service.end).toHaveBeenCalledOnce();
  });

  it('其余失败（如 createSession 被拒）仍算自己的清理责任 —— 服务已回滚，end() 空跑无害', async () => {
    service.start.mockResolvedValueOnce({ ok: false, error: 'gateway not connected' });
    await mount();
    await start();

    act(() => root.unmount());
    expect(service.end).toHaveBeenCalledOnce();
  });
});
