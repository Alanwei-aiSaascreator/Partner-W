// @vitest-environment jsdom

/**
 * 记忆一期（第一层「关于你」）。
 *
 * 判据只有三条，但每条都有具体的假话要防：
 *   ① **超上限不许存** —— 截断着存下去等于用户写的后半段**静默消失**；
 *   ② **写给盘上每一个助手** —— 产品口径是"这块盘懂我"，只写一个就是半句话；
 *   ③ **部分失败不许报成功** —— 那是最容易写出来的假话。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/toast', () => ({ toast: toastMock }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('|')}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import MemorySection from '../src/renderer/layouts/Settings/sections/MemorySection';
import { KERNEL_USER_MD_TEMPLATE_BODY } from '../src/renderer/lib/user-md-template';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS = [{ id: 'agent-a' }, { id: 'agent-b' }, { id: 'agent-c' }];

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

let getAgentFile: ReturnType<typeof vi.fn>;
let setAgentFile: ReturnType<typeof vi.fn>;
/** 长期记忆那一半（`MemoryEntriesSection`）用的 IPC —— 这一页现在会渲染它。 */
let memoryList: ReturnType<typeof vi.fn>;
let memorySync: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // ⚠️ 真机载荷是 `{ agentId, workspace, file: AgentFileEntry }`（白皮书 / preset-agent-installer
  //    / AgentsSection / TeamDetailView 四处都是 `result.file.content`）。桩成 `{content}` 的
  //    错位形状正是 2026-10-07 体检抓到的"记忆页永远显示为空"那条路。
  getAgentFile = vi.fn(async () => ({
    ok: true,
    result: { file: { name: 'USER.md', content: '我习惯先看结论。', missing: false } },
  }));
  setAgentFile = vi.fn(async () => ({ ok: true }));
  memoryList = vi.fn(async () => ({ ok: true, ownerUserId: 'user-a', entries: [], pending: [], rejected: [] }));
  memorySync = vi.fn(async () => ({ ok: true, sync: { status: 'synced', written: [], unchanged: [], failed: [] } }));
  (globalThis.window as unknown as { clawwork: Record<string, unknown> }).clawwork = {
    getAgentFile,
    setAgentFile,
    memoryList,
    memorySync,
    onMemoryChanged: () => () => {},
  };
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    agentCatalogByGateway: { 'gw-1': { agents: AGENTS, defaultId: 'agent-a' } },
  } as never);
});

afterEach(() => {
  useUiStore.setState({ defaultGatewayId: null, agentCatalogByGateway: {} } as never);
});

/**
 * 「关于你」那个输入框。
 *
 * ⚠️ **按 testid 取，不按 `querySelector('textarea')`**（2026-10-16 改）：这一页现在
 *    还渲染长期记忆那一半（它有自己的输入框），第 N 个 textarea 不再是契约。
 */
function aboutYouTextarea(container: HTMLElement): HTMLTextAreaElement | null {
  return container.querySelector('[data-testid="memory-about-you-input"]');
}

