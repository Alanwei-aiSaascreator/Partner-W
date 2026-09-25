// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartupReadiness, StartupRelayFailure } from '../src/renderer/lib/startup-readiness';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('|')}` : key,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

import StartupReadinessScreen from '../src/renderer/layouts/StartupReadiness';
import StartupReadinessPanel from '../src/renderer/layouts/MainArea/StartupReadinessPanel';
import { useUiStore } from '../src/renderer/stores/uiStore';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const baseReadiness: StartupReadiness = {
  gatewayId: 'gw-1',
  ai: { phase: 'starting' },
  assistants: {
    phase: 'waiting',
    completed: 0,
    total: 6,
    missingIds: [],
  },
  workspaceAvailable: true,
  conversationReady: false,
  isReady: false,
  hasError: false,
  composerBlocked: true,
  relayFailure: null,
};

function render(ui: ReactElement): { container: HTMLDivElement; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('StartupReadinessScreen', () => {
  it('explains AI startup and exposes a busy state', () => {
    const { container, unmount } = render(<StartupReadinessScreen readiness={baseReadiness} onRetry={vi.fn()} />);

    expect(container.firstElementChild?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('startupReadiness.aiStarting');
    expect(container.textContent).toContain('startupReadiness.assistantsWaiting');
    unmount();
  });

  /**
   * ⭐⭐ C（2026-09-19，明天出 U 盘内测版）：**必须说清"这不是安装"**。
   *
   * 实测的误解来源：U 盘版首次启动会**把运行环境解压到本机缓存**（约 2–3 分钟，
   * 设计如此 —— 为了拔盘后还能继续用），那个进度界面**看起来就是在装软件**。
   * 同事确实这么反馈过（"双击 exe 装到电脑"）。
   *
   * ⇒ 这句要写死在这儿：**程序不写进系统、不创建桌面图标、不出现在「程序和功能」里**。
   */
  it('⭐⭐ 说清「这不是安装」（否则首启那 2–3 分钟会被当成在装软件）', () => {
    const { container, unmount } = render(<StartupReadinessScreen readiness={baseReadiness} onRetry={vi.fn()} />);

    expect(container.textContent, '首启界面必须有一句"这不是安装"').toContain('startupReadiness.notAnInstall');
    unmount();
  });

  it('⭐ 那句在**错误态**也要在，而且要**看得见**（那时用户最容易怀疑"装坏了"）', () => {
    // ⚠️ 断言**可见性**，不只是"在不在 DOM 里"：`hidden` / `display:none` 都不会把文字
    //    从 `textContent` 里去掉 ⇒ 只断 textContent 的话，"把它藏起来"这种改法**抓不住**。
    //    （变异验证实测过：加 `hidden={!isReady}` 时，只断 textContent 是全绿的。）
    const readiness: StartupReadiness = { ...baseReadiness, ai: { phase: 'error' }, hasError: true };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);

    const line = container.querySelector<HTMLElement>('[data-testid="not-an-install"]');
    expect(line, '错误态也必须有这句').not.toBeNull();
    expect(line!.hidden, '不许把它藏起来').toBe(false);
    expect(line!.style.display, '也不许用 CSS 藏').not.toBe('none');
    expect(line!.textContent).toContain('startupReadiness.notAnInstall');
    unmount();
  });

  it('renders the real assistant count and current localized role', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'installing',
        completed: 2,
        total: 6,
        currentId: 'rongying-office',
        missingIds: ['rongying-office'],
      },
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);
    const progress = container.querySelector('[role="progressbar"]');

    expect(progress?.getAttribute('aria-valuenow')).toBe('2');
    expect(progress?.getAttribute('aria-valuemax')).toBe('6');
    expect(container.textContent).toContain('presetAgents.roles.office');
    unmount();
  });

  it('names missing roles and retries after a failure', () => {
    const onRetry = vi.fn();
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'error',
        completed: 4,
        total: 6,
        missingIds: ['rongying-research', 'rongying-family'],
        error: 'write denied',
      },
      hasError: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={onRetry} />);

    expect(container.textContent).toContain('presetAgents.roles.research');
    expect(container.textContent).toContain('presetAgents.roles.family');
    const button = container.querySelector('button');
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledOnce();
    unmount();
  });

  /**
   * ⭐⭐ 2026-09-20 U 盘交付实机（T-a28）：**「这些助手尚未完成：… 0 / 6」说不出"为什么"**。
   *
   * `preset-agent-bootstrap` 在**抛错**（`refreshAgents` 失败等）和**全部失败**两种情况下
   * 填的 `missingIds` 都是"全部 6 个" ⇒ 两种截然不同的原因，在界面上**长得一模一样**；
   * 而它其实**把原因放进了 `snapshot.error`**（`Failed to create agent "X": <网关原文>`），
   * 门禁屏与工作台面板**都从来没渲染过这个字段**。
   * ⇒ 同事那边"一些助手安装失败了"我们看到的就是一个 0 / 6，没有可定位的原文。
   *
   * ⚠️ 断言**原文出现在屏幕上**（`textContent` + 没被 `hidden`），不是"某个 state 变了"。
   */
  it('⭐⭐ 助手没就绪时要说出**原因原文**（不只是"0 / 6"）', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'error',
        completed: 0,
        total: 6,
        missingIds: ['rongying-office'],
        error: 'Failed to create agent "rongying-office": gateway not connected',
      },
      hasError: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);

    expect(container.textContent).toContain('Failed to create agent "rongying-office": gateway not connected');
    const reason = container.querySelector<HTMLElement>('[data-testid="readiness-reason"]');
    expect(reason, '原因要有一个能定位的节点').not.toBeNull();
    expect(reason!.hidden, '不许把它藏起来').toBe(false);
    unmount();
  });

  it('没有原因原文时不许编一句（节点照着不渲染）', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: { phase: 'error', completed: 0, total: 6, missingIds: ['rongying-office'] },
      hasError: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);

    expect(container.querySelector('[data-testid="readiness-reason"]')).toBeNull();
    expect(container.textContent).toContain('startupReadiness.assistantsError');
    unmount();
  });

  it('uses explicit ready copy for completed capability rows', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'ready',
        completed: 6,
        total: 6,
        missingIds: [],
      },
      isReady: true,
    };
    const { container, unmount } = render(<StartupReadinessScreen readiness={readiness} onRetry={vi.fn()} />);

    expect(container.textContent).toContain('startupReadiness.aiReady');
    expect(container.textContent).toContain('startupReadiness.assistantsReady');
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
    unmount();
  });
});

