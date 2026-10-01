// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';

const { taskState, setActiveTask, setHighlightedMessage, setMainView } = vi.hoisted(() => ({
  taskState: { activeTaskId: 'current' as string | null, workspaceEpoch: 1 },
  setActiveTask: vi.fn(),
  setHighlightedMessage: vi.fn(),
  setMainView: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: Object.assign(
    (select: (state: unknown) => unknown) => select({ ...taskState, tasks: [], setActiveTask }),
    { getState: () => taskState },
  ),
}));
vi.mock('../src/renderer/stores/messageStore', () => ({
  useMessageStore: (select: (state: unknown) => unknown) => select({ setHighlightedMessage }),
}));
vi.mock('../src/renderer/stores/uiStore', () => ({
  useUiStore: (select: (state: unknown) => unknown) => select({ setMainView }),
}));
vi.mock('../src/renderer/features/team-meeting/instance', () => ({
  useTeamMeetingStore: (select: (state: unknown) => unknown) => select({ records: [] }),
}));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: vi.fn() } }));

import RightPanel from '../src/renderer/layouts/RightPanel';
import { useFileStore } from '../src/renderer/stores/fileStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const current: Artifact = {
  id: 'current-file',
  taskId: 'current',
  messageId: 'current-message',
  type: 'file',
  name: 'current.pptx',
  localPath: 'current/current.pptx',
  filePath: 'E:/workspace/current/current.pptx',
  mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  size: 322251,
  createdAt: '2026-10-02T00:00:00.000Z',
  availability: 'available',
};
const historical: Artifact = {
  ...current,
  id: 'historical-file',
  taskId: 'previous',
  messageId: 'previous-message',
  name: 'report.pptx',
  localPath: 'previous/report.pptx',
  filePath: 'E:/workspace/previous/report.pptx',
};

let root: Root;
let container: HTMLDivElement;

async function mount(artifacts: Artifact[]) {
  Object.assign(window, {
    clawwork: {
      listArtifacts: vi.fn(async (taskId?: string) => ({
        ok: true,
        result: taskId ? artifacts.filter((artifact) => artifact.taskId === taskId) : artifacts,
      })),
      onArtifactSaved: vi.fn(() => () => undefined),
      openArtifactFile: vi.fn(async () => ({ ok: true })),
      showArtifactInFolder: vi.fn(async () => ({ ok: true })),
      saveArtifactAs: vi.fn(async () => ({ ok: true, result: { status: 'cancelled' } })),
    },
  });
  await act(async () => root.render(<RightPanel />));
  const toggle = container.querySelector<HTMLButtonElement>('[data-action="toggle-artifact-history"]');
  if (toggle) act(() => toggle.click());
}

function locateCards() {
  return [...container.querySelectorAll<HTMLButtonElement>('[aria-label="artifactCard.locateMessage"]')];
}

describe('artifact source navigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskState.activeTaskId = 'current';
    taskState.workspaceEpoch = 1;
    useFileStore.setState({ selectedArtifactId: null });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('switches to the historical artifact task before locating its exact message', async () => {
    await mount([current, historical]);
    act(() => locateCards()[1]!.click());
    expect(setActiveTask).toHaveBeenCalledExactlyOnceWith('previous');
    expect(setHighlightedMessage).toHaveBeenCalledExactlyOnceWith('previous-message');
    expect(setMainView).toHaveBeenCalledExactlyOnceWith('chat');
    expect(setActiveTask.mock.invocationCallOrder[0]).toBeLessThan(setHighlightedMessage.mock.invocationCallOrder[0]!);
  });

  it('uses the clicked card message even when another historical file has the same name', async () => {
    const second = { ...historical, id: 'revision-file', messageId: 'revision-message' };
    await mount([current, historical, second]);
    act(() => locateCards()[2]!.click());
    expect(setActiveTask).toHaveBeenCalledExactlyOnceWith('previous');
    expect(setHighlightedMessage).toHaveBeenCalledExactlyOnceWith('revision-message');
  });

  it.each(['workspace', 'task'] as const)(
    'ignores an old history card after %s changes before React renders',
    async (scope) => {
      await mount([current, historical]);
      if (scope === 'workspace') taskState.workspaceEpoch++;
      else taskState.activeTaskId = 'next';
      act(() => locateCards()[1]!.click());
      expect(setActiveTask).not.toHaveBeenCalled();
      expect(setHighlightedMessage).not.toHaveBeenCalled();
      expect(setMainView).not.toHaveBeenCalled();
    },
  );

  it('ignores a stale current card after workspace replacement before React renders', async () => {
    await mount([current]);
    taskState.workspaceEpoch++;
    act(() => locateCards()[0]!.click());
    expect(setHighlightedMessage).not.toHaveBeenCalled();
    expect(setMainView).not.toHaveBeenCalled();
  });

  it('keeps current-card navigation and missing-file source history usable', async () => {
    await mount([current, { ...historical, availability: 'missing' }]);
    act(() => locateCards()[0]!.click());
    expect(setHighlightedMessage).toHaveBeenCalledWith('current-message');
    vi.clearAllMocks();
    act(() => locateCards()[1]!.click());
    expect(setActiveTask).toHaveBeenCalledWith('previous');
    expect(setHighlightedMessage).toHaveBeenCalledWith('previous-message');
    const historicalCard = container.querySelector('[data-history-task] [data-testid="artifact-card"]')!;
    expect(historicalCard.querySelector<HTMLButtonElement>('[aria-label="artifactCard.open"]')!.disabled).toBe(true);
  });

  it('opens and reveals the historical file by its own id and task without moving the conversation', async () => {
    await mount([current, historical]);
    const card = container.querySelector('[data-history-task] [data-testid="artifact-card"]')!;
    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="artifactCard.open"]')!.click());
    await act(async () => card.querySelector<HTMLButtonElement>('[aria-label="artifactCard.showInFolder"]')!.click());
    expect(window.clawwork.openArtifactFile).toHaveBeenCalledWith('historical-file', 'previous');
    expect(window.clawwork.showArtifactInFolder).toHaveBeenCalledWith('historical-file', 'previous');
    expect(setActiveTask).not.toHaveBeenCalled();
    expect(setHighlightedMessage).not.toHaveBeenCalled();
  });
});
