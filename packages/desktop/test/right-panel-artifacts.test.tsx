// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: (selector: (state: { activeTaskId: string }) => unknown) => selector({ activeTaskId: 'task-1' }),
}));
vi.mock('../src/renderer/stores/messageStore', () => ({
  useMessageStore: (selector: (state: { setHighlightedMessage: () => void }) => unknown) =>
    selector({ setHighlightedMessage: vi.fn() }),
}));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import RightPanel from '../src/renderer/layouts/RightPanel';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact: Artifact = {
  id: 'artifact-1',
  taskId: 'task-1',
  messageId: 'message-1',
  type: 'file',
  name: 'report.txt',
  filePath: '',
  localPath: 'task-1/report.txt',
  mimeType: 'text/plain',
  size: 12,
  createdAt: '2026-09-16T08:00:00.000Z',
  availability: 'available',
};

describe('RightPanel artifacts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('refreshes the list and displays a newly missing file state', async () => {
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: [artifact] })
      .mockResolvedValueOnce({ ok: true, result: [{ ...artifact, availability: 'missing' }] });
    Object.assign(window, {
      clawwork: {
        listArtifacts,
        onArtifactSaved: vi.fn(() => () => undefined),
        readArtifactThumbnail: vi.fn(),
        saveArtifactAs: vi.fn(),
        openArtifactFile: vi.fn(),
        showArtifactInFolder: vi.fn(),
      },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => root.render(<RightPanel />));

    expect(container.textContent).toContain('report.txt');
    const refresh = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.refresh"]');
    expect(refresh).not.toBeNull();
    await act(async () => refresh?.click());
    expect(listArtifacts).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('artifactCard.missing');

    act(() => root.unmount());
    container.remove();
  });
});
