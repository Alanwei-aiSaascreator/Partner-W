import { beforeEach, describe, expect, it } from 'vitest';
import type { Artifact } from '@clawwork/shared';
import { useFileStore } from '../src/renderer/stores/fileStore';

const artifact: Artifact = {
  id: 'artifact-1',
  taskId: 'task-1',
  messageId: 'message-1',
  type: 'file',
  name: 'report.docx',
  filePath: 'C:/workspace/task-1/report.docx',
  localPath: 'task-1/report.docx',
  mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  size: 12,
  createdAt: '2026-09-29T00:00:00.000Z',
  availability: 'available',
  contentText: 'existing preview',
  root: 'agent',
};

describe('artifact metadata updates', () => {
  beforeEach(() => useFileStore.setState({ artifacts: [], selectedArtifactId: null }));

  it('updates one same-id row without losing preview metadata, selection, or order', () => {
    useFileStore.setState({
      artifacts: [artifact, { ...artifact, id: 'artifact-2' }],
      selectedArtifactId: artifact.id,
    });
    useFileStore
      .getState()
      .upsertArtifact({ ...artifact, size: 42, availability: 'missing', contentText: undefined, root: undefined });
    const state = useFileStore.getState();
    expect(state.artifacts).toHaveLength(2);
    expect(state.artifacts[0]).toMatchObject({
      id: artifact.id,
      size: 42,
      availability: 'missing',
      contentText: 'existing preview',
      root: 'agent',
    });
    expect(state.selectedArtifactId).toBe(artifact.id);
  });

  it('adds new rows once and treats identical delivery events as no-ops', () => {
    useFileStore.getState().upsertArtifact(artifact);
    const before = useFileStore.getState();
    useFileStore.getState().upsertArtifact({ ...artifact });
    expect(useFileStore.getState()).toBe(before);
    expect(before.artifacts).toEqual([artifact]);
  });
});
