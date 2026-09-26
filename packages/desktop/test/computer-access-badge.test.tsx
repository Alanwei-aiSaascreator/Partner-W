// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ComputerAccessBadge from '../src/renderer/components/ComputerAccessBadge';
import { rememberPermissionMode } from '../src/renderer/lib/computer-access-runtime';

/**
 * 档位徽章：**读回来的真值**决定显示什么。
 *
 * ⚠️ 这一组最要紧的两条：
 *   ① 只有 `full` 才显示（别的模式一律不显示 —— fail-closed）；
 *   ② 读不到时**不显示、不崩**（读不到 ≠ 全权，也 ≠ 崩掉整个输入框）。
 */

function render(element: React.ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function flushAsync(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const badge = (c: HTMLElement) => c.querySelector('[data-field="computer-access-badge"]');

describe('ComputerAccessBadge', () => {
  let listSessions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    listSessions = vi.fn().mockResolvedValue({ ok: true, result: { sessions: [] } });
    (globalThis.window as unknown as { clawwork: Record<string, unknown> }).clawwork = { listSessions };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const mount = async (gatewayId: string | null, sessionKey: string | null) => {
    const view = render(<ComputerAccessBadge gatewayId={gatewayId} sessionKey={sessionKey} />);
    await flushAsync();
    return view;
  };

  it('真值是 full ⇒ 显示徽章', async () => {
    listSessions.mockResolvedValue({ ok: true, result: { sessions: [{ key: 'k', permissionMode: 'full' }] } });
    const { container, unmount } = await mount('local-runtime', 'k');
    expect(badge(container)).not.toBeNull();
    unmount();
  });

  it.each([['guarded'], ['workspace'], ['read-only']])("真值是 '%s' ⇒ 不显示", async (mode) => {
    listSessions.mockResolvedValue({ ok: true, result: { sessions: [{ key: 'k', permissionMode: mode }] } });
    const { container, unmount } = await mount('local-runtime', 'k');
    expect(badge(container)).toBeNull();
    unmount();
  });

  it('行里根本没有这个字段（= 从来没设过）⇒ 不显示', async () => {
    listSessions.mockResolvedValue({ ok: true, result: { sessions: [{ key: 'k' }] } });
    const { container, unmount } = await mount('local-runtime', 'k');
    expect(badge(container)).toBeNull();
    unmount();
  });

  it('网关掉线（ok:false）⇒ 不显示，不崩', async () => {
    listSessions.mockResolvedValue({ ok: false, error: 'gateway not connected' });
    const { container, unmount } = await mount('local-runtime', 'k');
    expect(badge(container)).toBeNull();
    unmount();
  });

  it('读取抛异常 ⇒ 不显示，不崩', async () => {
    listSessions.mockRejectedValue(new Error('boom'));
    const { container, unmount } = await mount('local-runtime', 'k');
    expect(badge(container)).toBeNull();
    unmount();
  });

  it('没有当前任务（会话键为空）⇒ 不显示，且**一次都不读**', async () => {
    const { container, unmount } = await mount('local-runtime', null);
    expect(badge(container)).toBeNull();
    expect(listSessions, '没有任务就没有要读的对象').not.toHaveBeenCalled();
    unmount();
  });

  /**
   * ⚠️ 这一条是**变异测试逼出来的**：守卫原本写成"会话键空就够了"，那条变异在
   *    上面那个用例里**活了下来** —— 因为上面只覆盖了会话键为空的那一半。
   *    网关为空、会话键有值时会漏过去，拿着 `null` 去发请求。
   */
  it('网关为空（会话键有值）⇒ 不显示，且**一次都不读**', async () => {
    const { container, unmount } = await mount(null, 'k');
    expect(badge(container)).toBeNull();
    expect(listSessions, '没有网关可问就不该发请求').not.toHaveBeenCalled();
    unmount();
  });

  it('列表是裸数组（另一种包法）也认得', async () => {
    listSessions.mockResolvedValue({ ok: true, result: [{ key: 'k', permissionMode: 'full' }] });
    const { container, unmount } = await mount('local-runtime', 'k');
    expect(badge(container)).not.toBeNull();
    unmount();
  });
});

/**
 * ⭐ 这一组是**真机验收逼出来的**（2026-09-26）：
 *    在任务里打开全权、或者发一条消息让发送链补一刀之后，那个会话**已经**是全权，
 *    而徽章**不出现** —— 它只在会话键变化时重读一次，而全权是在它挂载**之后**才生效的。
 *    真机上的形状：发完消息看不到徽章，切走再切回来才看得见。
 */
describe('ComputerAccessBadge × 档位变化后要自己重读', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  it('⭐ 挂载时不是全权，之后我们把它设成全权 ⇒ 徽章自己出现（不用换会话、不用重挂）', async () => {
    const listSessions = vi.fn().mockResolvedValue({ ok: true, result: { sessions: [{ key: 'k' }] } });
    (globalThis.window as unknown as { clawwork: Record<string, unknown> }).clawwork = { listSessions };

    const { container, unmount } = render(<ComputerAccessBadge gatewayId="local-runtime" sessionKey="k" />);
    await flushAsync();
    expect(badge(container), '一开始还没设过 ⇒ 不该有徽章').toBeNull();

    // 模拟"发送链补了一刀"：会话在后端变成 full，同时记账 + 通知
    listSessions.mockResolvedValue({ ok: true, result: { sessions: [{ key: 'k', permissionMode: 'full' }] } });
    await act(async () => {
      rememberPermissionMode(new Map(), 'k', 'full');
    });
    await flushAsync();

    expect(badge(container), '补刀之后徽章必须出现').not.toBeNull();
    unmount();
  });
});