describe('StartupReadinessPanel', () => {
  /**
   * ⭐ 2026-09-20（用户报障「一直卡在加载模型」）：`StartupAiPhase` 新增 `'catalog-failed'` 之后，
   * 面板的 `currentStatus` 是一条**三元链** —— 认不出的相位不会报错，只会**静默落到**
   * `assistants.*` / `aiReady`，于是"没能取到模型列表"会被显示成"模型已准备好"。
   * 这条就守着那条链（同时守着：失败态必须给重试出口）。
   */
  it('⭐ 目录取不到 ⇒ 说的是"没能取到"，不是"模型已准备好"', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'catalog-failed' },
      hasError: true,
      composerBlocked: false,
    };
    const { container, unmount } = render(<StartupReadinessPanel readiness={readiness} onRetry={vi.fn()} />);

    expect(container.textContent).toContain('startupReadiness.aiCatalogFailed');
    expect(container.textContent).not.toContain('startupReadiness.aiReady');
    expect(container.textContent).not.toContain('startupReadiness.aiLoadingModels');
    expect(container.textContent, '失败态要给重试出口').toContain('startupReadiness.retry');
    unmount();
  });

  it('shows one truthful assistant progress indicator and the current stage', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: { ...baseReadiness.assistants, phase: 'installing', completed: 2 },
    };
    const { container, unmount } = render(<StartupReadinessPanel readiness={readiness} onRetry={vi.fn()} />);
    const progress = container.querySelector('[role="progressbar"]');

    expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(1);
    expect(progress?.getAttribute('aria-valuemax')).toBe('6');
    expect(progress?.getAttribute('aria-valuenow')).toBe('2');
    expect(container.textContent).toContain('startupReadiness.assistantsInstalling');
    expect(container.textContent).not.toContain('%');
    unmount();
  });

  it('uses an indeterminate bar instead of inventing a percentage while the AI service starts', () => {
    const { container, unmount } = render(<StartupReadinessPanel readiness={baseReadiness} onRetry={vi.fn()} />);
    const progress = container.querySelector('[role="progressbar"]');

    expect(progress?.hasAttribute('aria-valuenow')).toBe(false);
    expect(container.textContent).toContain('startupReadiness.aiStarting');
    expect(container.textContent).not.toContain('%');
    unmount();
  });

  it('⭐⭐ 面板上也要有原因原文（同一个原因，两个面都不许吞）', () => {
    const readiness: StartupReadiness = {
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'error',
        completed: 0,
        total: 6,
        missingIds: ['rongying-office'],
        error: 'Failed to create agent "rongying-office": gateway not connected',
      },
      hasError: true,
    };
    const { container, unmount } = render(<StartupReadinessPanel readiness={readiness} onRetry={vi.fn()} />);

    expect(container.textContent).toContain('Failed to create agent "rongying-office": gateway not connected');
    expect(container.querySelector('[data-testid="readiness-reason"]')).not.toBeNull();
    unmount();
  });

  it('offers recovery after ninety seconds', () => {
    vi.useFakeTimers();
    const onRetry = vi.fn(async () => undefined);
    const { container, unmount } = render(<StartupReadinessPanel readiness={baseReadiness} onRetry={onRetry} />);

    act(() => vi.advanceTimersByTime(90_000));
    expect(container.textContent).toContain('startupReadiness.takingLonger');
    const retry = [...container.querySelectorAll('button')].find((item) =>
      item.textContent?.includes('startupReadiness.retry'),
    );
    act(() => retry?.click());
    expect(onRetry).toHaveBeenCalledOnce();

    unmount();
    vi.useRealTimers();
  });

  /**
   * ⭐⭐ C1（2026-09-25）：**"已经等了多久"必须看得见**。
   *
   * 用户骂"卡住"多半不是因为真的卡住，而是因为**看不出它是否还在动**：一句不动的文案
   * 配一条脉冲的进度条，等待与假死在观感上没有区别（2026-09-25 真日志：六分钟里
   * 面板上**一个字都没变**）。一个**持续在变的秒数**比任何 spinner 都更能证明"它没死"
   * —— 同一个推理早就用在聊天活动条上了（`waiting-copy.ts` 与 `formatElapsed`），
   * 这里只是把它接到启动面板上。
   */
  describe('还在准备时，看得见"等了多久"', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('⭐ 数字真的在走（等待与假死的区别就在这里）', () => {
      const { container, unmount } = render(<StartupReadinessPanel readiness={baseReadiness} onRetry={vi.fn()} />);

      expect(container.textContent).toContain('startupReadiness.elapsed');
      expect(container.textContent, '一开始就要有数，不能等一秒才出现').toContain('0.0s');

      act(() => vi.advanceTimersByTime(5_000));

      expect(container.textContent).toContain('5.0s');
      expect(container.textContent).not.toContain('0.0s');
      unmount();
    });

    it('⭐ 90 秒后"比平时更久"与秒数**同时**在（不是把秒数换成那句话）', () => {
      const { container, unmount } = render(<StartupReadinessPanel readiness={baseReadiness} onRetry={vi.fn()} />);

      act(() => vi.advanceTimersByTime(91_000));

      expect(container.textContent).toContain('startupReadiness.takingLonger');
      // 那句是"结论"，秒数是"还在动"的证据 —— 两者回答的不是同一个问题
      expect(container.textContent).toContain('91.0s');
      unmount();
    });

    it('对照：已经有结论（失败）之后不再报时间 —— 那时候秒数只是噪音', () => {
      const failed: StartupReadiness = {
        ...baseReadiness,
        ai: { phase: 'catalog-failed' },
        hasError: true,
        composerBlocked: false,
      };
      const { container, unmount } = render(<StartupReadinessPanel readiness={failed} onRetry={vi.fn()} />);

      expect(container.textContent).not.toContain('startupReadiness.elapsed');
      unmount();
    });

    it('对照：就绪之后也不报（那时候"等了多久"没有意义）', () => {
      const ready: StartupReadiness = {
        ...baseReadiness,
        ai: { phase: 'ready' },
        assistants: { ...baseReadiness.assistants, phase: 'ready', completed: 6 },
        conversationReady: true,
        isReady: true,
        composerBlocked: false,
      };
      const { container, unmount } = render(<StartupReadinessPanel readiness={ready} onRetry={vi.fn()} />);

      expect(container.textContent).not.toContain('startupReadiness.elapsed');
      unmount();
    });
  });

  /**
   * ⭐⭐ 2026-09-21（第二台机器实机）：**面板才是用户真正看得见的那一面**。
   *
   * 主进程早就把结论翻成了安全码，但面板的标题是一条三元链 —— `takingLonger` 在最前面，
   * 于是 90 秒之后连"这张卡绑在别的组织"都会被替换成"准备时间比平时更久"，
   * 而那个结论**再等也不会变**：用户被劝着继续等一件永远不会发生的事。
   */
  describe('已知的中转失败（第二台机器实机的形状）', () => {
    const withRelayFailure = (failure: StartupRelayFailure): StartupReadiness => ({
      ...baseReadiness,
      ai: { phase: 'error' },
      hasError: true,
      composerBlocked: false,
      relayFailure: failure,
    });

    beforeEach(() => {
      useUiStore.setState({ settingsOpen: false, settingsSection: null });
    });

    it('⭐⭐ 90 秒之后说的仍然是这张卡的事，不是"准备时间比平时更久"', () => {
      vi.useFakeTimers();
      const { container, unmount } = render(
        <StartupReadinessPanel
          readiness={withRelayFailure({ kind: 'organization-mismatch', errorCode: 'license_bound_elsewhere' })}
          onRetry={vi.fn()}
        />,
      );

      expect(container.textContent).toContain('startupReadiness.relayOrganizationMismatch');
      // 后端那条判定落成**本地化文案**，不是把安全码或英文原文贴到界面上。
      expect(container.textContent).not.toContain('license_bound_elsewhere');

      act(() => vi.advanceTimersByTime(90_000));
      expect(container.textContent, '90 秒后不许换成"等太久了"').toContain(
        'startupReadiness.relayOrganizationMismatch',
      );
      expect(container.textContent).not.toContain('startupReadiness.takingLonger');

      unmount();
      vi.useRealTimers();
    });

    /**
     * ⚠️ 判据是**两类出口互斥**，不是"有没有按钮"：
     *    确定性拒绝（`blocked`）给「去激活」；只有不确定的失败才给「重新准备」——
     *    "再试一万次也一样"的那种失败给重试按钮，等于请用户做无用功。
     */
    it('⭐⭐ 确定性失败给的是「去激活」（不是再试也没用的「重新准备」），点了落到激活页', () => {
      const { container, unmount } = render(
        <StartupReadinessPanel
          readiness={withRelayFailure({ kind: 'activation-required', errorCode: 'license_required' })}
          onRetry={vi.fn()}
        />,
      );

      expect(container.textContent).toContain('startupReadiness.relayActivationRequired');
      expect(container.textContent, '确定性失败不该出现重试出口').not.toContain('startupReadiness.retry');

      const activation = [...container.querySelectorAll('button')].find((item) =>
        item.textContent?.includes('startupReadiness.openActivation'),
      );
      expect(activation, '要有一个"去激活"的出口').toBeTruthy();

      act(() => activation?.click());
      expect(useUiStore.getState().settingsSection, '落到激活那一页').toBe('activation');
      expect(useUiStore.getState().settingsOpen, '并把设置打开').toBe(true);

      unmount();
    });

    /**
     * ⭐ 2026-09-21（复核）：`activation_limit_reached` **单独一档、且不给按钮**。
     *
     * 复核实测：激活页今天既没有设备列表也没有解绑入口 ⇒ 对"这张卡名额满了"这个结论，
     * 「去激活」是个按了没用的按钮（用户进去只能看到同一张卡）。
     * 与其留一个按了没用的出口，不如**什么都不按**、把那句话说完：
     * 换一张卡，或联系客服处理。
     */
    it('⭐⭐ 名额已满不给「去激活」（按了没用），只把"该怎么办"说清楚', () => {
      const { container, unmount } = render(
        <StartupReadinessPanel
          readiness={withRelayFailure({ kind: 'activation-limit-reached', errorCode: 'activation_limit_reached' })}
          onRetry={vi.fn()}
        />,
      );

      expect(container.textContent).toContain('startupReadiness.relayActivationLimitReached');
      expect(container.textContent, '没有出口就别给按钮').not.toContain('startupReadiness.openActivation');
      expect(container.textContent, '确定性失败同样不给重试').not.toContain('startupReadiness.retry');
      expect(container.querySelectorAll('button')).toHaveLength(0);
      expect(useUiStore.getState().settingsOpen, '也不许偷偷把设置打开').toBe(false);
      // 但结论必须还在（不许因为没按钮就把话说没了）。
      expect(container.textContent).not.toContain('startupReadiness.takingLonger');

      unmount();
    });

    it('⭐⭐ 其余的确定性拒绝也走去激活（不只 `license_required` 一种）', () => {
      const permanent: StartupRelayFailure[] = [
        { kind: 'entitlement-rejected', errorCode: 'license_not_found' },
        { kind: 'entitlement-rejected', errorCode: 'license_inactive' },
        { kind: 'entitlement-rejected', errorCode: 'license_expired' },
        { kind: 'entitlement-rejected', errorCode: 'activation_failed' },
      ];

      for (const failure of permanent) {
        const { container, unmount } = render(
          <StartupReadinessPanel readiness={withRelayFailure(failure)} onRetry={vi.fn()} />,
        );
        const activation = [...container.querySelectorAll('button')].find((item) =>
          item.textContent?.includes('startupReadiness.openActivation'),
        );
        expect(activation, `${failure.errorCode} 也要给激活出口`).toBeTruthy();
        expect(container.textContent, `${failure.errorCode} 不该给重试`).not.toContain('startupReadiness.retry');
        unmount();
      }
    });

    /**
     * ⭐ "错误态还在动"就是"还在准备"的另一种说法。转圈与脉冲都属于**承诺进度**，
     *    而这里已经**没有**进度可承诺了（结论已经出来）。
     */
    it('⭐⭐ 错误态不许转圈、不许脉冲：没有 spinner，没有脉冲进度条', () => {
      const { container, unmount } = render(
        <StartupReadinessPanel
          readiness={withRelayFailure({ kind: 'retryable', errorCode: 'runtime_not_ready' })}
          onRetry={vi.fn()}
        />,
      );

      expect(container.querySelectorAll('.animate-spin'), '不许转圈').toHaveLength(0);
      expect(container.querySelectorAll('.animate-pulse'), '不许脉冲').toHaveLength(0);
      expect(container.querySelectorAll('[role="progressbar"]'), '不许再渲染进度条').toHaveLength(0);
      expect(container.querySelector('section')?.getAttribute('aria-busy'), '错误不是"忙"').toBe('false');
      // 图标仍要说"出事了"（警告），而不是对勾。
      expect(container.textContent).toContain('startupReadiness.relayRetryable');

      unmount();
    });

    it('⭐ 只有可重试的失败才给「重新准备」（而且要能点）', () => {
      const onRetry = vi.fn(async () => undefined);
      const { container, unmount } = render(
        <StartupReadinessPanel
          readiness={withRelayFailure({ kind: 'retryable', errorCode: 'transport' })}
          onRetry={onRetry}
        />,
      );

      expect(container.textContent).toContain('startupReadiness.relayRetryable');
      expect(container.textContent, '可重试的失败不该出现激活出口').not.toContain('startupReadiness.openActivation');

      const retry = [...container.querySelectorAll('button')].find((item) =>
        item.textContent?.includes('startupReadiness.retry'),
      );
      act(() => retry?.click());
      expect(onRetry).toHaveBeenCalledOnce();

      unmount();
    });
  });

  /**
   * 助手失败时的**文件系统**那一档（2026-09-25，FAT32 真机形状）。
   *
   * 真机上六个预置助手全报 `unsafe workspace file`，而面板只会说「助手失败：某某某」——
   * 用户唯一有效的动作（把工作区换到 exFAT/NTFS 的盘）从界面上看不出来，
   * 而"重新准备"在那块盘上按一百次也不会好。
   */
  describe('助手失败 + 文件系统障碍', () => {
    beforeEach(() => {
      useUiStore.setState({ settingsOpen: false, settingsSection: null });
    });

    const withBlocker = (blocker: 'workspace-filesystem-unsupported' | 'workspace-unwritable'): StartupReadiness => ({
      ...baseReadiness,
      ai: { phase: 'ready' },
      assistants: {
        phase: 'error',
        completed: 0,
        total: 6,
        missingIds: ['rongying-content'],
        error: 'unsafe workspace file "IDENTITY.md"',
      },
      hasError: true,
      composerBlocked: false,
      assistantBlocker: blocker,
    });

    it('⭐⭐ 说的是那句能行动的话，出口是「换工作区」而不是按了没用的「重新准备」', () => {
      const { container, unmount } = render(
        <StartupReadinessPanel readiness={withBlocker('workspace-filesystem-unsupported')} onRetry={vi.fn()} />,
      );

      expect(container.textContent).toContain('startupReadiness.workspaceFilesystemUnsupported');
      expect(container.textContent, '这块盘上再"重新准备"一百次也一样').not.toContain('startupReadiness.retry');

      const change = [...container.querySelectorAll('button')].find((item) =>
        item.textContent?.includes('startupReadiness.openWorkspaceSettings'),
      );
      expect(change, '要有一个"换工作区"的出口').toBeTruthy();

      act(() => change?.click());
      expect(useUiStore.getState().settingsSection, '落到系统那一页（工作区在那儿改）').toBe('system');
      expect(useUiStore.getState().settingsOpen).toBe(true);

      unmount();
    });

    it('⭐ 不可写那一档说的是另一句（出口同样是换地方，但原因不同）', () => {
      const { container, unmount } = render(
        <StartupReadinessPanel readiness={withBlocker('workspace-unwritable')} onRetry={vi.fn()} />,
      );
      expect(container.textContent).toContain('startupReadiness.workspaceUnwritable');
      expect(container.textContent).not.toContain('startupReadiness.workspaceFilesystemUnsupported');
      unmount();
    });

    it('⭐ 原因原文仍然照旧显示（那是证据，两档都不许吞）', () => {
      const { container, unmount } = render(
        <StartupReadinessPanel readiness={withBlocker('workspace-filesystem-unsupported')} onRetry={vi.fn()} />,
      );
      expect(container.querySelector('[data-testid="readiness-reason"]')?.textContent).toContain(
        'unsafe workspace file',
      );
      unmount();
    });

    it('⭐ 负对照：只是助手失败、没有障碍 ⇒ 照旧通用那句 + 「重新准备」（别乱指文件系统）', () => {
      const onRetry = vi.fn(async () => undefined);
      const { container, unmount } = render(
        <StartupReadinessPanel
          readiness={{ ...withBlocker('workspace-filesystem-unsupported'), assistantBlocker: null }}
          onRetry={onRetry}
        />,
      );

      expect(container.textContent).toContain('startupReadiness.assistantsError');
      expect(container.textContent).not.toContain('startupReadiness.workspaceFilesystemUnsupported');
      expect(container.textContent).not.toContain('startupReadiness.openWorkspaceSettings');

      const retry = [...container.querySelectorAll('button')].find((item) =>
        item.textContent?.includes('startupReadiness.retry'),
      );
      act(() => retry?.click());
      expect(onRetry).toHaveBeenCalledOnce();

      unmount();
    });
  });
});

