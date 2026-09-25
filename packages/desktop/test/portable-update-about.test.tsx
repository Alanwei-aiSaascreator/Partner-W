// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PortableUpdatePublicState } from '@clawwork/shared';

const claw = vi.hoisted(() => {
  const unsubscribe = (): void => {};
  return {
    listeners: [] as ((state: PortableUpdatePublicState) => void)[],
    getUpdateState: vi.fn(async (): Promise<PortableUpdatePublicState | null> => null),
    installUpdate: vi.fn(async () => ({ ok: true })),
    downloadUpdate: vi.fn(async () => ({ ok: true })),
    checkForUpdates: vi.fn(async () => ({
      currentVersion: '0.0.25',
      latestVersion: '0.0.26',
      hasUpdate: true,
      releaseUrl: '',
      releaseNotes: null,
      state: 'available' as const,
      portable: true,
    })),
    unsubscribe,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // ⚠️ `message` 也要能看见：`settings.updateError` 的人话在 `message` 里，
    //    桩把它抹掉，这条链就只能断言"渲染了 key"，断言不到"用户看到什么"（2026-09-23）。
    t: (key: string, params?: Record<string, unknown>) =>
      params?.version !== undefined
        ? `${key}:${String(params.version)}`
        : params?.message !== undefined
          ? `${key}:${String(params.message)}`
          : // 百分比也要看得见：否则"进度来自哪个源"这条断言只能写成 toContain('42')，
            // 而那会被别的数字蒙混过去（本仓栽过：'36' 满足 toContain('3')）。
            params?.percent !== undefined
            ? `${key}:${String(params.percent)}`
            : key,
  }),
  // ⚠️ 这个桩不能省：import 链会走到真实的 i18n 初始化，它要 `i18n.use(initReactI18next)`。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('@/lib/toast', () => ({ toast: vi.fn() }));

import AboutSection from '../src/renderer/layouts/Settings/sections/AboutSection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function portableState(phase: PortableUpdatePublicState['phase']): PortableUpdatePublicState {
  return { phase, currentVersion: '0.0.25', targetVersion: '0.0.26', updatedAt: 1 };
}

function installClawMock(): void {
  (window as unknown as { clawwork: Record<string, unknown> }).clawwork = {
    getAppVersion: vi.fn(async () => '0.0.25'),
    getDeviceId: vi.fn(async () => 'device-1'),
    checkForUpdates: claw.checkForUpdates,
    downloadUpdate: claw.downloadUpdate,
    installUpdate: claw.installUpdate,
    cancelUpdateDownload: vi.fn(async () => ({ ok: true })),
    onUpdateDownloadProgress: () => claw.unsubscribe,
    onUpdateDownloaded: () => claw.unsubscribe,
    onUpdateError: () => claw.unsubscribe,
    getUpdateState: claw.getUpdateState,
    onUpdateStateChanged: (listener: (state: PortableUpdatePublicState) => void) => {
      claw.listeners.push(listener);
      return claw.unsubscribe;
    },
    openExternal: vi.fn(async () => ({ ok: true })),
    getLogPath: vi.fn(async () => ''),
    exportDebugBundle: vi.fn(async () => ({ ok: true })),
    commercialGetConfig: vi.fn(async () => ({ ok: false })),
    commercialLocalSession: vi.fn(async () => ({ ok: false })),
    commercialSession: vi.fn(async () => ({ ok: false })),
    commercialAccountOverview: vi.fn(async () => ({ ok: false })),
    setUpdateChannel: vi.fn(async () => ({ ok: true })),
    getSettings: vi.fn(async () => ({ ok: true, result: {} })),
  };
}

