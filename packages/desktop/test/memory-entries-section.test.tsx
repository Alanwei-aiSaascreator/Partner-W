// @vitest-environment jsdom

/**
 * 长期记忆那一半的界面（确认轨道）。
 *
 * 判据（每条都对着一个具体的假话）：
 *   · **草案与已保存分栏** —— 混在一起用户会以为"它已经记住了"（未确认不上屏）；
 *   · **确认才落库** —— 点确认之前不许出现"已保存"；
 *   · **拒绝要留痕**（界面如实说"以后不会再提同一件"）；
 *   · **部分助手没写成要如实说** —— 不许报"全部成功"；
 *   · **失败原因要分得清**（超长 / 重复 / 库不可用各有各的话），不许一句"操作失败"。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));

vi.mock('@/lib/toast', () => ({ toast: toastMock }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('|')}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import MemoryEntriesSection from '../src/renderer/layouts/Settings/sections/MemoryEntriesSection';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENTRY = {
  id: 'e1',
  ownerUserId: 'user-a',
  text: '用户希望结论先行。',
  status: 'confirmed' as const,
  source: 'user' as const,
  sourceTaskId: null,
  sourceMessageId: null,
  dedupeKey: 'k1',
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
  decidedAt: '2026-10-16T00:00:00.000Z',
};

const DRAFT = {
  ...ENTRY,
  id: 'd1',
  text: '助手想的：用户在做电商。',
  status: 'pending' as const,
  source: 'assistant' as const,
  decidedAt: null,
};

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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

let memoryList: ReturnType<typeof vi.fn>;
let memoryCreate: ReturnType<typeof vi.fn>;
let memoryDelete: ReturnType<typeof vi.fn>;
let memoryConfirmDraft: ReturnType<typeof vi.fn>;
let memoryRejectDraft: ReturnType<typeof vi.fn>;
let memorySync: ReturnType<typeof vi.fn>;

const SYNCED = { status: 'synced' as const, written: ['main'], unchanged: [], failed: [] };

beforeEach(() => {
  vi.clearAllMocks();
  memoryList = vi.fn(async () => ({ ok: true, ownerUserId: 'user-a', entries: [ENTRY], pending: [DRAFT], rejected: [] }));
  memoryCreate = vi.fn(async () => ({ ok: true, entry: ENTRY, sync: SYNCED }));
  memoryDelete = vi.fn(async () => ({ ok: true, entry: ENTRY, sync: SYNCED }));
  memoryConfirmDraft = vi.fn(async () => ({ ok: true, entry: { ...DRAFT, status: 'confirmed' }, sync: SYNCED }));
  memoryRejectDraft = vi.fn(async () => ({ ok: true, entry: { ...DRAFT, status: 'rejected' } }));
  memorySync = vi.fn(async () => ({ ok: true, sync: SYNCED }));
  (globalThis.window as unknown as { clawwork: Record<string, unknown> }).clawwork = {
    memoryList,
    memoryCreate,
    memoryDelete,
    memoryConfirmDraft,
    memoryRejectDraft,
    memorySync,
    onMemoryChanged: () => () => {},
  };
  useUiStore.setState({ defaultGatewayId: 'gw-1' } as never);
});

afterEach(() => {
  useUiStore.setState({ defaultGatewayId: null } as never);
});

describe('长期记忆界面', () => {
  it('⭐ 草案只在**待确认**那一栏，已保存那一栏里没有它（未确认不上屏）', async () => {
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    const draftItems = container.querySelectorAll('[data-testid="memory-draft-item"]');
    expect(draftItems).toHaveLength(1);
    expect(draftItems[0].textContent).toContain('助手想的：用户在做电商。');

    const entryItems = container.querySelectorAll('[data-testid="memory-entry-item"]');
    expect(entryItems).toHaveLength(1);
    expect(entryItems[0].textContent).toContain('用户希望结论先行。');
    expect(entryItems[0].textContent).not.toContain('助手想的');
    unmount();
  });

  it('⭐ 点确认才调 IPC，并带上当前 gateway（确认 = 落库那一步）', async () => {
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    await act(async () => {
      (container.querySelector('[data-testid="memory-draft-confirm"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(memoryConfirmDraft).toHaveBeenCalledWith({ id: 'd1', text: undefined, gatewayId: 'gw-1' });
    expect(memoryList.mock.calls.length).toBeGreaterThan(1); // 确认后重新读
    unmount();
  });

  it('⭐ 编辑之后确认：把**用户改过**的正文送上去（不是原草案）', async () => {
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    act(() => {
      (container.querySelector('[data-testid="memory-draft-edit"]') as HTMLButtonElement).click();
    });
    const textarea = container.querySelector(
      '[aria-label="settings.memoryDraftEdit"]',
    ) as HTMLTextAreaElement;
    expect(textarea.value).toBe('助手想的：用户在做电商。');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(textarea, '用户在做跨境电商。');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      (container.querySelector('[data-testid="memory-draft-save-edit"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(memoryConfirmDraft).toHaveBeenCalledWith({ id: 'd1', text: '用户在做跨境电商。', gatewayId: 'gw-1' });
    unmount();
  });

  it('拒绝走 reject 通道（**不是**删除），并如实说明以后不会再提同一件', async () => {
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    await act(async () => {
      (container.querySelector('[data-testid="memory-draft-reject"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(memoryRejectDraft).toHaveBeenCalledWith({ id: 'd1', gatewayId: 'gw-1' });
    expect(memoryDelete).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="memory-reject-note"]')?.textContent).toContain('settings.memoryRejectNote');
    unmount();
  });

  it('⭐ 部分助手没写成 ⇒ 报"部分失败"，**不报成功**', async () => {
    memoryCreate.mockResolvedValueOnce({
      ok: true,
      entry: ENTRY,
      sync: { status: 'synced', written: ['main'], unchanged: [], failed: [{ agentId: 'agent-a', error: 'boom' }] },
    });
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    const input = container.querySelector('[data-testid="memory-add-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, '新的一条记忆');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="memory-add"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('memorySyncPartial'));
    expect(container.querySelector('[data-testid="memory-sync-partial"]')?.textContent).toContain('memorySyncPartial');
    unmount();
  });

  it('失败原因分得清：超长 / 重复 / 库不可用各有各的文案', async () => {
    memoryCreate.mockResolvedValueOnce({ ok: false, reason: 'over-limit', limit: 500 });
    const first = render(<MemoryEntriesSection />);
    await flush();
    const input = first.container.querySelector('[data-testid="memory-add-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, 'x');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (first.container.querySelector('[data-testid="memory-add"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('memoryErrorOverLimit'));
    first.unmount();
    vi.clearAllMocks();
  });

  it('库不可用 ⇒ 如实报错，**不给**一个看起来空着的列表', async () => {
    memoryList.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    expect(container.querySelector('[data-testid="memory-entries-error"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="memory-entry-list"]')).toBeNull();
    unmount();
  });

  it('一条记忆都没有时给的是"没有"这句实话，不是空白', async () => {
    memoryList.mockResolvedValueOnce({ ok: true, ownerUserId: 'user-a', entries: [], pending: [], rejected: [] });
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    expect(container.querySelector('[data-testid="memory-entries-empty"]')?.textContent).toContain(
      'settings.memoryEntriesEmpty',
    );
    expect(container.querySelector('[data-testid="memory-drafts-empty"]')?.textContent).toContain(
      'settings.memoryDraftsEmpty',
    );
    unmount();
  });

  it('删除一条已保存的记忆会调 delete IPC', async () => {
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    await act(async () => {
      (container.querySelector('[data-testid="memory-entry-delete"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(memoryDelete).toHaveBeenCalledWith({ id: 'e1', gatewayId: 'gw-1' });
    unmount();
  });

  it('本页打开时补一次投影（换账号 / 换盘之后文件里可能是上一账号那批）', async () => {
    const { unmount } = render(<MemoryEntriesSection />);
    await flush();
    expect(memorySync).toHaveBeenCalledWith({ gatewayId: 'gw-1' });
    unmount();
  });

  /**
   * ⭐⭐ 2026-10-16（T27）：**没投影 = 不许报成功**。
   *
   * 场景是"网关没连 / 没有 gatewayId"时的删除：库里那行真删了，但助手真正读的
   * `MEMORY.md` 上还留着正文 —— 此时若弹「已删除」，用户会以为助手不会再读到，
   * 实际上它下一轮照样读到。这是**表面成功**，本项目完成语义红线明令禁止。
   */
  it('⭐ 删除时网关没连（sync=skipped）⇒ **不报"已删除"**，如实说"还没同步"', async () => {
    memoryDelete.mockResolvedValueOnce({ ok: true, entry: ENTRY, sync: { status: 'skipped', reason: 'gateway-not-connected' } });
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    await act(async () => {
      (container.querySelector('[data-testid="memory-entry-delete"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toastMock.success).not.toHaveBeenCalledWith('settings.memoryDeleted');
    expect(toastMock.warning).toHaveBeenCalledWith('settings.memorySyncPending');
    unmount();
  });

  it('⭐ 新增时没有 gatewayId（sync=skipped，reason=no-gateway）⇒ 同样不报成功', async () => {
    memoryCreate.mockResolvedValueOnce({ ok: true, entry: ENTRY, sync: { status: 'skipped', reason: 'no-gateway' } });
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    const input = container.querySelector('[data-testid="memory-add-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, '结论先行');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="memory-add"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toastMock.success).not.toHaveBeenCalledWith('settings.memoryAdded');
    expect(toastMock.warning).toHaveBeenCalledWith('settings.memorySyncPending');
    unmount();
  });

  it('对照：真的投影成功（synced 且零失败）⇒ 仍然报成功', async () => {
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();
    await act(async () => {
      (container.querySelector('[data-testid="memory-entry-delete"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toastMock.success).toHaveBeenCalledWith('settings.memoryDeleted');
    expect(toastMock.warning).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 保存失败时**不清空**用户刚打的字（清了就等于把内容丢了）', async () => {
    memoryCreate.mockResolvedValueOnce({ ok: false, reason: 'duplicate' });
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    const input = container.querySelector('[data-testid="memory-add-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, '用户已经记过的一条');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="memory-add"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toastMock.error).toHaveBeenCalledWith(expect.stringContaining('memoryErrorDuplicate'));
    expect((container.querySelector('[data-testid="memory-add-input"]') as HTMLTextAreaElement).value).toBe(
      '用户已经记过的一条',
    );
    unmount();
  });

  it('保存成功才清空输入框', async () => {
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();

    const input = container.querySelector('[data-testid="memory-add-input"]') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(input, '一条新记忆');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      (container.querySelector('[data-testid="memory-add"]') as HTMLButtonElement).click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(toastMock.success).toHaveBeenCalledWith('settings.memoryAdded');
    expect((container.querySelector('[data-testid="memory-add-input"]') as HTMLTextAreaElement).value).toBe('');
    unmount();
  });

  it('空输入时新增按钮是禁用的（不给一个按了没事发生的钮）', async () => {
    const { container, unmount } = render(<MemoryEntriesSection />);
    await flush();
    expect((container.querySelector('[data-testid="memory-add"]') as HTMLButtonElement).disabled).toBe(true);
    unmount();
  });
});
