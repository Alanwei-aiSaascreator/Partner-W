import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';

const { expose, invoke } = vi.hoisted(() => ({ expose: vi.fn(), invoke: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: expose }, ipcRenderer: { invoke } }));
afterEach(() => {
  vi.restoreAllMocks();
});

it('exposes typed meeting metadata endpoints and forwards their payloads', async () => {
  vi.stubGlobal('process', { ...process, contextIsolated: true });
  try {
    await import('../src/preload/index.js');
    const api = expose.mock.calls[0][1];
    expect(api.createTeamMeeting).toBeTypeOf('function');
    expect(api.saveTeamMeeting).toBeTypeOf('function');
    expect(api.listTeamMeetings).toBeTypeOf('function');
    const create = { record: { id: 'meeting' }, tasks: [] };
    const save = { record: { id: 'meeting' }, expectedRevision: 2 };
    await api.createTeamMeeting(create);
    await api.saveTeamMeeting(save);
    await api.listTeamMeetings();
    expect(invoke.mock.calls).toEqual([
      ['data:create-team-meeting', create],
      ['data:save-team-meeting', save],
      ['data:list-team-meetings'],
    ]);
    const main = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
    expect(main.match(/registerTeamMeetingHandlers\(\)/g)).toHaveLength(1);
  } finally {
    vi.unstubAllGlobals();
  }
});
