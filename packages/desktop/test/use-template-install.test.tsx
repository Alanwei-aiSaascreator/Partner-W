// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTemplateDetail } from '@clawwork/shared';

/**
 * ⭐ 2026-10-07（质检 P1-1）：`useTemplateInstall` 的**并发契约**。
 *
 * 以前这里是单个 `installingId` + `finally` 无条件置 null：装 A 时点 B 会把 A 的忙态
 * 顶掉提前恢复可点，同 id 双击会走两条链（第二次靠"已存在"对账，两条都记一次账 ⇒
 * `install_count` 记两次）。本文件钉住修好后的形状：
 *   ① 忙态是 **id 集合**，互不覆盖；
 *   ② 同 id 在飞时**复用同一条 promise**（只建一次、只记一次账）；
 *   ③ `beginInstall`/`endInstall` 成对（入口置忙 / 收尾清忙）。
 */

vi.mock('@/hooks/useGatewaySelector', () => ({
  useGatewaySelector: () => ({ selectedGwId: 'gw-1' }),
}));

vi.mock('@/stores/uiStore', () => ({
  useUiStore: {
    getState: () => ({ agentCatalogByGateway: { 'gw-1': { agents: [{ id: 'main' }] } } }),
  },
}));

vi.mock('@/lib/template-install', () => ({
  installTemplate: vi.fn(),
}));

import { installTemplate } from '@/lib/template-install';
import {
  useTemplateInstall,
  type TemplateInstallController,
} from '../src/renderer/layouts/MarketPanel/useTemplateInstall';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const template = {
  id: 't-official',
  name: '爆款内容教练',
  description: '',
  emoji: '📣',
  instructions: '你是教练。',
} as unknown as AgentTemplateDetail;

let captured: TemplateInstallController | null = null;

function Harness(): null {
  captured = useTemplateInstall();
  return null;
}

function render(ui: ReactElement): { unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('useTemplateInstall —— 忙态是 id 集合 + 同 id 在飞去重', () => {
  beforeEach(() => {
    captured = null;
    vi.clearAllMocks();
    Object.assign(window, { clawwork: { getWorkspacePath: vi.fn(async () => 'C:/ws') } });
  });

  it('⭐ 同 id 在飞时复用同一条 promise，底层编排只跑一次', async () => {
    let release: ((value: { ok: boolean; agentId: string }) => void) | undefined;
    vi.mocked(installTemplate).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve as typeof release;
        }),
    ) as unknown as typeof installTemplate;

    const view = render(<Harness />);
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await act(async () => {
      first = captured!.install(template);
      second = captured!.install(template);
      await Promise.resolve(); // 让 getWorkspacePath 落地、进入 installTemplate
    });

    expect(first).toBe(second); // 同一个 promise（不是"又发了一条"）
    expect(installTemplate).toHaveBeenCalledTimes(1);
    expect(captured!.installingIds.has('t-official')).toBe(true);

    await act(async () => {
      release?.({ ok: true, agentId: 'partner-w-tpl-x' });
      await first;
    });

    expect(captured!.installingIds.size).toBe(0); // 收尾清忙
    view.unmount();
  });

  it('⭐ 装 A 时点 B：两条忙态并存，A 结束不顶掉 B', async () => {
    const releases = new Map<string, (value: { ok: boolean; agentId: string }) => void>();
    vi.mocked(installTemplate).mockImplementation(
      (_deps, detail) =>
        new Promise((resolve) => {
          releases.set(detail.id, resolve as (value: { ok: boolean; agentId: string }) => void);
        }),
    ) as unknown as typeof installTemplate;

    const view = render(<Harness />);
    const other = { ...template, id: 't-other' } as AgentTemplateDetail;
    let first: Promise<unknown> | undefined;
    let second: Promise<unknown> | undefined;
    await act(async () => {
      first = captured!.install(template);
      second = captured!.install(other);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect([...captured!.installingIds].sort()).toEqual(['t-official', 't-other']);

    await act(async () => {
      releases.get('t-official')?.({ ok: true, agentId: 'a' });
      await first;
    });
    expect([...captured!.installingIds]).toEqual(['t-other']); // B 的忙态不被 A 清掉

    await act(async () => {
      releases.get('t-other')?.({ ok: true, agentId: 'b' });
      await second;
    });
    expect(captured!.installingIds.size).toBe(0);
    view.unmount();
  });

  it('beginInstall / endInstall 成对置忙与清忙（入口在拉详情前就要禁用按钮）', () => {
    const view = render(<Harness />);

    act(() => captured!.beginInstall('t-official'));
    expect(captured!.installingIds.has('t-official')).toBe(true);

    act(() => captured!.endInstall('t-official'));
    expect(captured!.installingIds.has('t-official')).toBe(false);

    view.unmount();
  });
});