describe('设置 → 关于：盘上运行的更新状态', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    claw.listeners.length = 0;
    claw.getUpdateState.mockResolvedValue(null);
    claw.installUpdate.mockClear();
    installClawMock();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function renderWithState(state: PortableUpdatePublicState): Promise<void> {
    claw.getUpdateState.mockResolvedValue(state);
    await act(async () => {
      root.render(<AboutSection />);
    });
  }

  async function renderWith(phase: PortableUpdatePublicState['phase']): Promise<void> {
    await renderWithState(portableState(phase));
  }

  it('⭐ 空间不足要说得出「还差多少」——数字来自公开状态，缺席的 errorMessage 不许赢', async () => {
    await renderWithState({
      phase: 'error',
      currentVersion: '0.0.25',
      targetVersion: '0.0.26',
      errorCode: 'disk-space',
      requiredBytes: 5 * 1024 ** 3,
      availableBytes: 1024 ** 3,
      updatedAt: 1,
    });

    expect(container.textContent).toContain('settings.updateError');
    expect(container.textContent).toContain('还差 4.0 GiB');
  });

  it('⭐ 只有 ready 才出现「立即重启更新」', async () => {
    await renderWith('ready');

    expect(container.textContent).toContain('settings.portableUpdate.restartNow');
    expect(container.textContent).toContain('settings.portableUpdate.later');
    expect(container.textContent).toContain('settings.portableUpdate.ready:0.0.26');
  });

  it('⭐ available 不许出现「立即重启更新」——那是"还能继续用"，不是"已准备好"', async () => {
    await renderWith('available');

    expect(container.textContent).not.toContain('settings.portableUpdate.restartNow');
    expect(container.textContent).not.toContain('settings.portableUpdate.ready');
  });

  it.each([
    ['extracting', 'settings.portableUpdate.preparing'],
    ['applying', 'settings.portableUpdate.applying'],
    ['rolled-back', 'settings.portableUpdate.rolledBack'],
  ] as const)('%s 显示自己的文案，且不给重启按钮', async (phase, copy) => {
    await renderWith(phase);

    expect(container.textContent).toContain(copy);
    expect(container.textContent).not.toContain('settings.portableUpdate.restartNow');
  });

  it('准备中的三个相位都说"你可以继续使用"，而不是催重启', async () => {
    for (const phase of ['verifying-archive', 'extracting', 'verifying-files'] as const) {
      await renderWith(phase);
      expect(container.textContent).toContain('settings.portableUpdate.preparing');
      expect(container.textContent).not.toContain('settings.portableUpdate.restartNow');
    }
  });

  it('点「立即重启更新」走的是 installUpdate', async () => {
    await renderWith('ready');
    const button = [...container.querySelectorAll('button')].find((candidate) =>
      candidate.textContent?.includes('settings.portableUpdate.restartNow'),
    );
    expect(button, '找不到重启按钮').toBeDefined();

    await act(async () => {
      button?.click();
    });

    expect(claw.installUpdate).toHaveBeenCalledTimes(1);
  });

  it('主进程后来报 ready 时，界面跟着出现重启按钮', async () => {
    await renderWith('extracting');
    expect(container.textContent).not.toContain('settings.portableUpdate.restartNow');

    await act(async () => {
      for (const listener of claw.listeners) listener(portableState('ready'));
    });

    expect(container.textContent).toContain('settings.portableUpdate.restartNow');
  });

  // ───────────────────────── C0：盘上运行的更新入口 ─────────────────────────
  //
  // 为什么单列一组：以前盘上形态在「有新版本」那张卡片上**只有一个句子、没有按钮**
  // （"用新的文件夹替换盘上那份即可"）—— 那句话在便携更新服务做好之后**就过时了**，
  // 用户于是没有可达的入口。这一组钉住"入口可达、能取消、失败绝不安装"。

  function buttonByText(text: string): HTMLButtonElement | undefined {
    return [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));
  }

  it('① portable 有可用更新时，用户看得到入口（不只是那句指引）', async () => {
    await renderWith('available');

    expect(buttonByText('settings.portableUpdate.downloadAndPrepare'), '找不到便携更新入口').toBeDefined();
  });

  it('② 点入口只调 downloadUpdate —— 这时绝不调 installUpdate', async () => {
    await renderWith('available');
    claw.downloadUpdate.mockClear();

    await act(async () => {
      buttonByText('settings.portableUpdate.downloadAndPrepare')?.click();
    });

    expect(claw.downloadUpdate).toHaveBeenCalledTimes(1);
    expect(claw.installUpdate).not.toHaveBeenCalled();
  });

  it('③ 顺序：点完之后是**准备中**（没有重启钮），ready 到了才有', async () => {
    await renderWith('available');

    await act(async () => {
      buttonByText('settings.portableUpdate.downloadAndPrepare')?.click();
    });
    await act(async () => {
      for (const listener of claw.listeners) listener(portableState('downloading'));
    });

    expect(container.textContent).not.toContain('settings.portableUpdate.restartNow');

    await act(async () => {
      for (const listener of claw.listeners) listener(portableState('ready'));
    });

    expect(container.textContent).toContain('settings.portableUpdate.restartNow');
  });

  it('④ 失败绝不安装：错误相位下没有重启钮，installUpdate 一次都没调', async () => {
    await renderWithState({
      phase: 'error',
      currentVersion: '0.0.25',
      targetVersion: '0.0.26',
      errorCode: 'file-integrity',
      updatedAt: 1,
    });

    expect(container.textContent).not.toContain('settings.portableUpdate.restartNow');
    expect(claw.installUpdate).not.toHaveBeenCalled();
    // 出错之后入口要还在（否则用户没有第二次机会）
    expect(buttonByText('settings.portableUpdate.downloadAndPrepare')).toBeDefined();
  });

  it('⑤ portable 的下载百分比来自便携公开状态（不是装机版那条进度事件）', async () => {
    await renderWith('available');
    claw.downloadUpdate.mockClear();

    await act(async () => {
      buttonByText('settings.portableUpdate.downloadAndPrepare')?.click();
    });
    await act(async () => {
      for (const listener of claw.listeners) listener({ ...portableState('downloading'), percent: 42 });
    });

    // 判据是**精确串**：`toContain('42')` 会被别的数字蒙混过去
    expect(container.textContent).toContain('settings.downloadProgress:42');
    // 下载相位用的取消键与装机版**同一个**（`settings.cancelDownload`）——
    // 两条链在"下载中"这个画面上本来就该长一样
    expect(container.textContent).toContain('settings.cancelDownload');
    expect(buttonByText('settings.cancelDownload'), '下载中必须能取消').toBeDefined();
  });

  it('⑥ 对照：装机版（portable=false）不出现便携入口，仍是「下载更新」', async () => {
    claw.checkForUpdates.mockResolvedValueOnce({
      currentVersion: '0.0.25',
      latestVersion: '0.0.26',
      hasUpdate: true,
      releaseUrl: '',
      releaseNotes: null,
      state: 'available' as const,
      portable: false,
    });
    await act(async () => {
      root.render(<AboutSection />);
    });
    await act(async () => {
      buttonByText('settings.checkForUpdates')?.click();
    });

    expect(container.textContent).toContain('settings.downloadUpdate');
    expect(buttonByText('settings.portableUpdate.downloadAndPrepare')).toBeUndefined();
  });
});
