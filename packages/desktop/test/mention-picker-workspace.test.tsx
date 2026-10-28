// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const scope = vi.hoisted(() => ({ workspaceEpoch: 0 }));
vi.mock('../src/renderer/stores/taskStore', () => ({
  useTaskStore: Object.assign((select: (s: typeof scope) => unknown) => select(scope), { getState: () => scope }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('../src/renderer/components/AgentIcon', () => ({ default: () => null }));
import MentionPicker from '../src/renderer/components/MentionPicker';
import { useFileStore } from '../src/renderer/stores/fileStore';
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
const artifact = { id: 'old', name: 'old.txt', mimeType: 'text/plain', type: 'file', size: 1 };
const callbacks = {
  onSelectTask: vi.fn(),
  onSelectArtifact: vi.fn(),
  onSelectLocalFile: vi.fn(),
  onSelectAgent: vi.fn(),
  onTabChange: vi.fn(),
  onHoverIndex: vi.fn(),
};
async function render(visible = true) {
  await act(async () =>
    root!.render(
      <MentionPicker
        visible={visible}
        query=""
        tasks={[]}
        localFiles={[]}
        agents={[]}
        hasContextFolders={false}
        activeTab="files"
        selectedIndex={-1}
        {...callbacks}
      />,
    ),
  );
}
beforeEach(() => {
  scope.workspaceEpoch = 0;
  useFileStore.setState({ artifacts: [] });
  container = document.createElement('div');
  root = createRoot(container);
});
afterEach(() => act(() => root?.unmount()));
it('rejects an old list response before the next workspace render and reloads the reused picker', async () => {
  let finish!: (value: unknown) => void;
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ ok: true, result: [] });
  window.clawwork = { listArtifacts: list } as unknown as Window['clawwork'];
  await render();
  scope.workspaceEpoch++;
  await act(async () => finish({ ok: true, result: [artifact] }));
  expect(useFileStore.getState().artifacts).toEqual([]);
  await render();
  expect(list).toHaveBeenCalledTimes(2);
});
it('rejects a response after the picker unmounts', async () => {
  let finish!: (value: unknown) => void;
  window.clawwork = {
    listArtifacts: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  } as unknown as Window['clawwork'];
  await render();
  act(() => root!.unmount());
  root = undefined;
  await act(async () => finish({ ok: true, result: [artifact] }));
  expect(useFileStore.getState().artifacts).toEqual([]);
});
it('does not replace a live save with an older snapshot and accepts the authoritative refetch', async () => {
  let old!: (value: unknown) => void, fresh!: (value: unknown) => void;
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          old = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          fresh = resolve;
        }),
    );
  window.clawwork = { listArtifacts: list } as unknown as Window['clawwork'];
  await render();
  await act(async () => useFileStore.getState().upsertArtifact(artifact as never));
  await act(async () => old({ ok: true, result: [] }));
  expect(useFileStore.getState().artifacts).toEqual([artifact]);
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () => fresh({ ok: true, result: [] }));
  expect(useFileStore.getState().artifacts).toEqual([]);
});

it.each(['reply', 'throw'] as const)('shows current %s failure and retries only on user action', async (failure) => {
  const list = vi.fn();
  if (failure === 'reply') list.mockResolvedValueOnce({ ok: false, error: 'current-error' });
  else list.mockRejectedValueOnce(new Error('current-error'));
  list.mockResolvedValue({ ok: true, result: [] });
  window.clawwork = { listArtifacts: list } as unknown as Window['clawwork'];
  await render();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('errors.requestFailed');
  expect(container.textContent).not.toContain('mentionPicker.noFiles');
  expect(list).toHaveBeenCalledTimes(1);
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'common.retry');
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(list).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('mentionPicker.noFiles');
});
it('ignores a late error after the workspace owner changes', async () => {
  let fail!: (error: Error) => void;
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValue({ ok: true, result: [] });
  window.clawwork = { listArtifacts: list } as unknown as Window['clawwork'];
  await render();
  scope.workspaceEpoch++;
  await act(async () => fail(new Error('old-error')));
  await render();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(list).toHaveBeenCalledTimes(2);
});
/**
 * ⭐ BUG-120（2026-10-17）：视频改型成 `video` 之后，**提及选择器仍要认得它**。
 *
 * 选择器这一档不看类型做过滤（列的就是 `useFileStore.artifacts`），风险在于：
 * 一旦有人给这里补一层"只认某几类"的过滤，视频就会**从 @ 提及里消失**，
 * 而本文件其它用例（都是 `file`）全绿。图标也一并钉住：视频该是视频图标。
 */
it('⭐ BUG-120：type=video 的产物照旧出现在提及列表里，且用视频图标', async () => {
  window.clawwork = { listArtifacts: vi.fn() } as unknown as Window['clawwork'];
  await act(async () =>
    useFileStore.getState().setArtifacts([
      {
        id: 'v1',
        taskId: 'task-1',
        messageId: 'm1',
        name: '短片.mp4',
        mimeType: 'video/mp4',
        type: 'video',
        size: 5,
        filePath: '',
        localPath: '',
        createdAt: '2026-10-17T00:00:00.000Z',
        availability: 'available',
      } as never,
    ]),
  );

  await render();

  // ① 这一行**在**（没有被任何"类型白名单"过滤掉 —— 空列表时会显示 mentionPicker.noFiles）
  expect(container.textContent).not.toContain('mentionPicker.noFiles');
  // ② 类型标签是「视频」（改型前这一行显示的是 artifactKinds.file）
  expect(container.textContent).toContain('artifactKinds.video');
  // ③ 图标是视频图标（改型前落进通用 File 图标）
  expect(container.querySelector('svg.lucide-video')).not.toBeNull();
});

it('clears a former error when reopened with a new live saved artifact', async () => {
  const list = vi.fn().mockResolvedValue({ ok: false, error: 'failed' });
  window.clawwork = { listArtifacts: list } as unknown as Window['clawwork'];
  await render();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  await render(false);
  await act(async () => useFileStore.getState().upsertArtifact(artifact as never));
  await render();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(list).toHaveBeenCalledTimes(1);
});
