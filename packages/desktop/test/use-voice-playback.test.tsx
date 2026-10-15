// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoicePlayback } from '../src/renderer/hooks/useVoicePlayback';
const start = vi.fn();
const stop = vi.fn();
const close = vi.fn(async () => {});
let node: {
  onended: (() => void) | null;
  start: typeof start;
  stop: typeof stop;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  buffer: unknown;
};
function Harness({ scope = 'a' }: { scope?: string }) {
  const voice = useVoicePlayback(scope);
  return (
    <>
      <button onClick={() => void voice.start('中文回答')}>read</button>
      <button onClick={voice.stop}>stop</button>
      <span>{voice.phase}</span>
    </>
  );
}
function mount(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    rerender: (ui: ReactElement) => act(() => root.render(ui)),
    unmount: () => act(() => root.unmount()),
  };
}
async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}
describe('speech UI lifetime', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    node = { onended: null, start, stop, disconnect: vi.fn(), connect: vi.fn(), buffer: null };
    class Context {
      destination = {};
      resume = vi.fn(async () => {});
      close = close;
      decodeAudioData = vi.fn(async () => ({}));
      createBufferSource() {
        return node;
      }
    }
    vi.stubGlobal('AudioContext', Context);
    Object.defineProperty(window, 'clawwork', {
      configurable: true,
      value: {
        synthesizeSpeech: vi.fn(async () => ({ ok: true, result: new ArrayBuffer(44) })),
        cancelVoice: vi.fn(async () => ({ ok: true })),
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    document.body.innerHTML = '';
  });
  it('guards rapid repeated clicks against a second paid request', async () => {
    const view = mount(<Harness />);
    act(() => {
      view.container.querySelector('button')!.click();
      view.container.querySelector('button')!.click();
    });
    await flush();
    expect(window.clawwork.synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    act(() => node.onended?.());
    await flush();
    expect(view.container.querySelector('span')?.textContent).toBe('idle');
    view.unmount();
  });
  it('drops synthesis delivered after switching task/account scope', async () => {
    let resolve: ((result: { ok: true; result: ArrayBuffer }) => void) | undefined;
    vi.mocked(window.clawwork.synthesizeSpeech).mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const view = mount(<Harness />);
    act(() => view.container.querySelector('button')!.click());
    await flush();
    view.rerender(<Harness scope="b" />);
    await act(async () => {
      resolve?.({ ok: true, result: new ArrayBuffer(44) });
    });
    expect(start).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    view.unmount();
  });
  it('stops audible audio and releases its context immediately', async () => {
    const view = mount(<Harness />);
    act(() => view.container.querySelector('button')!.click());
    await flush();
    expect(view.container.querySelector('span')?.textContent).toBe('playing');
    act(() => view.container.querySelectorAll('button')[1].click());
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('span')?.textContent).toBe('idle');
    view.unmount();
  });
});
