// @vitest-environment jsdom

/**
 * BUG-026（2026-10-06 B 组）：**同一 task 下同一失败 → 聊天里只留一条便签**。
 *
 * 真机形状：同一份文件交付失败在多轮里被重复判定（每轮 messageId 不同），
 * claim-guard 每次都往聊天里追加一条内容完全相同的红色系统便签 ——
 * 用户看到的是"一失败一气泡"的连环报错。便签内容相同时只留第一条：
 * 事实没丢（第一条还在、模型上下文照旧拿得到），但不再刷屏；
 * 原始载荷继续走 console.debug（排查不受影响）。
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageStore } from '@clawwork/core';
import type { ArtifactDeliveryFailure, Message } from '@clawwork/shared';

const mocks = vi.hoisted(() => ({ getState: vi.fn(), toast: vi.fn(), debug: vi.fn() }));
vi.mock('../src/renderer/stores/messageStore', () => ({ useMessageStore: { getState: mocks.getState } }));
vi.mock('../src/renderer/lib/toast', () => ({ toast: { error: mocks.toast } }));
vi.mock('react-i18next', () => ({
  // 把插值带上：便签内容里的文件名是"同一失败/不同失败"的判据（真实运行时就靠它）。
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join(':')}` : key),
  }),
}));

import { useClaimGuardToast } from '../src/renderer/hooks/useClaimGuardToast';
import { useArtifactDeliveryStore } from '../src/renderer/stores/artifactDeliveryStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function mountHook() {
  let callback: ((event: ArtifactDeliveryFailure) => void) | undefined;
  const store = createMessageStore({ persistMessage: vi.fn(async () => ({ ok: true })) });
  store.getState().bulkLoad('task-1', [] as Message[]);
  mocks.getState.mockImplementation(store.getState);
  useArtifactDeliveryStore.setState({ settled: [] });
  Object.defineProperty(window, 'clawwork', {
    configurable: true,
    value: {
      onClaimViolation: (cb: typeof callback) => {
        callback = cb;
        return () => {};
      },
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Harness() {
    useClaimGuardToast();
    return null;
  }
  act(() => root.render(<Harness />));
  const unmount = () =>
    act(() => {
      root.unmount();
      container.remove();
    });
  cleanups.push(unmount);
  return {
    store,
    unmount,
    emit: (event: ArtifactDeliveryFailure) => act(() => callback!(event)),
    notes: () => store.getState().messagesByTask['task-1'].filter((message) => message.role === 'system'),
  };
}

const violation: ArtifactDeliveryFailure = {
  taskId: 'task-1',
  sessionKey: 'session-1',
  messageId: 'assistant-1',
  missing: ['report.pptx'],
};

describe('BUG-026 claim-guard 便签聚合', () => {
  it('同一失败在后续轮次重复判定（messageId 不同）⇒ 聊天里只有一条便签', () => {
    const mounted = mountHook();

    mounted.emit(violation);
    mounted.emit({ ...violation, messageId: 'assistant-2' });
    mounted.emit({ ...violation, messageId: 'assistant-3' });

    expect(mounted.notes()).toHaveLength(1);
    expect(mounted.notes()[0].content).toContain('claimGuard.missingBody:report.pptx');
  });

  it('不同的失败（文件不同）照常各出一条 —— 聚合只吃"同一失败"', () => {
    const mounted = mountHook();

    mounted.emit(violation);
    mounted.emit({ ...violation, messageId: 'assistant-2', missing: ['另一个报告.pptx'] });

    expect(mounted.notes()).toHaveLength(2);
  });

  it('被聚合掉的重复事件仍完整进 console.debug（开发日志保留全部）', () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const mounted = mountHook();

    mounted.emit(violation);
    mounted.emit({ ...violation, messageId: 'assistant-2' });

    const rawPayloads = debugSpy.mock.calls.filter(([label]) => label === '[claim-guard] raw failure payload');
    expect(rawPayloads).toHaveLength(2);
    expect(rawPayloads[1][1]).toMatchObject({ messageId: 'assistant-2', missing: ['report.pptx'] });
  });

  /**
   * ⭐ BUG-042-c（2026-10-08 亲验的 C1 静默丢弃）：回复说做好了、文件在盘上、
   * 字节却不是那份格式（JSON 改名成 .docx 之类）—— 从前**一声不吭**。
   * 现在走既有 claim 通道如实说一句："写出的文件不是有效文档"。
   */
  it('⭐ 写出的不是有效文档（invalidArtifacts）⇒ 有一条如实便签，不是静默', () => {
    mocks.toast.mockClear();
    const mounted = mountHook();

    mounted.emit({ ...violation, missing: [], invalidArtifacts: ['季度报告.docx'] });

    expect(mounted.notes()).toHaveLength(1);
    expect(mounted.notes()[0].content).toContain('claimGuard.invalidArtifactBody:季度报告.docx');
    expect(mocks.toast).toHaveBeenCalledWith('claimGuard.invalidArtifactTitle', expect.anything());
  });
});
