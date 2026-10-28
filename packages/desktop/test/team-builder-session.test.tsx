// @vitest-environment jsdom

/**
 * 「AI 创建」建队 —— 引导会话起不来 / 装挂了之后**有话说、有出路**（2026-10-05）。
 *
 * 实机报障原话是「AI 对话建队创建失败」。代码分析坐实的形状：
 *
 * 1. `start()` 的返回值**没人看**。会话是全局单例，被别的功能占着时
 *    （目标分析 / AI 建助手）`start()` 立刻回 `SESSION_BUSY`，store 里留着的却是
 *    **别人那条会话** ⇒ 这个对话框要么什么都不显示、要么把别人的对话摆出来，
 *    输入框还能把消息发进别人的会话。全程没有一句提示。
 * 2. 装失败（error / degraded）之后面板上**没有任何按钮**：只能关掉再打开，
 *    而重开要重聊一遍（配置被清空）——失败还附带一次数据丢失。
 *
 * 这份用例钉住：失败上屏（中文人话 + 英文原文）、能重试、不误关别人的会话、
 * 连点两次只装一次。
 */

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

/** 用真实中文文案渲染，并支持 i18next 的 `defaultValue`（新键还没并进 locale 时的兜底）。 */
function translate(key: string, values?: Record<string, unknown>): string {
  let node: unknown = zh;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) break;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') node = values?.defaultValue;
  if (typeof node !== 'string') return key;
  if (!values) return node;
  return node.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values[name] ?? ''));
}

const session = vi.hoisted(() => ({
  status: 'active' as 'idle' | 'active' | 'streaming',
  messages: [] as Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>,
  error: null as string | null,
  start: vi.fn(
    async (_opts: { gatewayId: string; agentId: string; purpose: string; initialMessage?: string; model?: string }) =>
      ({ ok: true }) as { ok: boolean; error?: string; errorCode?: string },
  ),
  send: vi.fn(async () => ({ ok: true })),
  end: vi.fn(async () => undefined),
}));

