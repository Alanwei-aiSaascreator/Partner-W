// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVoicePlayback } from '../src/renderer/hooks/useVoicePlayback';
const start = vi.fn();
const stop = vi.fn();
const close = vi.fn(async () => {});
/** B 侧 parseVoiceInput 与 D main/ipc 校验共用的 UUIDv4 形状（R8-05 身份透传契约）。 */
const VOICE_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const baseIdentity = { accountKey: 'user-1', taskId: 'task-1', sessionKey: 'session-1' };
let node: {
  onended: (() => void) | null;
  start: typeof start;
  stop: typeof stop;
  disconnect: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  buffer: unknown;
};
function Harness({
  scope = 'a',
  identity = baseIdentity,
  text = '中文回答',
}: {
  scope?: string;
  identity?: typeof baseIdentity;
  text?: string;
}) {
  const voice = useVoicePlayback(scope, identity);
  return (
    <>
      <button onClick={() => void voice.start(text)}>read</button>
      <button onClick={voice.stop}>stop</button>
      <span>{voice.phase}</span>
      <em data-testid="error">{voice.error ?? ''}</em>
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
    // 身份派生走 crypto.subtle（真异步），多给一个宏任务让 speak/恢复链跑完。
    await new Promise((resolve) => setTimeout(resolve, 10));
    await Promise.resolve();
    await Promise.resolve();
  });
}
function readButton(view: { container: HTMLElement }) {
  return view.container.querySelector('button')!;
}
describe('speech UI lifetime', () => {
  beforeEach(() => {
    window.localStorage.clear();
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
        synthesizeSpeech: vi.fn(async (_text: string, _requestId: string) => ({
          ok: true,
          result: new ArrayBuffer(44),
        })),
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
      readButton(view).click();
      readButton(view).click();
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
    act(() => readButton(view).click());
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
    act(() => readButton(view).click());
    await flush();
    expect(view.container.querySelector('span')?.textContent).toBe('playing');
    act(() => view.container.querySelectorAll('button')[1].click());
    await flush();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('span')?.textContent).toBe('idle');
    view.unmount();
  });
  it('失败重试沿用同一 requestId，且失败保留明确可重试状态而不是静默 idle', async () => {
    const synthesize = vi.mocked(window.clawwork.synthesizeSpeech);
    synthesize
      .mockImplementationOnce(async () => ({ ok: false, error: 'voice-settlement-pending' }))
      .mockImplementation(async () => ({ ok: true, result: new ArrayBuffer(44) }));
    const view = mount(<Harness />);
    act(() => readButton(view).click());
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(1);
    // 结果未知（结算 pending）后不得回 idle —— 保留可重试的错误状态
    expect(view.container.querySelector('span')?.textContent).toBe('failed');
    expect(view.container.querySelector('[data-testid="error"]')?.textContent).toBe('voice-settlement-pending');
    act(() => readButton(view).click());
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(2);
    const firstId = synthesize.mock.calls[0]?.[1];
    const secondId = synthesize.mock.calls[1]?.[1];
    expect(firstId).toMatch(VOICE_REQUEST_ID);
    expect(secondId).toBe(firstId);
    act(() => node.onended?.());
    await flush();
    expect(view.container.querySelector('span')?.textContent).toBe('idle');
    view.unmount();
  });
  it('换账号后朗读同一回答产生不同 requestId（旧账号结果不得复用）', async () => {
    const synthesize = vi.mocked(window.clawwork.synthesizeSpeech);
    synthesize.mockImplementation(async () => ({ ok: false, error: 'voice-settlement-pending' }));
    const view = mount(<Harness />);
    act(() => readButton(view).click());
    await flush();
    const firstId = synthesize.mock.calls[0]?.[1];
    expect(firstId).toMatch(VOICE_REQUEST_ID);
    view.rerender(<Harness scope="b" identity={{ ...baseIdentity, accountKey: 'user-2' }} />);
    act(() => readButton(view).click());
    await flush();
    const secondId = synthesize.mock.calls[1]?.[1];
    expect(secondId).toMatch(VOICE_REQUEST_ID);
    expect(secondId).not.toBe(firstId);
    view.unmount();
  });
  it('同一账号换消息内容（文本修订）产生不同 requestId', async () => {
    const synthesize = vi.mocked(window.clawwork.synthesizeSpeech);
    synthesize.mockImplementation(async () => ({ ok: false, error: 'voice-settlement-pending' }));
    const view = mount(<Harness />);
    act(() => readButton(view).click());
    await flush();
    const firstId = synthesize.mock.calls[0]?.[1];
    view.rerender(<Harness text="另一条回答" />);
    act(() => readButton(view).click());
    await flush();
    expect(synthesize.mock.calls[1]?.[1]).not.toBe(firstId);
    view.unmount();
  });
  it('完整播完后再点朗读 = 明确的新合成 ⇒ 新 requestId（旧身份只服务失败恢复）', async () => {
    const synthesize = vi.mocked(window.clawwork.synthesizeSpeech);
    const view = mount(<Harness />);
    act(() => readButton(view).click());
    await flush();
    act(() => node.onended?.());
    await flush();
    expect(view.container.querySelector('span')?.textContent).toBe('idle');
    act(() => readButton(view).click());
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize.mock.calls[0]?.[1]).toMatch(VOICE_REQUEST_ID);
    expect(synthesize.mock.calls[1]?.[1]).not.toBe(synthesize.mock.calls[0]?.[1]);
    view.unmount();
  });
  it('长回答逐分句持有身份：第二句失败重试后逐句沿用同一身份，分句之间身份不同', async () => {
    const synthesize = vi.mocked(window.clawwork.synthesizeSpeech);
    let speakCalls = 0;
    synthesize.mockImplementation(async () => {
      speakCalls += 1;
      // 第一次播放：第一句成功、第二句结算 pending（结果未知）；重试：两句都成功
      if (speakCalls === 2) return { ok: false, error: 'voice-settlement-pending' };
      return { ok: true, result: new ArrayBuffer(44) };
    });
    const long = `${'甲'.repeat(400)}。${'乙'.repeat(400)}`;
    const view = mount(<Harness text={long} />);
    act(() => readButton(view).click());
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(1);
    act(() => node.onended?.());
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('span')?.textContent).toBe('failed');
    act(() => readButton(view).click());
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(3);
    act(() => node.onended?.());
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(4);
    const ids = synthesize.mock.calls.map((call) => call[1]);
    expect(ids[2]).toBe(ids[0]);
    expect(ids[3]).toBe(ids[1]);
    expect(ids[0]).not.toBe(ids[1]);
    act(() => node.onended?.());
    await flush();
    expect(view.container.querySelector('span')?.textContent).toBe('idle');
    view.unmount();
  });
  it('recovers the latest failed operation after remount instead of reverting to the first playback', async () => {
    const synthesize = vi.mocked(window.clawwork.synthesizeSpeech);
    const first = mount(<Harness />);
    act(() => readButton(first).click());
    await flush();
    act(() => node.onended?.());
    await flush();
    synthesize.mockImplementation(async () => ({ ok: false, error: 'voice-settlement-pending' }));
    act(() => readButton(first).click());
    await flush();
    const pendingId = synthesize.mock.calls[1]?.[1];
    expect(pendingId).not.toBe(synthesize.mock.calls[0]?.[1]);
    first.unmount();
    const reopened = mount(<Harness />);
    act(() => readButton(reopened).click());
    await flush();
    expect(synthesize.mock.calls[2]?.[1]).toBe(pendingId);
    reopened.unmount();
  });

  it('fails before any request when persistent recovery state cannot be written', async () => {
    const failure = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('disk full');
    });
    const view = mount(<Harness />);
    act(() => readButton(view).click());
    await flush();
    expect(window.clawwork.synthesizeSpeech).not.toHaveBeenCalled();
    expect(view.container.querySelector('[data-testid="error"]')?.textContent).toBe('voice-recovery-unavailable');
    view.unmount();
    failure.mockRestore();
  });
  it('does not dispatch an old account request when scope changes during sentence hashing', async () => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let finish: (() => void) | undefined;
    let calls = 0;
    const spy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      calls++;
      if (calls === 3)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return digest(...args);
    });
    const view = mount(<Harness />);
    act(() => readButton(view).click());
    await flush();
    expect(finish).toBeDefined();
    view.rerender(<Harness scope="account-b" identity={{ ...baseIdentity, accountKey: 'user-2' }} />);
    finish?.();
    await flush();
    expect(window.clawwork.synthesizeSpeech).not.toHaveBeenCalled();
    view.unmount();
    spy.mockRestore();
  });
});
