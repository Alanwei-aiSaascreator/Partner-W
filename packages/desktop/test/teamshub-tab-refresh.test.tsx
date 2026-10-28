// @vitest-environment jsdom

/**
 * 团队市场「刷新」失败时**原因不许丢**（2026-10-05，AI 建队排查顺带）。
 *
 * 默认官方源是 GitHub raw（国内常常不可达）。旧实现刷新失败只弹一句 `请求出错`，
 * 连是哪个源、为什么失败都没有 —— 用户只会以为功能坏了。现在要把
 * `teamshub/registry.ts` 拼好的原因（**带 URL**：network unreachable / timed out）带出来。
 */

import type { ButtonHTMLAttributes } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toast } from 'sonner';

/** ⚠️ `t` 必须是**稳定引用**：`useEffect` 依赖里的 `loadRegistries` 挂着它，
 *  每次渲染换一个函数 = effect → setState → 再渲染的死循环（本文件踩过一次）。 */
const translate = (key: string) => key;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('../src/renderer/stores/teamStore', () => ({
  useTeamStore: <T,>(selector: (state: Record<string, unknown>) => T) => selector({ teams: {}, loadTeams: vi.fn() }),
}));
vi.mock('../src/renderer/layouts/TeamsPanel/TeamHubCard', () => ({ default: () => null }));
vi.mock('../src/renderer/layouts/TeamsPanel/RegistryManageDialog', () => ({ default: () => null }));
vi.mock('@/components/semantic/EmptyState', () => ({
  default: ({ title }: { title: string }) => <div>{title}</div>,
}));
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

import TeamsHubTab from '../src/renderer/layouts/TeamsPanel/TeamsHubTab';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

describe('团队市场刷新失败', () => {
  it('⭐ 把真实原因（含 URL）带进提示，不再只有一句「请求出错」', async () => {
    const entry = {
      slug: 'demo',
      name: 'Demo',
      emoji: '',
      description: '',
      version: '1',
      agentCount: 1,
      category: '',
      tags: [],
      author: '',
    };
    Object.assign(window, {
      clawwork: {
        hubListRegistries: vi.fn(async () => ({
          ok: true,
          result: [{ id: 'community', name: 'Community', description: '', url: '', isOfficial: true, teams: [entry] }],
        })),
        hubFetchRegistry: vi.fn(async () => ({
          ok: false,
          error:
            'Failed to reach https://raw.githubusercontent.com/clawwork-ai/teamshub-community/main/teamshub.json: network unreachable (fetch failed)',
        })),
      },
    });

    await act(async () => {
      root.render(<TeamsHubTab onSelectEntry={vi.fn()} />);
    });
    await act(async () => {
      (container.querySelector('[aria-label="teamshub.refresh"]') as HTMLButtonElement | null)?.click();
    });

    expect(toast.error).toHaveBeenCalledOnce();
    const message = vi.mocked(toast.error).mock.calls[0]?.[0] as string;
    expect(message).toContain('errors.requestFailed');
    expect(message).toContain('raw.githubusercontent.com');
    expect(message).toContain('network unreachable');

    act(() => root.unmount());
    container.remove();
  });
});
