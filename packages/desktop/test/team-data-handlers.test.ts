import { beforeEach, describe, expect, it, vi } from 'vitest';

const handleMap = new Map<string, (...args: unknown[]) => unknown>();
const selectMock = vi.fn();
const getDbMock = vi.fn(() => ({ select: selectMock }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handleMap.set(channel, handler);
    }),
  },
}));

vi.mock('../src/main/workspace/config.js', () => ({
  getWorkspacePath: vi.fn(() => null),
}));

vi.mock('../src/main/artifact/auto-extract.js', () => ({
  autoExtractArtifacts: vi.fn(),
}));

vi.mock('../src/main/db/index.js', () => ({
  getDb: getDbMock,
  isDbReady: vi.fn(() => true),
}));

describe('团队数据 IPC', () => {
  beforeEach(() => {
    vi.resetModules();
    handleMap.clear();
    selectMock.mockReset();
    getDbMock.mockClear();
  });

  it('⭐ teams-list 必须把已保存的成员岗位带回 renderer，重启后不能丢', async () => {
    const teamRows = [
      {
        id: 'team-1',
        name: '增长设计团队',
        gatewayId: 'local',
        createdAt: '2026-09-29T00:00:00.000Z',
        updatedAt: '2026-09-29T00:00:00.000Z',
      },
    ];
    const agentRows = [
      {
        teamId: 'team-1',
        agentId: 'reviewer',
        role: 'worker',
        isManager: false,
        skillsJson: '[]',
        position: 'challenger',
      },
    ];

    selectMock
      .mockReturnValueOnce({
        from: () => ({ orderBy: () => ({ all: () => teamRows }) }),
      })
      .mockReturnValueOnce({
        from: () => ({ all: () => agentRows }),
      });

    const { registerDataHandlers } = await import('../src/main/ipc/data-handlers.js');
    registerDataHandlers();

    const listTeams = handleMap.get('data:teams-list');
    expect(listTeams).toBeTypeOf('function');
    expect(listTeams?.()).toMatchObject({
      ok: true,
      result: [
        {
          id: 'team-1',
          agents: [{ agentId: 'reviewer', position: 'challenger' }],
        },
      ],
    });
  });
});