/** 往受控 textarea 里写值（React 的受控组件要这样触发 onChange） */
function setTextarea(container: HTMLElement, value: string): void {
  const textarea = aboutYouTextarea(container) as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/** 等一拍（effect 里的 promise 链需要） */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('MemorySection（记忆一期）', () => {
  it('读出当前这份「关于你」，放进输入框', async () => {
    const { container, unmount } = render(<MemorySection />);
    await flush();

    const textarea = aboutYouTextarea(container);
    expect(textarea?.value).toBe('我习惯先看结论。');
    unmount();
  });

  /**
   * 🔴 2026-10-15（E2 复核）：读的必须是**默认助手**那一份。
   *
   * 从前读的是 `agents[0]`（数组第一个）—— 而目录**顺序不是契约**：库里别处
   * （`AgentBuilderDialog` / `TeamBuilderDialog` / `useGatewaySelector`）一律用
   * `defaultId ?? 'main'`。两者一旦不是同一个助手，这一页就会展示**另一个助手**的
   * 「关于你」：用户照着它改、点保存，等于拿错的那份当基线。
   *
   * ⚠️ 写仍然是**写给全部**助手（见下一条用例）—— 变的是"拿谁当展示基线"。
   */
  it('⭐ 读的是**默认助手**那一份，不是数组第一个（defaultId 才是用户在用的那个）', async () => {
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: { 'gw-1': { agents: AGENTS, defaultId: 'agent-b' } },
    } as never);
    getAgentFile.mockImplementation(async (_gw: string, agentId: string) => ({
      ok: true,
      result: { file: { name: 'USER.md', content: `${agentId} 的记忆`, missing: false } },
    }));

    const { container, unmount } = render(<MemorySection />);
    await flush();

    expect(getAgentFile).toHaveBeenCalledWith('gw-1', 'agent-b', 'USER.md');
    expect(aboutYouTextarea(container)?.value).toBe('agent-b 的记忆');
    unmount();
  });

  it('默认助手不在目录里（目录还没加载全/它被删了）⇒ 退回第一个，不许空白', async () => {
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: { 'gw-1': { agents: AGENTS, defaultId: 'agent-zzz' } },
    } as never);

    const { container, unmount } = render(<MemorySection />);
    await flush();

    expect(getAgentFile).toHaveBeenCalledWith('gw-1', 'agent-a', 'USER.md');
    expect(aboutYouTextarea(container)?.value).toBe('我习惯先看结论。');
    unmount();
  });

  it('⭐ 保存写给**盘上每一个助手**（不是只写第一个 —— 口径是"这块盘懂我"）', async () => {
    const { container, unmount } = render(<MemorySection />);
    await flush();

    act(() => setTextarea(container, '我习惯先看结论。再加一句。'));
    const save = container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement;
    await act(async () => {
      save.click();
      await Promise.resolve();
    });

    expect(setAgentFile).toHaveBeenCalledTimes(3);
    for (const agent of AGENTS) {
      expect(setAgentFile).toHaveBeenCalledWith('gw-1', agent.id, 'USER.md', '我习惯先看结论。再加一句。');
    }
    unmount();
  });

  /**
   * ⭐ 超限拦截。
   *
   * ⚠️ 这条**必须"改过"再超限**：如果读取的内容本身就超限，`dirty` 是 false，
   *    按钮会因为"没改过"而禁用 —— 那样这条用例**通过的理由是错的**（变异电池实测抓到过）。
   */
  it('⭐ 超出上限 ⇒ 保存按钮禁用 + 当面说明（**不允许**截断着存下去）', async () => {
    const { container, unmount } = render(<MemorySection />);
    await flush();

    act(() => setTextarea(container, 'x'.repeat(4001)));

    expect(container.querySelector('[data-testid="memory-over-limit"]')).not.toBeNull();
    expect((container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement).disabled).toBe(true);

    // 就算硬点下去也不许存
    await act(async () => {
      (container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(setAgentFile).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 部分失败**不许**报"已保存"（那是最容易写出来的假话）', async () => {
    setAgentFile.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: false, error: 'boom' });
    const { container, unmount } = render(<MemorySection />);
    await flush();

    act(() => setTextarea(container, '改了'));
    await act(async () => {
      (container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('memorySavePartial'));
    unmount();
  });

  it('对照：没改过时保存按钮是禁用的（不给一个按了没事发生的钮）', async () => {
    const { container, unmount } = render(<MemorySection />);
    await flush();

    expect((container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement).disabled).toBe(true);
    unmount();
  });

  /**
   * 🔴 2026-10-07 体检问题 1/2 的同族：读失败**不许**当"空文件"。
   * 空输入框 + 可保存 = 用户补一句一按，盘上真实存在的记忆被整份覆盖。
   */
  it('🔴 读失败（ok:false）⇒ 不显示可编辑的空输入框，如实报读失败', async () => {
    getAgentFile.mockResolvedValue({ ok: false, error: 'gateway down' });
    const { container, unmount } = render(<MemorySection />);
    await flush();

    expect(aboutYouTextarea(container)).toBeNull();
    expect(container.querySelector('[data-testid="memory-save"]')).toBeNull();
    expect(container.textContent).toContain('gateway down');
    unmount();
  });

  it('🔴 载荷形状错位（旧代码读 result.content 的那种）⇒ 同样当读失败，不给编辑口', async () => {
    getAgentFile.mockResolvedValue({ ok: true, result: { content: '错位的字段' } });
    const { container, unmount } = render(<MemorySection />);
    await flush();

    expect(aboutYouTextarea(container)).toBeNull();
    expect(container.textContent).toContain('memoryReadFailed');
    unmount();
  });

  it('文件不存在（missing:true）⇒ 是"空记忆"不是"读失败"：照常给编辑口', async () => {
    getAgentFile.mockResolvedValue({ ok: true, result: { file: { name: 'USER.md', content: '', missing: true } } });
    const { container, unmount } = render(<MemorySection />);
    await flush();

    expect(aboutYouTextarea(container)?.value).toBe('');
    unmount();
  });
});

/**
 * 🔴 2026-10-18 用户反馈「这个记忆为什么自带了英文」。
 *
 * 根因不是"网关缺省回包"，而是内核首次准备时把
 * `docs/reference/templates/USER.md` 的英文正文**落成了盘上真实文件**（`KERNEL_USER_MD_TEMPLATE_BODY`）。
 * 这一组用例钉住两件事：
 *   ① 一字未改的内核模板 ⇒ 展示本地化骨架（`# 关于你`），英文不上屏；
 *   ② 真实用户内容 ⇒ **一个字节都不许动**（判据不许误伤手写记忆）。
 */
describe('MemorySection · 内核默认 USER.md 模板本地化', () => {
  /** 骨架由 i18n key 拼成（测试里的 `t` 桩返回 key 本身）。 */
  const SKELETON_PATTERN =
    /^# settings\.memoryUserMdTitle\n<!-- settings\.memoryUserMdObserved:\d{4}-\d{2}-\d{2} -->\n\nsettings\.memoryUserMdSampleDirective$/;

  function provideContent(content: string): void {
    getAgentFile.mockResolvedValue({
      ok: true,
      result: { file: { name: 'USER.md', content, missing: false } },
    });
  }

  it('⭐ 读到一字未改的内核英文模板 ⇒ 输入框展示本地化骨架，英文模板不上屏', async () => {
    provideContent(KERNEL_USER_MD_TEMPLATE_BODY);

    const { container, unmount } = render(<MemorySection />);
    await flush();

    const value = aboutYouTextarea(container)?.value ?? '';
    expect(value).toMatch(SKELETON_PATTERN);
    expect(value).not.toContain('USER.md - User Model');
    expect(value).not.toContain('Store stable user preferences');
    unmount();
  });

  it('默认模板展示成骨架时"没改过" ⇒ 保存按钮禁用（不给一个按了没事发生的钮）', async () => {
    provideContent(KERNEL_USER_MD_TEMPLATE_BODY);

    const { container, unmount } = render(<MemorySection />);
    await flush();

    expect((container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement).disabled).toBe(true);
    unmount();
  });

  it('⭐ 在骨架上补自己的内容再保存 ⇒ 写的是「本地化骨架 + 用户内容」，英文模板不再写回', async () => {
    provideContent(KERNEL_USER_MD_TEMPLATE_BODY);

    const { container, unmount } = render(<MemorySection />);
    await flush();

    const skeleton = aboutYouTextarea(container)?.value ?? '';
    expect(skeleton).toMatch(SKELETON_PATTERN);

    const edited = `${skeleton}\n\n- 汇报时先给结论，再给过程。`;
    act(() => setTextarea(container, edited));
    await act(async () => {
      (container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    expect(setAgentFile).toHaveBeenCalledTimes(AGENTS.length);
    for (const agent of AGENTS) {
      expect(setAgentFile).toHaveBeenCalledWith('gw-1', agent.id, 'USER.md', edited);
    }
    const written = setAgentFile.mock.calls[0][3] as string;
    expect(written).not.toContain('USER.md - User Model');
    expect(written).not.toContain('observed: YYYY-MM-DD');
    unmount();
  });

  it('🔴 真实用户内容（模板被改过一行）⇒ 逐字节展示，且保存写出的是同一份，不加骨架', async () => {
    const real = `${KERNEL_USER_MD_TEMPLATE_BODY.replace('- Prefer ...', '- Always 先给结论。')}\n\n## 我的补充\n\n- 汇报用中文。`;
    provideContent(real);

    const { container, unmount } = render(<MemorySection />);
    await flush();

    expect(aboutYouTextarea(container)?.value).toBe(real);

    const edited = `${real}\n- 别用感叹号。`;
    act(() => setTextarea(container, edited));
    await act(async () => {
      (container.querySelector('[data-testid="memory-save"]') as HTMLButtonElement).click();
      await Promise.resolve();
    });

    for (const agent of AGENTS) {
      expect(setAgentFile).toHaveBeenCalledWith('gw-1', agent.id, 'USER.md', edited);
    }
    unmount();
  });
});
