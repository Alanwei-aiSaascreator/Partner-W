import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⭐ 第二轮（R5 P1）：`emitTurnRegistration`（main 登记回执发射器）的 fail-closed 合同。
 *  - 无 runId / 无 taskId / sessionKey 空 ⇒ 拒发（回执按 session|run 归属，无归属不发）；
 *  - 无有效 workspace scope/revision（无库/无工作区）⇒ 拒发（与执行事件同款纪律）；
 *  - 有效身份 ⇒ 向每个窗口广播完整载荷（含捕获时 scope/revision 与 expectedKinds）。
 */
const getWorkspaceScope = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());
const getAllWindows = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows },
}));
vi.mock('../src/main/workspace/scope.js', () => ({ getWorkspaceScope }));

import { emitTurnRegistration, TURN_REGISTRATION_CHANNEL } from '../src/main/artifact/turn-registration';

beforeEach(() => {
  vi.clearAllMocks();
  getAllWindows.mockReturnValue([{ webContents: { send, isDestroyed: () => false } }]);
});

describe('emitTurnRegistration · 登记回执 fail-closed 合同', () => {
  it('无 runId / 无 taskId / sessionKey 空 ⇒ 拒发（零广播）', () => {
    getWorkspaceScope.mockReturnValue({ scope: 'ws-A', revision: 3 });
    expect(
      emitTurnRegistration({ taskId: 't-1', sessionKey: 'sk-1', runId: '  ', status: 'registered' }),
      '无 runId',
    ).toBe(false);
    expect(emitTurnRegistration({ taskId: '', sessionKey: 'sk-1', runId: 'r-1', status: 'registered' })).toBe(false);
    expect(emitTurnRegistration({ taskId: 't-1', sessionKey: '', runId: 'r-1', status: 'registered' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('无有效 workspace scope/revision ⇒ 拒发（不制造注定被接收侧丢掉的帧）', () => {
    getWorkspaceScope.mockReturnValue({ scope: null, revision: -1 });
    expect(emitTurnRegistration({ taskId: 't-1', sessionKey: 'sk-1', runId: 'r-1', status: 'registered' })).toBe(false);
    getWorkspaceScope.mockReturnValue({ scope: 'ws-A', revision: -1 });
    expect(emitTurnRegistration({ taskId: 't-1', sessionKey: 'sk-1', runId: 'r-1', status: 'registered' })).toBe(false);
    getWorkspaceScope.mockReturnValue({ scope: 'ws-A', revision: 1.5 });
    expect(emitTurnRegistration({ taskId: 't-1', sessionKey: 'sk-1', runId: 'r-1', status: 'registered' })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('有效身份 ⇒ 广播完整载荷（捕获时 scope/revision + expectedKinds 原样带走）', () => {
    getWorkspaceScope.mockReturnValue({ scope: 'ws-A', revision: 7 });
    expect(
      emitTurnRegistration({
        taskId: 't-1',
        sessionKey: 'sk-1',
        runId: 'r-1',
        status: 'needs-review',
        expectedKinds: ['pptx', 'docx'],
      }),
    ).toBe(true);
    expect(send).toHaveBeenCalledWith(TURN_REGISTRATION_CHANNEL, {
      taskId: 't-1',
      sessionKey: 'sk-1',
      runId: 'r-1',
      status: 'needs-review',
      expectedKinds: ['pptx', 'docx'],
      workspaceScope: 'ws-A',
      workspaceRevision: 7,
    });
  });
});
