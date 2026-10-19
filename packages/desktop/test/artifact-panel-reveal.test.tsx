// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Artifact } from '@clawwork/shared';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { useArtifactPanelReveal } from '../src/renderer/hooks/useArtifactPanelReveal';

/**
 * 用户反馈 #2（`USER-FEEDBACK-TRIAGE-20261006.md` 第 11 行）：
 * 「文档生成后提示右侧产物，但要**手动点右上角「切换上下文面板」**才看得到」。
 *
 * 验收：产物保存事件到达时，收起的面板**自动展开** —— 生成完成后无需手动切换。
 * 取舍（写死在用例里）：
 * - 只认**文件类产物**（`type === 'file'`）：回复里自动抽取的 `code` / `image`
 *   不该把面板弹出来抢正文宽度；
 * - 面板已经开着就什么都不做（幂等）。
 */

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let artifactSaved: ((artifact: Artifact) => void) | null = null;
const unsubscribe = vi.fn();
let container: HTMLDivElement;
let root: Root;
let mounted = false;

function artifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: 'artifact-1',
    taskId: 'task-1',
    messageId: 'message-1',
    type: 'file',
    name: '方案.pptx',
    filePath: 'C:/workspace/方案.pptx',
    localPath: 'C:/workspace/方案.pptx',
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    size: 1024,
    createdAt: '2026-10-06T00:00:00.000Z',
    availability: 'available',
    ...overrides,
  };
}

function Harness(): null {
  useArtifactPanelReveal();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  artifactSaved = null;
  mounted = true;
  useUiStore.setState({ rightPanelOpen: false });
  window.clawwork = {
    onArtifactSaved: (callback: (artifact: Artifact) => void) => {
      artifactSaved = callback;
      return unsubscribe;
    },
  } as unknown as typeof window.clawwork;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<Harness />));
});

afterEach(() => {
  if (mounted) {
    act(() => root.unmount());
    container.remove();
  }
});

it('文件产物保存 → 收起的面板自动展开（无需手动点「切换上下文面板」）', () => {
  expect(useUiStore.getState().rightPanelOpen).toBe(false);

  act(() => artifactSaved?.(artifact()));

  expect(useUiStore.getState().rightPanelOpen).toBe(true);
});

it('面板已经开着：不再重复置 state（幂等，不产生多余渲染）', () => {
  act(() => useUiStore.setState({ rightPanelOpen: true }));
  const seen: boolean[] = [];
  const stop = useUiStore.subscribe((state) => seen.push(state.rightPanelOpen));

  act(() => artifactSaved?.(artifact()));

  stop();
  expect(seen).toEqual([]);
});

it('非文件产物（回复里自动抽取的 code / image）不弹面板：聊天过程不被抢宽度', () => {
  act(() => artifactSaved?.(artifact({ type: 'code', name: 'snippet.ts' })));
  expect(useUiStore.getState().rightPanelOpen).toBe(false);

  act(() => artifactSaved?.(artifact({ type: 'image', name: 'shot.png' })));
  expect(useUiStore.getState().rightPanelOpen).toBe(false);
});

/**
 * ⭐ BUG-120（2026-10-17）：视频产物改型成 `video` 之后，这一档**必须一起放行**。
 *
 * 改型之前视频走的是 `type === 'file'`（与 docgen/htmlgen/PPT 同一档），所以面板揭示是
 * 白捡的；一旦给它专属类型而忘了这里，视频就会**静默失去**面板自动展开 ——
 * 用户看不到"生成完了"，而本文件的其它用例（都是 `file`）**全绿**，抓不到这个回归。
 */
it('⭐ BUG-120：视频产物（type=video）保存 → 面板同样自动展开', () => {
  act(() => artifactSaved?.(artifact({ type: 'video', name: '短片.mp4', mimeType: 'video/mp4' })));

  expect(useUiStore.getState().rightPanelOpen).toBe(true);
});

it('用户收起之后又来了新产物：仍然展开（新产物是新信号）', () => {
  act(() => artifactSaved?.(artifact()));
  expect(useUiStore.getState().rightPanelOpen).toBe(true);

  act(() => useUiStore.setState({ rightPanelOpen: false }));
  act(() => artifactSaved?.(artifact({ id: 'artifact-2', name: '方案第二版.pptx' })));

  expect(useUiStore.getState().rightPanelOpen).toBe(true);
});

it('卸载时退订（不留悬空监听）', () => {
  act(() => root.unmount());
  mounted = false;

  expect(unsubscribe).toHaveBeenCalledTimes(1);
});

it('App 挂了 useArtifactPanelReveal（渲染层唯一接线点）', () => {
  const app = readFileSync(join(__dirname, '../src/renderer/App.tsx'), 'utf8');

  expect(app).toContain('useArtifactPanelReveal()');
});
