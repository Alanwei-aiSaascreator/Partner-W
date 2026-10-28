// @vitest-environment jsdom

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

/** 用真实中文文案渲染：这样「提示是中文」才是被验证过的。 */
function translate(key: string, values?: Record<string, unknown>): string {
  let node: unknown = zh;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') return key;
  if (!values) return node;
  return node.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values[name] ?? ''));
}

const session = vi.hoisted(() => ({
  status: 'active' as 'idle' | 'active' | 'streaming',
  messages: [] as Array<{ role: 'user' | 'assistant'; content: string; timestamp: string }>,
  error: null as string | null,
  start: vi.fn(
    async (_opts: {
      gatewayId: string;
      agentId: string;
      purpose: string;
      initialMessage?: string;
      model?: string;
    }) => ({ ok: true }),
  ),
  send: vi.fn(async () => ({ ok: true })),
  end: vi.fn(async () => undefined),
}));

const models = vi.hoisted(() => ({
  catalog: [
    { id: 'clawrouter/qwen3.5-27b', provider: 'clawrouter', name: 'Qwen 3.5 27B' },
    { id: 'clawrouter/glm-5.3-flash', provider: 'clawrouter', name: 'GLM 5.3 Flash' },
    // 2026-10-17 三档按能力分模型：智能（默认）档 = glm-5.3-flashx，才是商业默认。
    { id: 'clawrouter/glm-5.3-flashx', provider: 'clawrouter', name: 'GLM 5.3 FlashX' },
    { id: 'clawrouter/deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
  ] as Array<{ id: string; provider?: string; name?: string; available?: boolean }>,
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
vi.mock('@/components/GatewayInstanceSelector', () => ({ default: () => null }));

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: ReactNode; open: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
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

import AgentBuilderDialog from '../src/renderer/components/AgentBuilderDialog';
import TeamBuilderDialog from '../src/renderer/components/TeamBuilderDialog';
import TeamHubDetailView from '../src/renderer/layouts/TeamsPanel/TeamHubDetailView';
import { WORKSPACE_UNAVAILABLE_MESSAGE } from '../src/renderer/lib/install-workspace';
import { toast } from 'sonner';
import { deriveAgentCreationId } from '../src/renderer/lib/agent-builder';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function render(
  open = true,
  team = false,
): {
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
    root.render(
      team ? (
        <TeamBuilderDialog open={next} onOpenChange={onOpenChange} gatewayId="gw-1" />
      ) : (
        <AgentBuilderDialog open={next} onOpenChange={onOpenChange} gatewayId="gw-1" />
      ),
    );
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

function inputByName(container: HTMLElement, label: string): HTMLInputElement | null {
  const labels = [...container.querySelectorAll('label')];
  const target = labels.find((element) => element.textContent?.includes(label));
  if (!target) return null;
  return target.parentElement?.querySelector('input') ?? null;
}

function typeInto(input: HTMLElement, value: string): void {
  const prototype =
    input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('AgentBuilderDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    session.status = 'active';
    session.messages = [];
    session.error = null;
    models.catalog = [
      { id: 'clawrouter/qwen3.5-27b', provider: 'clawrouter', name: 'Qwen 3.5 27B' },
      { id: 'clawrouter/glm-5.3-flash', provider: 'clawrouter', name: 'GLM 5.3 Flash' },
      { id: 'clawrouter/glm-5.3-flashx', provider: 'clawrouter', name: 'GLM 5.3 FlashX' },
      { id: 'clawrouter/deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
    ];
    Object.assign(window, {
      clawwork: {
        getWorkspacePath: vi.fn(async () => '/tmp/ws'),
        createAgent: vi.fn(async () => ({ ok: true, result: { agentId: 'agent-9' } })),
        updateAgent: vi.fn(async () => ({ ok: true })),
        setAgentFile: vi.fn(async () => ({ ok: true })),
        getTeamWorkspacePath: vi.fn(async () => '/tmp/ws/team'),
        probeWorkspaceFsIdentity: vi.fn(async () => ({ state: 'ok', dev: '1', ino: '2' })),
        installSkill: vi.fn(async () => ({ ok: true })),
        getConfig: vi.fn(async () => ({ ok: true, result: { hash: 'hash', config: {} } })),
        patchConfig: vi.fn(async () => ({ ok: true })),
        persistTeam: vi.fn(async () => ({ ok: true })),
        deleteAgent: vi.fn(async () => ({ ok: true })),
        hubDownloadTeam: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs the guidance session on a currently available model instead of the main assistant model', () => {
    const view = render();
    expect(session.start).toHaveBeenCalledOnce();
    expect(session.start.mock.calls[0]?.[0]).toMatchObject({
      gatewayId: 'gw-1',
      purpose: 'agent-builder',
      // 目录里第一条是 qwen3.5-27b（就是实机卡住的那个）；这里必须是商业默认模型（Cephalon 批 = GLM 5.3 Flash）
      model: 'clawrouter/glm-5.3-flashx',
    });
    view.unmount();
  });

  it('keeps partial AI team results open with counts and the original warning, without success toast', async () => {
    vi.mocked(window.clawwork.createAgent).mockResolvedValueOnce({ ok: false, error: 'quota exceeded' });
    const view = render(true, true);
    session.status = 'streaming';
    session.messages = [
      {
        role: 'assistant',
        timestamp: 'now',
        content:
          '```team-config\n' +
          JSON.stringify({
            name: '\u7814\u7a76\u56e2\u961f',
            emoji: '',
            description: '\u7814\u7a76\u5206\u6790',
            agents: [
              {
                name: '\u7814\u7a76\u4e3b\u7ba1',
                role: 'coordinator',
                model: 'clawrouter/deepseek-v4-flash',
                description: '\u8d1f\u8d23\u7b56\u7565',
                identity: '\u4f60\u8d1f\u8d23\u7b56\u7565\u548c\u8d28\u68c0',
              },
              {
                name: '\u5206\u6790\u4e13\u5bb6',
                role: 'worker',
                model: 'clawrouter/deepseek-v4-flash',
                description: '\u8d1f\u8d23\u5206\u6790',
                identity: '\u4f60\u8d1f\u8d23\u6570\u636e\u5206\u6790',
              },
            ],
          }) +
          '\n```',
      },
    ];
    view.setOpen(true);
    await act(async () => {
      const button = buttonByText(view.container, translate('teams.teamBuilderCreate'));
      expect(button?.disabled).toBe(false);
      button?.click();
    });
    expect(window.clawwork.persistTeam).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(view.onOpenChange).not.toHaveBeenCalledWith(false);
    expect(view.container.textContent).toContain('quota exceeded');
    expect(view.container.querySelector('[data-install-outcome="degraded"]')?.textContent).toMatch(/1.*1.*0.*0/);
    expect(window.clawwork.deleteAgent).not.toHaveBeenCalled();
    view.unmount();
  });

  it('keeps marketplace skill failures visible rather than announcing installed success', async () => {
    const entry = {
      _registryId: 'registry',
      slug: 'market',
      name: 'Market',
      emoji: '',
      description: '',
      version: '1',
      agentCount: 1,
      category: '',
      tags: [],
      author: '',
    };
    vi.mocked(window.clawwork.hubDownloadTeam).mockResolvedValue({
      ok: true,
      result: {
        parsed: {
          name: 'Market',
          agents: [{ id: 'market-author', name: 'Author', role: 'worker' }],
          version: '1',
          description: '',
          body: '',
        },
        agentFiles: {
          'market-author': { skillsJson: JSON.stringify({ skills: { absent: { sourceType: 'clawhub' } } }) },
        },
      },
    });
    vi.mocked(window.clawwork.installSkill).mockResolvedValue({ ok: false, error: 'not found' });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(<TeamHubDetailView entry={entry} onBack={vi.fn()} />);
    });
    await act(async () => {
      buttonByText(container, translate('teamshub.install'))?.click();
    });
    expect(window.clawwork.persistTeam).toHaveBeenCalledOnce();
    expect(toast.success).not.toHaveBeenCalled();
    expect(container.textContent).toContain('absent');
    expect(container.querySelector('[data-install-outcome="degraded"]')?.textContent).toMatch(/1.*0.*0.*1/);
    act(() => root.unmount());
  });

  it.each([false, true])('uses a canonical available relay model for builder guidance (team=%s)', (team) => {
    models.catalog = [
      { id: 'native-model', provider: 'openai', available: true },
      { id: 'deepseek-v4-flash', provider: 'clawrouter', available: false },
      { id: 'qwen-ready', provider: 'clawrouter', available: true },
    ];
    const view = render(true, team);
    expect(session.start).toHaveBeenCalledWith(expect.objectContaining({ model: 'clawrouter/qwen-ready' }));
    expect(session.start.mock.calls[0]?.[0].initialMessage).not.toContain('native-model');
    expect(session.start.mock.calls[0]?.[0].initialMessage).not.toContain('deepseek-v4-flash');
    view.unmount();
  });

  it.each([false, true])('does not inherit an unknown route when no eligible model exists (team=%s)', async (team) => {
    models.catalog = [{ id: 'native-model', provider: 'openai', available: true }];
    const view = render(true, team);
    expect(session.start).not.toHaveBeenCalled();
    if (!team) {
      typeInto(inputByName(view.container, translate('settings.agentName')) as HTMLElement, 'Draft');
      await act(async () => {
        buttonByText(view.container, translate('settings.agentBuilderCreate'))?.click();
      });
      expect(window.clawwork.createAgent).not.toHaveBeenCalled();
    }
    view.unmount();
  });

  it('resolves AI-provided display model names through the same canonical relay resolver before creating', async () => {
    const view = render();
    session.status = 'streaming';
    session.messages = [
      {
        role: 'assistant',
        content: '```agent-config\n{"name":"Draft","model":"DeepSeek V4 Flash"}\n```',
        timestamp: 'now',
      },
    ];
    view.setOpen(true);
    await act(async () => {
      buttonByText(view.container, translate('settings.agentBuilderCreate'))?.click();
    });
    expect(window.clawwork.updateAgent).toHaveBeenCalledWith('gw-1', {
      agentId: 'agent-9',
      model: 'clawrouter/deepseek-v4-flash',
    });
    view.unmount();
  });

  it('permits localized display names in guidance and allocates their own workspace', async () => {
    const name = '\u878d\u8d44\u4e3b\u7ba1';
    const view = render();
    expect(session.start.mock.calls[0]?.[0].initialMessage).not.toContain('MUST be in English');
    expect(session.start.mock.calls[0]?.[0].initialMessage).toContain('Default response language: Simplified Chinese.');
    expect(session.start.mock.calls[0]?.[0].initialMessage).toContain(
      'visible text in generated pages, documents, and presentations',
    );
    typeInto(inputByName(view.container, translate('settings.agentName')) as HTMLElement, name);
    await act(async () => {
      buttonByText(view.container, translate('settings.agentBuilderCreate'))?.click();
    });

    expect(window.clawwork.createAgent).toHaveBeenCalledWith(
      'gw-1',
      expect.objectContaining({
        name: deriveAgentCreationId(name),
        workspace: `/tmp/ws/${deriveAgentCreationId(name)}`,
      }),
    );
    expect(window.clawwork.updateAgent).toHaveBeenCalledWith('gw-1', { agentId: 'agent-9', name });
    view.unmount();
  });

  it('preselects the available model in the form so the user can create without waiting for the AI', () => {
    const view = render();
    const select = view.container.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('clawrouter/glm-5.3-flashx');
    view.unmount();
  });

  it('offers a skip after the guidance goes quiet, and skipping unblocks the form', () => {
    vi.useFakeTimers();
    session.status = 'streaming';
    session.messages = [
      { role: 'user', content: 'prompt', timestamp: 't0' },
      { role: 'assistant', content: '', timestamp: 't0' },
    ];
    const view = render();

    expect(view.container.textContent).not.toContain(translate('settings.agentBuilderStalled'));

    act(() => {
      vi.advanceTimersByTime(13_000);
    });
    expect(view.container.textContent).toContain(translate('settings.agentBuilderStalled'));

    const skip = buttonByText(view.container, translate('settings.agentBuilderSkip'));
    expect(skip).not.toBeNull();
    act(() => skip?.click());
    expect(session.end).toHaveBeenCalled();
    view.unmount();
  });

  it('does not cry wolf while the guidance is still streaming', () => {
    vi.useFakeTimers();
    session.status = 'streaming';
    session.messages = [
      { role: 'user', content: 'prompt', timestamp: 't0' },
      { role: 'assistant', content: '正在想', timestamp: 't0' },
    ];
    const view = render();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    // 10 秒时刚到一半，还没到提示阈值
    expect(view.container.textContent).not.toContain(translate('settings.agentBuilderStalled'));

    // 又来了一段流式内容 —— 计时应该重新开始，不能因为「总共过了 20 秒」就报卡住
    act(() => {
      session.messages = [
        { role: 'user', content: 'prompt', timestamp: 't0' },
        { role: 'assistant', content: '正在想，马上好', timestamp: 't0' },
      ];
      view.setOpen(true);
    });
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(view.container.textContent).not.toContain(translate('settings.agentBuilderStalled'));
    view.unmount();
  });

  it('keeps the draft when the dialog is closed and reopened', () => {
    const view = render();
    const nameInput = inputByName(view.container, translate('settings.agentName'));
    expect(nameInput).not.toBeNull();
    typeInto(nameInput as HTMLElement, '我的助手');

    view.setOpen(false);
    view.setOpen(true);

    const reopened = inputByName(view.container, translate('settings.agentName')) as HTMLInputElement;
    expect(reopened.value).toBe('我的助手');
    view.unmount();
  });

  /**
   * ⭐ 2026-09-20 T-a28 同族：**这一处以前会把 slug 当工作区发出去**。
   *
   * 旧写法 `const workspace = wsBase ? `${wsBase}/${slug}` : slug;` —— 拿不到工作区时
   * 发出去的是**相对路径**（`new-agent` 之类），而 `agents.create` 是**另一个进程**在解析它
   * （按它自己的 cwd）⇒ 助手的文件会落在一个谁也没预期的地方，且**界面不报错**。
   * 判据收在 `checkInstallWorkspace`（与模板安装、团队安装同一份）：坏输入**一个请求都不发**，
   * 给中文原因。
   */
  it('⭐ 拿不到工作区 ⇒ 一个 createAgent 都不发，给中文原因（不再把 slug 当路径发）', async () => {
    Object.assign(window.clawwork, { getWorkspacePath: vi.fn(async () => null) });

    const view = render();
    typeInto(inputByName(view.container, translate('settings.agentName')) as HTMLElement, '我的助手');
    await act(async () => {
      buttonByText(view.container, translate('settings.agentBuilderCreate'))?.click();
    });

    expect(window.clawwork.createAgent).not.toHaveBeenCalled();
    // ⚠️ 第二个参数是 `@/lib/toast` 自己加的错误时长，所以用 `expect.anything()` 放过它
    expect(toast.error).toHaveBeenCalledWith(WORKSPACE_UNAVAILABLE_MESSAGE, expect.anything());
    view.unmount();
  });

  it('工作区正常 ⇒ 发出去的是「根 + 子目录」（正向对照，证明上面那条不是把功能关掉了）', async () => {
    const view = render();
    typeInto(inputByName(view.container, translate('settings.agentName')) as HTMLElement, '我的助手');
    await act(async () => {
      buttonByText(view.container, translate('settings.agentBuilderCreate'))?.click();
    });

    expect(window.clawwork.createAgent).toHaveBeenCalledWith(
      'gw-1',
      expect.objectContaining({ workspace: expect.stringMatching(/^\/tmp\/ws\/.+/) }),
    );
    view.unmount();
  });

  it('clears the draft only after the agent was actually created', async () => {
    const view = render();
    const nameInput = inputByName(view.container, translate('settings.agentName'));
    typeInto(nameInput as HTMLElement, '我的助手');

    const create = buttonByText(view.container, translate('settings.agentBuilderCreate'));
    await act(async () => {
      create?.click();
    });

    expect(window.clawwork.createAgent).toHaveBeenCalledOnce();
    view.unmount();
  });
  /**
   * ⭐ 2026-09-17 顺手修的真缺陷：这条创建路径**没有回滚** ——
   * 创建成功但写 IDENTITY.md 失败时，网关里会留下一个半成品助手（用户看得见、用不了）。
   * 另两条路径（预置助手安装、模板安装）都会 `deleteAgent({deleteFiles:true})` 收尾。
   */
  it('⭐ 写身份文件失败 ⇒ 把刚建的 agent 删掉（不留半成品）', async () => {
    const deleteAgent = vi.fn(async () => ({ ok: true }));
    const setAgentFile = vi.fn(async () => ({ ok: false, error: 'disk full' }));
    Object.assign(window.clawwork, { deleteAgent, setAgentFile });

    const view = render();
    typeInto(inputByName(view.container, translate('settings.agentName')) as HTMLElement, '我的助手');
    typeInto(inputByName(view.container, translate('settings.agentDescription')) as HTMLElement, '测试失败回滚');

    await act(async () => {
      buttonByText(view.container, translate('settings.agentBuilderCreate'))?.click();
    });

    expect(setAgentFile).toHaveBeenCalled();
    expect(deleteAgent).toHaveBeenCalledWith('gw-1', { agentId: 'agent-9', deleteFiles: true });
    view.unmount();
  });
});
