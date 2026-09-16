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
import { useFileStore } from '../src/renderer/stores/fileStore';

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
    useFileStore.setState({ selectedArtifactId: null });
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

  it('marks the selected artifact from the active task in the rendered list', async () => {
    const newestArtifact = {
      ...artifact,
      id: 'artifact-newest',
      name: 'latest-report.txt',
      createdAt: '2026-09-17T08:00:00.000Z',
    };
    useFileStore.setState({ selectedArtifactId: newestArtifact.id });
    Object.assign(window, {
      clawwork: {
        listArtifacts: vi.fn(async () => ({ ok: true, result: [artifact, newestArtifact] })),
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

    const selected = container.querySelector('[aria-current="true"]');
    expect(selected).not.toBeNull();
    expect(selected?.textContent).toContain('latest-report.txt');
    expect(selected?.classList.contains('border-[var(--border-accent)]')).toBe(true);

    act(() => root.unmount());
    container.remove();
  });

  it('does not mark an artifact selected when the selected id belongs to another task', async () => {
    useFileStore.setState({ selectedArtifactId: 'external-artifact' });
    const externalArtifact = {
      ...artifact,
      id: 'external-artifact',
      taskId: 'task-2',
      name: 'external-report.txt',
    };
    Object.assign(window, {
      clawwork: {
        listArtifacts: vi.fn(async () => ({ ok: true, result: [artifact, externalArtifact] })),
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

    expect(container.querySelector('[aria-current="true"]')).toBeNull();

    act(() => root.unmount());
    container.remove();
  });
});
