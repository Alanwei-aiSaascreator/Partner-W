// @vitest-environment jsdom

/**
 * Setup 的「盘上首启」形态（T-U1）：**选盘那一步整步跳过**，直接落在网关步骤，
 * 并留一句可改的说明。
 *
 * ⚠️ 这里不许新增 IPC（`App.tsx` / preload 不在本次改动范围内），所以渲染进程
 *    只能从既有 IPC 的返回值里推断状态：
 *    `getWorkspacePath()` 有值 + `isWorkspaceConfigured()` 为 false
 *    = 主进程已经在盘上把工作区自动就位、只等用户把引导走完。
 *    这条推断是本文件的核心契约。
 */

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  // 把插值参数原样带出来，好断言"提示里真的有那个路径"
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options.path === 'string' ? `${key}|${options.path}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import Setup from '../src/renderer/layouts/Setup';

const PORTABLE_PATH = 'E:\\Partner-W工作区';
const DEFAULT_PATH = 'C:\\Users\\u\\ClawWork-Workspace';

type ClawworkApi = {
  isWorkspaceConfigured: ReturnType<typeof vi.fn>;
  getWorkspacePath: ReturnType<typeof vi.fn>;
  getDefaultWorkspacePath: ReturnType<typeof vi.fn>;
  browseWorkspace: ReturnType<typeof vi.fn>;
  setupWorkspace: ReturnType<typeof vi.fn>;
  addGateway: ReturnType<typeof vi.fn>;
  testGateway: ReturnType<typeof vi.fn>;
};

function installApi(overrides: Partial<ClawworkApi> = {}): ClawworkApi {
  const api: ClawworkApi = {
    isWorkspaceConfigured: vi.fn(async () => false),
    getWorkspacePath: vi.fn(async () => null),
    getDefaultWorkspacePath: vi.fn(async () => DEFAULT_PATH),
    browseWorkspace: vi.fn(async () => null),
    setupWorkspace: vi.fn(async () => ({ ok: true })),
    addGateway: vi.fn(async () => ({ ok: true })),
    testGateway: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
  (window as unknown as { clawwork: ClawworkApi }).clawwork = api;
  return api;
}

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
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
  for (let i = 0; i < 10; i += 1) await flushAsync();
}

function buttonFor(container: HTMLElement, key: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((button) => button.textContent?.includes(key));
}

function pathInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[placeholder="setup.selectDir"]');
  expect(input, '找不到工作区路径输入框').toBeTruthy();
  return input as HTMLInputElement;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('盘上首启：跳过选盘那一步', () => {
  it('⭐ 工作区已自动就位 ⇒ 直接落在网关步骤，并说明它在盘上、可改', async () => {
    const api = installApi({
      isWorkspaceConfigured: vi.fn(async () => false),
      getWorkspacePath: vi.fn(async () => PORTABLE_PATH),
      getDefaultWorkspacePath: vi.fn(async () => PORTABLE_PATH),
    });

    const { container, unmount } = render(<Setup onSetupComplete={vi.fn()} />);
    await settle();

    // 落在网关步骤：看得到网关表单，看不到"选目录 + 下一步"
    expect(container.textContent).toContain('setup.gatewayConfig');
    expect(container.textContent).not.toContain('setup.workspaceExplain');
    expect(container.querySelector('input[placeholder="setup.selectDir"]')).toBeNull();

    // 说明里带着真实的盘上路径（用户知道东西在哪、也知道能改）
    expect(container.textContent).toContain(`setup.portableWorkspaceNotice|${PORTABLE_PATH}`);
    expect(api.setupWorkspace).not.toHaveBeenCalled();

    unmount();
  });

  it('点「更改」⇒ 回到工作区步骤，预填的就是盘上那个路径（不强制、可换）', async () => {
    installApi({
      isWorkspaceConfigured: vi.fn(async () => false),
      getWorkspacePath: vi.fn(async () => PORTABLE_PATH),
      getDefaultWorkspacePath: vi.fn(async () => PORTABLE_PATH),
    });

    const { container, unmount } = render(<Setup onSetupComplete={vi.fn()} />);
    await settle();

    const edit = buttonFor(container, 'common.edit');
    expect(edit, '提示上没有「更改」入口').toBeTruthy();
    // 步骤切换走 AnimatePresence（`mode="wait"`）：等退场动画跑完，新面板才挂上。
    await act(async () => {
      edit?.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(container.textContent).toContain('setup.workspaceDir');
    expect(pathInput(container).value).toBe(PORTABLE_PATH);

    unmount();
  });

  it('普通首启（没有盘）⇒ 仍旧停在工作区步骤，预填默认位置', async () => {
    installApi({
      isWorkspaceConfigured: vi.fn(async () => false),
      getWorkspacePath: vi.fn(async () => null),
      getDefaultWorkspacePath: vi.fn(async () => DEFAULT_PATH),
    });

    const { container, unmount } = render(<Setup onSetupComplete={vi.fn()} />);
    await settle();

    expect(container.textContent).toContain('setup.workspaceDir');
    expect(container.textContent).not.toContain('setup.portableWorkspaceNotice');
    expect(pathInput(container).value).toBe(DEFAULT_PATH);

    unmount();
  });

  it('工作区已经配好了（竞态）⇒ 不显示盘上提示，走老路', async () => {
    installApi({
      isWorkspaceConfigured: vi.fn(async () => true),
      getWorkspacePath: vi.fn(async () => DEFAULT_PATH),
      getDefaultWorkspacePath: vi.fn(async () => DEFAULT_PATH),
    });

    const { container, unmount } = render(<Setup onSetupComplete={vi.fn()} />);
    await settle();

    expect(container.textContent).toContain('setup.workspaceDir');
    expect(container.textContent).not.toContain('setup.portableWorkspaceNotice');

    unmount();
  });

  it('探测 IPC 失败 ⇒ 退回老行为（默认位置 + 让用户自己选），不白屏', async () => {
    const api = installApi({
      isWorkspaceConfigured: vi.fn(async () => {
        throw new Error('ipc dead');
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { container, unmount } = render(<Setup onSetupComplete={vi.fn()} />);
    await settle();

    expect(container.textContent).toContain('setup.workspaceDir');
    expect(pathInput(container).value).toBe(DEFAULT_PATH);
    expect(api.getDefaultWorkspacePath.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).not.toContain('setup.portableWorkspaceNotice');

    unmount();
  });

  it('盘上首启不写配置：用户没点"下一步"之前，主进程不该被要求改工作区', async () => {
    const api = installApi({
      isWorkspaceConfigured: vi.fn(async () => false),
      getWorkspacePath: vi.fn(async () => PORTABLE_PATH),
      getDefaultWorkspacePath: vi.fn(async () => PORTABLE_PATH),
    });

    const { container, unmount } = render(<Setup onSetupComplete={vi.fn()} />);
    await settle();

    expect(api.setupWorkspace).not.toHaveBeenCalled();
    expect(api.browseWorkspace).not.toHaveBeenCalled();
    // 用户直接走网关那一步也能完成引导
    expect(buttonFor(container, 'setup.skipGateway')).toBeTruthy();

    unmount();
  });
});
