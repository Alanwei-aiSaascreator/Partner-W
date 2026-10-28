import { expect, it, vi } from 'vitest';
const mock = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn(), on: vi.fn(), remove: vi.fn() }));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mock.expose },
  ipcRenderer: { invoke: mock.invoke, on: mock.on, removeListener: mock.remove },
}));
it('forwards scoped activity and scope snapshots and removes only its own listeners', async () => {
  vi.stubGlobal('process', { ...process, contextIsolated: true });
  try {
    await import('../src/preload/index.js');
    const api = mock.expose.mock.calls[0][1],
      callback = vi.fn();
    const stopScope = api.onArtifactWorkspaceScopeChanged(callback);
    await api.getArtifactWorkspaceScope();
    await api.getArtifactDeliveryActivitySnapshot();
    const stopActivity = api.onArtifactDeliveryActivity(callback);
    expect(mock.invoke).toHaveBeenCalledWith('artifact:get-workspace-scope');
    expect(mock.invoke).toHaveBeenCalledWith('artifact:get-delivery-activity-snapshot');
    expect(mock.on.mock.calls.map((call) => call[0])).toEqual([
      'artifact:workspace-scope-changed',
      'artifact:delivery-activity',
    ]);
    const event = {
      taskId: 'task',
      messageId: 'message',
      operationId: 'operation',
      workspaceScope: 'scope',
      sequence: 1,
    };
    mock.on.mock.calls[1][1]({}, event);
    expect(callback).toHaveBeenCalledWith(event);
    stopScope();
    stopActivity();
    expect(mock.remove.mock.calls).toEqual(mock.on.mock.calls);
  } finally {
    vi.unstubAllGlobals();
  }
});
