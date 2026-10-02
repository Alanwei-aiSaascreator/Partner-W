// @vitest-environment jsdom
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePreventFileDropNavigation } from '../src/renderer/hooks/usePreventFileDropNavigation';

/**
 * 窗口级"拖入文件不得导航"兜底（T05）。
 *
 * 为什么值得单测：这条守卫的失效形态是**整页被替换成 file:// 的那个文件**
 * （应用"没了"），而且只在真实的窗口级拖动里出现 —— 输入卡片自己的 onDrop
 * 挡不住拖到侧栏/消息区的情况。判据只有两个：带 Files 的拖动被 preventDefault；
 * 不带的不动（否则应用内原生拖动会被打死）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function GuardHost(): ReactElement | null {
  usePreventFileDropNavigation();
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function dispatchWindowDrag(type: 'dragover' | 'drop', types: string[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { types, files: [] } });
  window.dispatchEvent(event);
  return event;
}

describe('usePreventFileDropNavigation', () => {
  it('带文件的 dragover/drop → 一律 preventDefault（否则 Chromium 会导航到该文件）', () => {
    act(() => root.render(<GuardHost />));

    expect(dispatchWindowDrag('dragover', ['Files']).defaultPrevented).toBe(true);
    expect(dispatchWindowDrag('drop', ['Files']).defaultPrevented).toBe(true);
  });

  it('非文件拖动（文本/选区）→ 不拦（应用内原生拖动必须活着）', () => {
    act(() => root.render(<GuardHost />));

    expect(dispatchWindowDrag('dragover', ['text/plain']).defaultPrevented).toBe(false);
    expect(dispatchWindowDrag('drop', ['text/plain']).defaultPrevented).toBe(false);
  });

  it('卸载后监听器撤干净（再拖不再被拦）', () => {
    act(() => root.render(<GuardHost />));
    act(() => root.unmount());

    expect(dispatchWindowDrag('drop', ['Files']).defaultPrevented).toBe(false);
  });
});
