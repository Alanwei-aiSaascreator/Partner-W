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

beforeEach(() => {
  vi.clearAllMocks();
  getAgentFile = vi.fn(async () => ({ ok: true, result: { content: '我习惯先看结论。' } }));
  setAgentFile = vi.fn(async () => ({ ok: true }));
  (globalThis.window as unknown as { clawwork: Record<string, unknown> }).clawwork = { getAgentFile, setAgentFile };
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    agentCatalogByGateway: { 'gw-1': { agents: AGENTS, defaultId: 'agent-a' } },
  } as never);
});

afterEach(() => {
  useUiStore.setState({ defaultGatewayId: null, agentCatalogByGateway: {} } as never);
});

/** 往受控 textarea 里写值（React 的受控组件要这样触发 onChange） */
function setTextarea(container: HTMLElement, value: string): void {
  const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
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

    const textarea = container.querySelector('textarea');
    expect(textarea?.value).toBe('我习惯先看结论。');
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
});
