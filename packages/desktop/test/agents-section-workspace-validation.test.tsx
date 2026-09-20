// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import '../src/renderer/i18n';
import { toast as sonnerToast } from 'sonner';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { resetSettingsStore } from '../src/renderer/stores/settingsStore';
import AgentsSection from '../src/renderer/layouts/Settings/sections/AgentsSection';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('framer-motion', async () => {
  const React = await import('react');
  const motion = new Proxy(
    {},
    {
      get: (_target, tag: string) =>
        React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(({ children, ...props }, ref) =>
          React.createElement(tag, { ...props, ref }, children),
        ),
    },
  );
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion,
  };
});

vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
}));

vi.mock('../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../src/renderer/components/AgentBuilderDialog', () => ({
  default: () => null,
}));

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

async function flushAsync(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await flushAsync();
  }
}

async function clickSettle(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click();
  });
  await settle();
}

/** 按可见文字找按钮（表单收起时工具栏那个「添加智能体」是唯一一个；展开后表单里那个才是唯一的）。 */
function buttonsByText(container: HTMLElement, text: string): HTMLButtonElement[] {
  return ([...container.querySelectorAll('button')] as HTMLButtonElement[]).filter((button) =>
    (button.textContent ?? '').includes(text),
  );
}

function uniqueButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const matches = buttonsByText(container, text);
  if (matches.length !== 1) throw new Error(`expected exactly 1 button containing "${text}", got ${matches.length}`);
  return matches[0] as HTMLButtonElement;
}

/** 表单里是按 `<label>文字</label><input>` 并排写的，所以从 label 的父节点里取 input。 */
function inputByLabel(container: HTMLElement, label: string): HTMLInputElement {
  const labelEl = [...container.querySelectorAll('label')].find((el) => (el.textContent ?? '').includes(label));
  const input = labelEl?.parentElement?.querySelector('input');
  if (!input) throw new Error(`input labelled "${label}" not found`);
  return input as HTMLInputElement;
}

/** 卡片的编辑按钮 aria-label 是 `编辑: <名字>`，所以只能按前缀找。 */
function findByAriaKeyPrefix(container: HTMLElement, prefix: string): HTMLElement {
  const match = ([...container.querySelectorAll('[aria-label]')] as HTMLElement[]).find((el) =>
    (el.getAttribute('aria-label') ?? '').startsWith(prefix),
  );
  if (!match) throw new Error(`element with aria-label starting with "${prefix}" not found`);
  return match;
}

