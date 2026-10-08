// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ImportedMaterialFile } from '../src/renderer/components/ChatInput/useTaskMaterials';
import zh from '../src/renderer/i18n/locales/zh.json';

const t = (key: string) => key;
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

import TaskMaterials from '../src/renderer/components/ChatInput/TaskMaterials';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('TaskMaterials', () => {
  it('shows selected and missing states without using color alone', () => {
    const files: ImportedMaterialFile[] = [
      {
        taskId: 'task-1',
        fileName: 'selected.txt',
        localPath: 'tasks/task-1/inbox/selected.txt',
        mimeType: 'text/plain',
        size: 10,
        availability: 'available',
      },
      {
        taskId: 'task-1',
        fileName: 'missing.txt',
        localPath: 'tasks/task-1/inbox/missing.txt',
        mimeType: 'text/plain',
        size: 10,
        availability: 'missing',
      },
    ];
    const { container, unmount } = render(
      <TaskMaterials
        importedFiles={files}
        selectedImportedPaths={new Set(['tasks/task-1/inbox/selected.txt'])}
        sources={[]}
        binaryCount={1}
        countLimit={30}
        onTrimToLimit={vi.fn()}
        onToggleImported={vi.fn()}
        onRemoveReference={vi.fn()}
        onRevokeSource={vi.fn()}
      />,
    );

    expect(container.textContent).toContain('selected.txt');
    expect(container.textContent).toContain('chatInput.materialSelected');
    expect(container.textContent).toContain('missing.txt');
    expect(container.textContent).toContain('chatInput.materialMissing');
    expect(container.querySelector('button[disabled]')?.textContent).toContain('missing.txt');
    unmount();
  });

  /**
   * BUG-029：**当前引用**要有一个明确的移除入口。
   *
   * 三条判据（都是用户可见的）：
   * 1. 只有「已引用」的材料才挂 ×（没引用的材料不挂 —— 移除引用 ≠ 删材料）；
   * 2. 文案是「从当前对话移除」，**不是**"删除文件"式措辞（那会让人以为源文件被删）；
   * 3. 点下去走的是**移除引用**那条回调，不是开关（开关会把"再点一次"变成"又加回来"）。
   */
  it('⭐ 已引用的材料挂「从当前对话移除」，没引用的不挂', () => {
    const onToggleImported = vi.fn();
    const onRemoveReference = vi.fn();
    const files: ImportedMaterialFile[] = [
      {
        taskId: 'task-1',
        fileName: 'referenced.txt',
        localPath: 'tasks/task-1/inbox/referenced.txt',
        mimeType: 'text/plain',
        size: 10,
        availability: 'available',
      },
      {
        taskId: 'task-1',
        fileName: 'plain.txt',
        localPath: 'tasks/task-1/inbox/plain.txt',
        mimeType: 'text/plain',
        size: 10,
        availability: 'available',
      },
    ];
    const { container, unmount } = render(
      <TaskMaterials
        importedFiles={files}
        selectedImportedPaths={new Set(['tasks/task-1/inbox/referenced.txt'])}
        sources={[]}
        binaryCount={1}
        countLimit={30}
        onTrimToLimit={vi.fn()}
        onToggleImported={onToggleImported}
        onRemoveReference={onRemoveReference}
        onRevokeSource={vi.fn()}
      />,
    );

    const remove = container.querySelector('button[aria-label="chatInput.removeReference"]');
    expect(remove, '引用的材料要有 ×').not.toBeNull();
    expect(container.querySelectorAll('button[aria-label="chatInput.removeReference"]')).toHaveLength(1);

    act(() => (remove as HTMLButtonElement).click());
    expect(onRemoveReference).toHaveBeenCalledWith('tasks/task-1/inbox/referenced.txt');
    expect(onToggleImported, '× 不是开关').not.toHaveBeenCalled();
    unmount();
  });

  it('「从当前对话移除」的文案就是这句 —— 不许写成"删除文件"', () => {
    expect(zh.chatInput.removeReference).toBe('从当前对话移除');
    expect(zh.chatInput.removeReference).not.toContain('删除');
    expect(zh.chatInput.removeReference).not.toContain('文件');
  });
});
