// @vitest-environment jsdom
import { act, type MouseEvent as ReactMouseEvent, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T2a：任务右键菜单的每一项**必须**接到它自己那个动作上。
 *
 * 来由（如实记）：2026-09-18 核 T2a「重命名」时，我一度读错了一处 `sed` 输出，
 * 判断「重命名」那一项接到了 `sessionActions.reset` 上（点重命名会弹重置会话）。
 * **那是误读，不是真 bug** —— 复核后 `ContextMenu.tsx` 在那之前就没有被改过，
 * 重命名一直是接对的，我当时向用户更正过。
 *
 * 这份测试因此**不是**某个 bug 的回归钉，而是接线守卫：删掉那条误判之后，
 * "菜单文案 ↔ 实际动作"这个对应关系仍然值得钉住 —— 它一旦错位，
 * 用户点的是一个意思、系统做的是另一个意思，是这类菜单最危险的一种坏法。
 *
 * 这里钉的不是"重命名能用"（`TaskItem` 的就地编辑一直是好的），而是**接线**。
 */

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // ⚠️ 这个桩不能省：import 链会走到真实 i18n 初始化，它要 `i18n.use(initReactI18next)`。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import { useTaskContextMenu, type SessionActions } from '../src/renderer/components/ContextMenu';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let menu: ReturnType<typeof useTaskContextMenu> | null = null;

function Harness({ actions }: { actions: SessionActions }): ReactElement | null {
  menu = useTaskContextMenu(() => {}, actions);
  return null;
}

function makeActions(): SessionActions {
  return {
    rename: vi.fn(),
    compact: vi.fn(),
    reset: vi.fn(),
    deleteTask: vi.fn(),
    exportMarkdown: vi.fn(),
    exportMarkdownAs: vi.fn(),
    isConnected: () => true,
  };
}

const findItem = (label: RegExp) => menu?.items.find((item) => label.test(item.label));

describe('任务右键菜单的接线', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    menu = null;
  });

  it('⭐ 「重命名」调的是 rename，**不是** reset（点重命名不该弹"重置会话"）', async () => {
    const actions = makeActions();
    await act(async () => root.render(<Harness actions={actions} />));
    await act(async () => {
      menu?.openMenu({ preventDefault: () => {} } as unknown as ReactMouseEvent, 'task-1', 'active');
    });

    const renameItem = findItem(/重命名|rename/i);
    expect(renameItem, '菜单里必须有「重命名」').toBeTruthy();

    act(() => renameItem?.action());

    expect(actions.rename, '重命名项必须开重命名').toHaveBeenCalledWith('task-1');
    expect(actions.reset, '接到 reset 上 = 用户点重命名却弹出重置会话的确认框').not.toHaveBeenCalled();
  });

  it('每个标签各自接对：删除/归档不会误触重命名或重置', async () => {
    const actions = makeActions();
    const statuses: string[] = [];
    await act(async () => {
      root.render(<HarnessWithStatus actions={actions} onStatus={(id, status) => statuses.push(`${id}:${status}`)} />);
    });
    await act(async () => {
      menu?.openMenu({ preventDefault: () => {} } as unknown as ReactMouseEvent, 'task-2', 'active');
    });

    act(() => findItem(/删除|delete/i)?.action());
    act(() => findItem(/归档|archive/i)?.action());

    expect(actions.deleteTask).toHaveBeenCalledWith('task-2');
    expect(statuses).toEqual(['task-2:archived']);
    expect(actions.rename).not.toHaveBeenCalled();
    expect(actions.reset).not.toHaveBeenCalled();
  });
});

let cachedMenu: ReturnType<typeof useTaskContextMenu> | null = null;
function HarnessWithStatus({
  actions,
  onStatus,
}: {
  actions: SessionActions;
  onStatus: (id: string, status: string) => void;
}): ReactElement | null {
  cachedMenu = useTaskContextMenu((id, status) => onStatus(id, status), actions);
  menu = cachedMenu;
  return null;
}