function typeInto(input: HTMLElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
  act(() => {
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function seedConnectedGateway(): void {
  useUiStore.setState({
    gatewayStatusMap: { 'gw-1': 'connected' },
    gatewayInfoMap: { 'gw-1': { id: 'gw-1', name: 'Gateway 1' } },
    defaultGatewayId: 'gw-1',
    agentCatalogByGateway: {
      'gw-1': { agents: [{ id: 'main', name: 'Main' }], defaultId: 'main' },
    },
    modelCatalogByGateway: {},
    skillsStatusByGateway: {},
  });
}

/**
 * ⭐ 2026-09-20 T-a28 同族：**设置里那个「工作空间」输入框是手打的，以前只查"非空"**。
 *
 * 为什么这不是"看着像隐患"：`agents.create` 交到**另一个进程**（网关）手里，那边是
 * `resolveUserPath` → `path.resolve`（随包运行时 `agent-create-BSK3Nvv3.mjs:121` +
 * `home-dir-59dFSOZn.mjs:66-79`）⇒ **相对路径会被解析到网关进程的 cwd**，
 * 目录落在谁也没预期的地方，而且**全程不报错**。
 * （`~` 开头是例外：网关会展开成家目录，所以不能一并拒掉。）
 */
describe('AgentsSection 工作空间输入框', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    document.body.innerHTML = '';
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    seedConnectedGateway();
    resetSettingsStore();

    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    (globalThis.window as unknown as Window & typeof globalThis & { clawwork: Record<string, unknown> }).clawwork = {
      listAgents: vi.fn().mockResolvedValue({ ok: true, result: { agents: [], defaultId: 'main' } }),
      listAgentFiles: vi.fn().mockResolvedValue({ ok: true, result: { workspace: '/ws', files: [] } }),
      getAgentFile: vi.fn(),
      setAgentFile: vi.fn(),
      getSkillsStatus: vi.fn().mockResolvedValue({ ok: true, result: { skills: [] } }),
      createAgent: vi.fn().mockResolvedValue({ ok: true, result: { agentId: 'agent-9' } }),
      updateAgent: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as Window['clawwork'] & Record<string, unknown>;
  });

  afterEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  async function openFormAndFill(name: string, workspace: string): Promise<HTMLDivElement> {
    const { container } = render(<AgentsSection />);
    await settle();
    await clickSettle(uniqueButtonByText(container, i18next.t('settings.addAgent')));
    typeInto(inputByLabel(container, i18next.t('settings.agentName')), name);
    typeInto(inputByLabel(container, i18next.t('settings.agentWorkspace')), workspace);
    return container;
  }

  it('⭐ 工作空间填相对路径 ⇒ 一个 createAgent 都不发，给中文原因（不让网关按自己的 cwd 解析）', async () => {
    const container = await openFormAndFill('我的助手', '荣盈魔方-运行数据\\工作区');

    await clickSettle(uniqueButtonByText(container, i18next.t('settings.addAgent')));

    expect(window.clawwork.createAgent).not.toHaveBeenCalled();
    expect(sonnerToast.error).toHaveBeenCalledWith(
      i18next.t('settings.agentWorkspaceMustBeAbsolute'),
      expect.anything(),
    );
  });

  it('工作空间填空 ⇒ 仍然是原来那句「不能为空」（这条不是新行为，是防止新校验把旧的顶掉）', async () => {
    const container = await openFormAndFill('我的助手', '');

    await clickSettle(uniqueButtonByText(container, i18next.t('settings.addAgent')));

    expect(window.clawwork.createAgent).not.toHaveBeenCalled();
    expect(sonnerToast.error).toHaveBeenCalledWith(i18next.t('settings.agentWorkspaceRequired'), expect.anything());
  });

  it('工作空间填完整路径 ⇒ 照旧建（正向对照，证明上面那条不是把功能关掉了）', async () => {
    const container = await openFormAndFill('我的助手', 'D:\\魔方工作区');

    await clickSettle(uniqueButtonByText(container, i18next.t('settings.addAgent')));

    expect(window.clawwork.createAgent).toHaveBeenCalledWith(
      'gw-1',
      expect.objectContaining({ workspace: 'D:\\魔方工作区' }),
    );
  });

  it('工作空间填 `~/工作区` ⇒ 放行（网关会展开成家目录，这条本来就能用，不能一起拒掉）', async () => {
    const container = await openFormAndFill('我的助手', '~/工作区');

    await clickSettle(uniqueButtonByText(container, i18next.t('settings.addAgent')));

    expect(window.clawwork.createAgent).toHaveBeenCalledWith(
      'gw-1',
      expect.objectContaining({ workspace: '~/工作区' }),
    );
  });

  /**
   * ⚠️ **落点只限「新建」**：编辑态的输入框是只读的（值来自网关），不该拦 —— 否则存量里已经被
   * 旧 bug 写成相对路径的助手，连改个名字都会被这里挡住。
   */
  it('⚠️ 编辑存量助手（工作区是旧 bug 留下的相对路径）⇒ 不拦，改名照样能存', async () => {
    // 网关回报的 workspace 就是旧的坏值：`new-agent`
    window.clawwork.listAgentFiles = vi.fn().mockResolvedValue({
      ok: true,
      result: { workspace: 'new-agent', files: [] },
    });

    const { container } = render(<AgentsSection />);
    await settle();

    await clickSettle(findByAriaKeyPrefix(container, i18next.t('settings.agentDetails')));
    await clickSettle(findByAriaKeyPrefix(container, i18next.t('settings.edit')));

    const form = inputByLabel(container, i18next.t('settings.agentName'));
    typeInto(form, '改个名字');

    const saveButtons = buttonsByText(container, i18next.t('common.save'));
    if (saveButtons.length !== 1) throw new Error(`expected exactly 1 save button, got ${saveButtons.length}`);
    await clickSettle(saveButtons[0] as HTMLButtonElement);

    expect(sonnerToast.error).not.toHaveBeenCalledWith(
      i18next.t('settings.agentWorkspaceMustBeAbsolute'),
      expect.anything(),
    );
    expect(window.clawwork.updateAgent).toHaveBeenCalled();
  });
});
