// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { ImportedMaterialFile } from '../src/renderer/components/ChatInput/useTaskMaterials';

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
        fileName: 'selected.txt',
        localPath: 'tasks/task-1/inbox/selected.txt',
        mimeType: 'text/plain',
        size: 10,
        availability: 'available',
      },
      {
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
        onToggleImported={vi.fn()}
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
});
