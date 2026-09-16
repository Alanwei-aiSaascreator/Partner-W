// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import ArtifactCard from '../src/renderer/components/ArtifactCard';
import ChatMessage from '../src/renderer/components/ChatMessage';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact: Artifact = {
  id: 'artifact-1',
  taskId: 'task-1',
  messageId: 'message-1',
  type: 'file',
  name: 'report.pdf',
  filePath: 'report.pdf',
  localPath: 'task-1/report.pdf',
  mimeType: 'application/pdf',
  size: 2048,
  createdAt: '2026-09-16T08:00:00.000Z',
  availability: 'available',
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

describe('ArtifactCard', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    Object.assign(window, {
      clawwork: {
        saveArtifactAs: vi.fn(async () => ({ ok: true, result: { status: 'saved', filePath: 'C:/report.pdf' } })),
        openArtifactFile: vi.fn(async () => ({ ok: true })),
        showArtifactInFolder: vi.fn(async () => ({ ok: true })),
      },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it('shows metadata and invokes id-scoped actions', async () => {
    const { container, unmount } = render(<ArtifactCard artifact={artifact} assistantLabel="高效办公" />);

    expect(container.textContent).toContain('report.pdf');
    expect(container.textContent).toContain('高效办公');
    const save = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.saveAs"]');
    const open = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.open"]');
    const reveal = container.querySelector<HTMLButtonElement>('[aria-label="artifactCard.showInFolder"]');
    await act(async () => save?.click());
    await act(async () => open?.click());
    await act(async () => reveal?.click());

    expect(window.clawwork.saveArtifactAs).toHaveBeenCalledWith('artifact-1', 'task-1');
    expect(window.clawwork.openArtifactFile).toHaveBeenCalledWith('artifact-1', 'task-1');
    expect(window.clawwork.showArtifactInFolder).toHaveBeenCalledWith('artifact-1', 'task-1');
    unmount();
  });

  it.each(['missing', 'unsafe'] as const)(
    'disables file actions and gives recovery guidance for %s',
    (availability) => {
      const { container, unmount } = render(<ArtifactCard artifact={{ ...artifact, availability }} />);

      expect(container.textContent).toContain(`artifactCard.${availability}`);
      expect(container.textContent).toContain('artifactCard.recoveryHint');
      expect(
        ['artifactCard.saveAs', 'artifactCard.open', 'artifactCard.showInFolder'].every(
          (label) => container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)?.disabled,
        ),
      ).toBe(true);
      unmount();
    },
  );

  it('renders real assistant artifacts inside the originating chat message', () => {
    const { container, unmount } = render(
      <ChatMessage
        message={{
          id: 'message-1',
          taskId: 'task-1',
          role: 'assistant',
          content: '文件已经生成。',
          artifacts: [artifact],
          toolCalls: [],
          timestamp: '2026-09-16T08:00:00.000Z',
        }}
        agentName="高效办公"
      />,
    );

    expect(container.querySelector('[data-testid="artifact-card"]')?.textContent).toContain('report.pdf');
    expect(container.querySelector('[aria-label="artifactCard.locateMessage"]')).toBeNull();
    unmount();
  });
});