/**
 * ⭐ 「这不是安装」——**只对盘上运行成立**的那句说明。
 *
 * 背景：U 盘版首次启动会把运行环境准备到本机缓存（2–3 分钟），那个进度界面
 * **看起来就是在装软件** —— 实测有同事因此反馈"双击 exe 装到电脑"。
 * 这句话以前只活在一个**没人渲染**的整屏里，用户一个字都看不到。
 *
 * ⚠️ 判据两条，缺一不可：**盘上运行** 且 **还在准备**。装机版对它说是假话
 * （装机版确实写进系统、确实出现在「程序和功能」里）。
 */
describe('「这不是安装」：只在盘上运行 + 还在准备时说', () => {
  const NOT_AN_INSTALL = 'startupReadiness.notAnInstall';

  function stubPortable(value: boolean | (() => Promise<boolean>)): void {
    (globalThis.window as unknown as { clawwork: Record<string, unknown> }).clawwork = {
      isPortableWorkspace: typeof value === 'function' ? value : async () => value,
    };
  }

  it('⭐ 盘上运行 + 还在准备 ⇒ 那句话在', async () => {
    stubPortable(true);
    const { container, unmount } = render(<StartupReadinessPanel readiness={baseReadiness} onRetry={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).toContain(NOT_AN_INSTALL);
    unmount();
  });

  it('⭐ 对照：**装机版**不许说这句（对它来说那是假话）', async () => {
    stubPortable(false);
    const { container, unmount } = render(<StartupReadinessPanel readiness={baseReadiness} onRetry={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain(NOT_AN_INSTALL);
    unmount();
  });

  it('对照：盘上运行但**已经有结论**（失败/就绪）也不说 —— 那时不再像安装', async () => {
    stubPortable(true);
    const failed: StartupReadiness = {
      ...baseReadiness,
      hasError: true,
      composerBlocked: false,
      ai: { phase: 'error' },
    };
    const { container, unmount } = render(<StartupReadinessPanel readiness={failed} onRetry={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain(NOT_AN_INSTALL);
    unmount();
  });

  it('对照：问不出来（IPC 抛）⇒ 当"不是盘上"处理，不显示（宁可少说也不说错）', async () => {
    stubPortable(async () => {
      throw new Error('boom');
    });
    const { container, unmount } = render(<StartupReadinessPanel readiness={baseReadiness} onRetry={vi.fn()} />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain(NOT_AN_INSTALL);
    unmount();
  });
});
