// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';
import FilePreview from '../src/renderer/components/FilePreview';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

const readArtifactFile = vi.fn();
let root: Root;
let container: HTMLDivElement;
const artifact: Artifact = {
  id: 'video-1',
  taskId: 'task-1',
  messageId: 'msg-1',
  name: 'clip.mp4',
  type: 'file',
  availability: 'available',
  filePath: '/untrusted/clip.mp4',
  localPath: 'task-1/clip.mp4',
  mimeType: 'video/mp4',
  size: 128,
  createdAt: '2026-09-30T00:00:00Z',
};

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  readArtifactFile.mockReset().mockResolvedValue({ ok: true, result: { content: 'dmlkZW8=', encoding: 'base64' } });
  Object.assign(window, {
    clawwork: {
      previewArtifact: vi.fn().mockResolvedValue({ ok: true, result: { kind: 'unsupported' } }),
      readArtifactFile,
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('validated video artifact preview', () => {
  it.each(['mp4', 'webm'])('renders %s from validated base64 with controls and no autoplay', async (extension) => {
    await act(async () =>
      root.render(
        <FilePreview artifact={{ ...artifact, mimeType: `video/${extension}` }} onNavigateToTask={() => {}} />,
      ),
    );
    const video = container.querySelector('video');
    expect(video).not.toBeNull();
    expect(video?.src).toBe(`data:video/${extension};base64,dmlkZW8=`);
    expect(video?.controls).toBe(true);
    expect(video?.autoplay).toBe(false);
    expect(readArtifactFile).toHaveBeenCalledWith('video-1', 'task-1');
  });

  it.each([
    { ok: false, error: 'artifact unsafe' },
    { ok: true, result: { tooLarge: true, size: 30 * 1024 * 1024 } },
  ])('does not create a player for unavailable or oversized bytes', async (result) => {
    readArtifactFile.mockResolvedValue(result);
    await act(async () => root.render(<FilePreview artifact={artifact} onNavigateToTask={() => {}} />));
    expect(container.querySelector('video')).toBeNull();
    expect(container.textContent).toContain(result.ok ? 'filePreview.tooLargeToRead' : 'artifact unsafe');
  });
});
