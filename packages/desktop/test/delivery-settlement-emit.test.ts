/**
 * r7-1 / F4：交付结算事件出口（`sendArtifactDeliverySettled`）的纪律 ——
 * **`succeeded` 先落最小成功标记，再广播；其它终态一律不落**；标记写不进去
 * 绝不能挡住结算事件本身（渲染层的去重边界与用户可见的结算/告警是两件事）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ `vi.mock` 工厂会被提升到 import 之前 ⇒ 工厂里只能碰 `vi.hoisted` 的东西。
const mocks = vi.hoisted(() => {
  const run = vi.fn();
  const where = vi.fn(() => ({ run }));
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  return { run, where, set, update, isDbReady: vi.fn(() => true) };
});

vi.mock('../src/main/db/index.js', () => ({
  getDb: vi.fn(() => ({ update: mocks.update })),
  isDbReady: mocks.isDbReady,
}));

import { markMessageDeliverySucceeded, sendArtifactDeliverySettled } from '../src/main/artifact/delivery-settlement.js';
import { messages } from '../src/main/db/schema.js';

type SettledWindow = Parameters<typeof sendArtifactDeliverySettled>[0];

function fakeWindow(): { win: SettledWindow; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return { win: { webContents: { send } } as unknown as SettledWindow, send };
}

const succeeded = {
  taskId: 'task-1',
  sessionKey: 'session-1',
  messageId: 'msg-1',
  status: 'succeeded',
} as const;

describe('r7-1 交付结算出口', () => {
  beforeEach(() => {
    mocks.run.mockReset();
    mocks.where.mockClear();
    mocks.set.mockClear();
    mocks.update.mockClear();
    mocks.isDbReady.mockReturnValue(true);
  });

  it('succeeded：写 messages.delivery_succeeded 后照常广播', () => {
    const { win, send } = fakeWindow();

    sendArtifactDeliverySettled(win, succeeded);

    expect(mocks.update).toHaveBeenCalledWith(messages);
    expect(mocks.set).toHaveBeenCalledWith({ deliverySucceeded: true });
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('artifact:delivery-settled', succeeded);
  });

  it('failed / needs-review / canceled：一律不落标记（needs-review 是"未确认"，不是成功）', () => {
    const { win, send } = fakeWindow();

    for (const status of ['failed', 'needs-review', 'canceled'] as const) {
      sendArtifactDeliverySettled(win, { ...succeeded, status });
    }

    expect(mocks.update).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('库未就绪 / 写失败：只记日志，结算事件照常广播', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { win, send } = fakeWindow();

    mocks.isDbReady.mockReturnValue(false);
    expect(markMessageDeliverySucceeded('task-1', 'msg-1')).toBe(false);
    sendArtifactDeliverySettled(win, succeeded);
    expect(mocks.update).not.toHaveBeenCalled();

    mocks.isDbReady.mockReturnValue(true);
    mocks.run.mockImplementation(() => {
      throw new Error('database is locked');
    });
    sendArtifactDeliverySettled(win, succeeded);

    expect(warn).toHaveBeenCalledWith('[artifact] delivery success marker unavailable:', expect.any(Error));
    expect(send).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