const models = vi.hoisted(() => ({
  catalog: [{ id: 'clawrouter/deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' }] as Array<{
    id: string;
    provider?: string;
    name?: string;
    available?: boolean;
  }>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('../src/renderer/hooks/useGatewayDispatcherSetup', () => ({
  fetchAgentsForGateway: vi.fn(async () => undefined),
}));
vi.mock('../src/renderer/stores/teamStore', () => ({
  useTeamStore: <T,>(selector: (state: Record<string, unknown>) => T) => selector({ teams: {}, loadTeams: vi.fn() }),
}));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    children,
    open,
    onOpenChange,
  }: {
    children: ReactNode;
    open: boolean;
    onOpenChange?: (next: boolean) => void;
  }) =>
    open ? (
      <div role="dialog">
        <button type="button" data-testid="dialog-close" onClick={() => onOpenChange?.(false)} />
        {children}
      </div>
    ) : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('@/components/MarkdownContent', () => ({
  default: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('../src/renderer/hooks/useSystemSession', () => ({
  useSystemSession: () => ({
    status: session.status,
    messages: session.messages,
    error: session.error,
    start: session.start,
    send: session.send,
    end: session.end,
  }),
}));

vi.mock('../src/renderer/stores/uiStore', () => ({
  useUiStore: <T,>(selector: (state: Record<string, unknown>) => T) =>
    selector({
      modelCatalogByGateway: { 'gw-1': models.catalog },
      agentCatalogByGateway: { 'gw-1': { defaultId: 'main', agents: [] } },
      gatewayInfoMap: { 'gw-1': { id: 'gw-1', name: 'Gateway' } },
    }),
}));

import TeamBuilderDialog, {
  TEAM_BUILDER_INCOMPLETE_MESSAGE,
  TEAM_BUILDER_SESSION_BUSY_MESSAGE,
} from '../src/renderer/components/TeamBuilderDialog';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEAM_CONFIG_MESSAGE = {
  role: 'assistant' as const,
  timestamp: 'now',
  content:
    '```team-config\n' +
    JSON.stringify({
      name: '研究团队',
      emoji: '🔬',
      description: '研究与分析',
      agents: [
        {
          name: '研究主管',
          role: 'coordinator',
          model: 'clawrouter/deepseek-v4-flash',
          description: '负责策略',
          identity: '你负责策略和质检。',
        },
        {
          name: '分析专家',
          role: 'worker',
          model: 'clawrouter/deepseek-v4-flash',
          description: '负责分析',
          identity: '你负责数据分析。',
        },
      ],
    }) +
    '\n```',
};

function render(open = true): {
  container: HTMLDivElement;
  onOpenChange: ReturnType<typeof vi.fn>;
  setOpen: (next: boolean) => void;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  const onOpenChange = vi.fn();
  const renderWith = (next: boolean) =>
    root.render(<TeamBuilderDialog open={next} onOpenChange={onOpenChange} gatewayId="gw-1" />);
  act(() => renderWith(open));
  return {
    container,
    onOpenChange,
    setOpen: (next: boolean) => act(() => renderWith(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return (
    ([...container.querySelectorAll('button')].find((button) => button.textContent?.includes(text)) as
      | HTMLButtonElement
      | undefined) ?? null
  );
}

describe('TeamBuilderDialog —— 引导会话起不来时不许静默', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    session.status = 'active';
    session.messages = [];
    session.error = null;
    session.start.mockResolvedValue({ ok: true });
    models.catalog = [{ id: 'clawrouter/deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' }];
    Object.assign(window, {
      clawwork: {
        getWorkspacePath: vi.fn(async () => '/tmp/ws'),
        getTeamWorkspacePath: vi.fn(async () => '/tmp/ws/team'),
        probeWorkspaceFsIdentity: vi.fn(async () => ({ state: 'ok', dev: '1', ino: '2' })),
        createAgent: vi.fn(async (_gw: string, params: { name: string }) => ({
          ok: true,
          result: { agentId: params.name, name: params.name, workspace: '' },
        })),
        updateAgent: vi.fn(async () => ({ ok: true })),
        setAgentFile: vi.fn(async () => ({ ok: true })),
        deleteAgent: vi.fn(async () => ({ ok: true })),
        installSkill: vi.fn(async () => ({ ok: true })),
        getConfig: vi.fn(async () => ({ ok: true, result: { hash: 'hash', config: { agents: { entries: {} } } } })),
        patchConfig: vi.fn(async () => ({ ok: true })),
        persistTeam: vi.fn(async () => ({ ok: true })),
        listAgents: vi.fn(async () => ({ ok: true, result: { agents: [] } })),
        hubDownloadTeam: vi.fn(),
      },
    });
  });

  it('⭐ 会话被别的功能占着（SESSION_BUSY）：把原因说清楚，并给「重试」', async () => {
    session.start.mockResolvedValueOnce({
      ok: false,
      error: 'system session already active',
      errorCode: 'SESSION_BUSY',
    });
    const view = render();

    await act(async () => {});

    // 组件现在渲染的是**常量**（i18n 文件由并行任务持有，见组件里的说明），
    // 所以断言钉在常量本身上：文案改了、或换成 t() 之后没人渲染它，这里都会红。
    expect(view.container.textContent).toContain(TEAM_BUILDER_SESSION_BUSY_MESSAGE);
    // 英文原文也要在（中文人话 + 原文两行，与安装失败面板同一规矩）
    expect(view.container.textContent).toContain('system session already active');
    const retry = buttonByText(view.container, translate('common.retry'));
    expect(retry).not.toBeNull();

    // 重试 = 真的再建一次会话
    await act(async () => {
      retry?.click();
    });
    expect(session.start).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it('⭐ 会话起不来时不许替别人 end()；自己建的会话才关', async () => {
    session.start.mockResolvedValueOnce({
      ok: false,
      error: 'system session already active',
      errorCode: 'SESSION_BUSY',
    });
    const view = render();
    await act(async () => {});

    await act(async () => {
      (view.container.querySelector('[data-testid="dialog-close"]') as HTMLButtonElement | null)?.click();
    });
    expect(session.end).not.toHaveBeenCalled();
    expect(view.onOpenChange).toHaveBeenCalledWith(false);
    view.unmount();

    // 正向对照：会话是我们的 ⇒ 关闭时照旧要 end()
    vi.clearAllMocks();
    session.start.mockResolvedValue({ ok: true });
    const owned = render();
    await act(async () => {});
    await act(async () => {
      (owned.container.querySelector('[data-testid="dialog-close"]') as HTMLButtonElement | null)?.click();
    });
    expect(session.end).toHaveBeenCalledOnce();
    owned.unmount();
  });

  it('会话起不来时创建按钮必须灰掉（没有配置可装，不许假装能建）', async () => {
    session.start.mockResolvedValueOnce({ ok: false, error: 'gateway not connected' });
    const view = render();
    await act(async () => {});

    const create = buttonByText(view.container, translate('teams.teamBuilderCreate')) as HTMLButtonElement | null;
    expect(create?.disabled).toBe(true);
    view.unmount();
  });

  it('⭐ 连点两次「创建」只装一次（原来第二次会再造一整个团队）', async () => {
    const view = render();
    await act(async () => {});

    session.status = 'streaming';
    session.messages = [TEAM_CONFIG_MESSAGE];
    view.setOpen(true);

    await act(async () => {
      const create = buttonByText(view.container, translate('teams.teamBuilderCreate')) as HTMLButtonElement | null;
      expect(create?.disabled).toBe(false);
      create?.click();
      create?.click();
    });

    expect(window.clawwork.createAgent).toHaveBeenCalledTimes(2); // 两位成员，各一次
    expect(window.clawwork.persistTeam).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('⭐ 安装失败后面板上有「重试」和「关闭」，重试直接拿同一份配置再装', async () => {
    vi.mocked(window.clawwork.createAgent).mockResolvedValue({ ok: false, error: 'quota exceeded' });
    const view = render();
    await act(async () => {});

    session.status = 'streaming';
    session.messages = [TEAM_CONFIG_MESSAGE];
    view.setOpen(true);
    await act(async () => {
      buttonByText(view.container, translate('teams.teamBuilderCreate'))?.click();
    });
    expect(view.container.textContent).toContain('quota exceeded');

    const retry = buttonByText(view.container, translate('common.retry'));
    expect(retry).not.toBeNull();
    expect(buttonByText(view.container, translate('common.close'))).not.toBeNull();

    // 重试：再装一轮（这次每建必成）
    vi.mocked(window.clawwork.createAgent).mockImplementation(async (_gw: string, params: { name: string }) => ({
      ok: true,
      result: { agentId: params.name, name: params.name, workspace: '' },
    }));
    await act(async () => {
      retry?.click();
    });
    expect(window.clawwork.persistTeam).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-install-outcome="done"]')).not.toBeNull();
    view.unmount();
  });

  it('配置不完整时按钮灰掉，但把「还差什么」写在旁边', async () => {
    const view = render();
    await act(async () => {});

    session.status = 'streaming';
    session.messages = [
      {
        role: 'assistant',
        timestamp: 'now',
        content: '```team-config\n{"name":"只有名字的团队"}\n```',
      },
    ];
    view.setOpen(true);

    const create = buttonByText(view.container, translate('teams.teamBuilderCreate')) as HTMLButtonElement | null;
    expect(create?.disabled).toBe(true);
    expect(view.container.textContent).toContain(TEAM_BUILDER_INCOMPLETE_MESSAGE);
    view.unmount();
  });
});
