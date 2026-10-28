// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => `${key}${opts ? JSON.stringify(opts) : ''}`,
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

/** ⚠️ `vi.mock` 的工厂会被提升 ⇒ 引用的变量必须 `vi.hoisted` 造。 */
const { toastSpy } = vi.hoisted(() => ({ toastSpy: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/lib/toast', () => ({ toast: toastSpy }));

import SkillMarket from '../src/renderer/layouts/SkillMarket';
import { useUiStore } from '../src/renderer/stores/uiStore';
import type { IpcResult } from '../src/preload/clawwork';
import type { OurSkillsListResult } from '@clawwork/shared';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GATEWAY = 'gw-1';

const SKILLS: OurSkillsListResult = {
  managedDirKnown: true,
  skills: [
    {
      slug: 'meeting-minutes',
      name: '会议纪要整理',
      description: '把会议记录整理成结构化纪要',
      emoji: '📝',
      installed: false,
    },
    { slug: 'weekly-report', name: '周报撰写', description: '把零散事项汇总成周报', emoji: '📊', installed: true },
  ],
};

interface Stubs {
  listOurSkills: ReturnType<typeof vi.fn>;
  installOurSkill: ReturnType<typeof vi.fn>;
  removeOurSkill: ReturnType<typeof vi.fn>;
  /**
   * ⚠️ 桩必须**跟着组件长**：组件新增一次网关调用，桩不补上就是
   * `window.clawwork.getSkillsStatus is not a function` ——
   * 而更坏的一种是桩**按渲染层的假设手写**（本项目 `skills:our-list` 那次：
   * handler 返回扁平对象、渲染层按 `res.result.…` 读，整页报错而**单测全绿**）。
   * 所以 IPC 两端的类型要**显式标注**，让 `pnpm typecheck` 当那条防漂移的测试。
   */
  getSkillsStatus: ReturnType<typeof vi.fn>;
}

function installStubs(overrides: Partial<Stubs> = {}): Stubs {
  const stubs: Stubs = {
    listOurSkills: vi.fn(async (): Promise<IpcResult<OurSkillsListResult>> => ({ ok: true, result: SKILLS })),
    installOurSkill: vi.fn(async () => ({ ok: true })),
    removeOurSkill: vi.fn(async () => ({ ok: true })),
    // 默认成功桩：返回一份**空报告**（什么都不认得）。
    // 空报告 = 「网关还没认」⇒ 状态是未知，不会凭空把哪个技能说成能用。
    getSkillsStatus: vi.fn(async () => ({
      ok: true,
      result: { workspaceDir: '', managedSkillsDir: '', skills: [] },
    })),
    ...overrides,
  };
  (window as unknown as { clawwork: unknown }).clawwork = stubs;
  return stubs;
}

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

/** 等一次微任务链（load 是 async 的），让 React 把结果渲染出来。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function row(container: HTMLElement, slug: string): HTMLElement {
  const el = container.querySelector(`[data-slug="${slug}"]`);
  if (!el) throw new Error(`找不到技能行 ${slug}`);
  return el as HTMLElement;
}

describe('技能市场面板', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    toastSpy.success.mockClear();
    toastSpy.error.mockClear();
    useUiStore.setState({ defaultGatewayId: GATEWAY });
  });

  it('按设计稿改成卡片网格（2026-10-17 用户给稿；旧契约是"紧凑行"）', async () => {
    installStubs();
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    const list = container.querySelector('[data-testid="our-skill-list"]')!;
    // 网格 + 不居中收窄：卡片在宽屏上铺开（4 列），而不是一列长条。
    expect(list.className).toContain('grid');
    expect(list.parentElement?.className).not.toContain('max-w-');
    expect(row(container, 'meeting-minutes').className).toContain('rounded-xl');
    unmount();
  });

  it('⭐ 列的是**我们的**技能：中间名 + 中文描述都在（不是网关那批英文技能）', async () => {
    installStubs();
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(container.querySelectorAll('[data-testid="our-skill-row"]').length).toBe(2);
    expect(row(container, 'meeting-minutes').textContent).toContain('会议纪要整理');
    expect(row(container, 'meeting-minutes').textContent).toContain('把会议记录整理成结构化纪要');
    unmount();
  });

  it('⭐ 未装的显示「装上」、已装的显示「卸载」—— 按各自的 slug 走对接口', async () => {
    const stubs = installStubs();
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(row(container, 'meeting-minutes').getAttribute('data-installed')).toBe('false');
    expect(row(container, 'weekly-report').getAttribute('data-installed')).toBe('true');

    await act(async () => {
      (row(container, 'meeting-minutes').querySelector('[data-testid="our-skill-install"]') as HTMLElement).click();
    });
    await flush();
    expect(stubs.installOurSkill).toHaveBeenCalledWith(GATEWAY, 'meeting-minutes');

    await act(async () => {
      (row(container, 'weekly-report').querySelector('[data-testid="our-skill-remove"]') as HTMLElement).click();
    });
    await flush();
    expect(stubs.removeOurSkill).toHaveBeenCalledWith(GATEWAY, 'weekly-report');
    unmount();
  });

  it('装完会重新拉一次列表（装上/卸载后按钮的那一栏要跟着变）', async () => {
    const stubs = installStubs();
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    expect(stubs.listOurSkills).toHaveBeenCalledTimes(1);

    await act(async () => {
      (row(container, 'meeting-minutes').querySelector('[data-testid="our-skill-install"]') as HTMLElement).click();
    });
    await flush();
    expect(stubs.listOurSkills).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('装失败 ⇒ 弹出带原因的提示，且**不**假报成功', async () => {
    installStubs({ installOurSkill: vi.fn(async () => ({ ok: false, error: 'GATEWAY_UNAVAILABLE' })) });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    await act(async () => {
      (row(container, 'meeting-minutes').querySelector('[data-testid="our-skill-install"]') as HTMLElement).click();
    });
    await flush();

    expect(toastSpy.error).toHaveBeenCalledTimes(1);
    expect(toastSpy.success).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 网关没连上（managedDirKnown=false）⇒ 按钮禁用 + 一条提示，**且不显示"未装"**', async () => {
    // "不知道装没装"与"没装"是两回事：混在一起用户会以为自己的技能丢了。
    const stubs = installStubs({
      listOurSkills: vi.fn(async () => ({
        ok: true,
        result: { managedDirKnown: false, skills: SKILLS.skills },
      })),
    });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    const installBtn = container.querySelector('[data-testid="our-skill-install"]') as HTMLButtonElement;
    expect(installBtn.disabled).toBe(true);
    expect(container.textContent).toContain('skillMarket.gatewayRequired');
    /**
     * ⚠️ 网关没连上时**不许**给每张卡挂"没问出来"：整页已经有一条「未连接」了，
     * 再挂一句是噪音，而且会让人以为**是这个技能**的问题。
     */
    expect(container.querySelectorAll('[data-testid="our-skill-verdict"]').length).toBe(0);
    expect(stubs.getSkillsStatus).not.toHaveBeenCalled();
    unmount();
  });

  it('随包目录是空的（打包漏了）⇒ 空状态，不是空白页', async () => {
    installStubs({ listOurSkills: vi.fn(async () => ({ ok: true, result: { managedDirKnown: true, skills: [] } })) });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(container.querySelectorAll('[data-testid="our-skill-row"]').length).toBe(0);
    expect(container.textContent).toContain('skillMarket.empty');
    unmount();
  });

  it('技能名或描述缺失（SKILL.md 格式不对）⇒ 退回 slug 显示，不显示空白项', async () => {
    installStubs({
      listOurSkills: vi.fn(async () => ({
        ok: true,
        result: { managedDirKnown: true, skills: [{ slug: 'broken', installed: false }] },
      })),
    });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(row(container, 'broken').textContent).toContain('broken');
    unmount();
  });

  it('列表接口失败 ⇒ 明确报错，不是静默空列表', async () => {
    installStubs({ listOurSkills: vi.fn(async () => ({ ok: false, error: 'boom' })) });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(container.textContent).toContain('skillMarket.loadFailed');
    unmount();
  });

  it('⭐ 卸载的提示必须**说清代价**：网关侧要重启才彻底生效（装上则不提，它 0.7 秒就生效）', async () => {
    // 实测（2026-09-20）：装上 ~0.7 秒网关就看到；**卸载之后网关在进程内一直不失效**
    //（≥3 分钟仍报存在，按 agent 缓存；换一个 agent 问立刻正确），
    // 重启客户端后正确。⇒ 不写这句，用户卸完发现助手还在用它，只会觉得是 bug。
    const stubs = installStubs();
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    await act(async () => {
      (row(container, 'meeting-minutes').querySelector('[data-testid="our-skill-install"]') as HTMLElement).click();
    });
    await flush();
    expect(toastSpy.success.mock.calls[0][1]).toBeUndefined(); // 装上：不加说明

    await act(async () => {
      (row(container, 'weekly-report').querySelector('[data-testid="our-skill-remove"]') as HTMLElement).click();
    });
    await flush();
    const removeCall = toastSpy.success.mock.calls.at(-1) as [string, { description?: string } | undefined];
    expect(removeCall[1]?.description).toContain('skillMarket.removedCaveat');
    expect(stubs.removeOurSkill).toHaveBeenCalled();
    unmount();
  });

  it('⭐ 刷新按钮真的会重新拉（网关重连后这一页没有别的办法恢复）', async () => {
    const stubs = installStubs();
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    expect(stubs.listOurSkills).toHaveBeenCalledTimes(1);

    await act(async () => {
      (container.querySelector('[data-testid="our-skill-refresh"]') as HTMLElement).click();
    });
    await flush();
    expect(stubs.listOurSkills).toHaveBeenCalledTimes(2);
    unmount();
  });
});

/**
 * ⭐⭐ 「装上了」≠「助手用得上」（2026-09-29）。
 *
 * 这一页原来只有一个**本地**判据：磁盘上有没有那个目录（主进程 `fs.existsSync`）。
 * 用户的原话是「技能我不知安装后到底能不能用」—— 而这两件事在本项目**栽过至少两次**：
 * 手工把 SKILL.md 放进目录，**运行时不认**；技能描述改了，已装的盘拿不到。
 *
 * 所以新增的判据必须**从网关那一侧读回来**（`skills.status`，按助手），
 * 并且**如实保留"问不到"这一态** —— 既不许说成能用，也不许说成不能用。
 *
 * ⚠️ 磁盘判据**没有被替换**（页面上那段"别为了等网关把已装状态改成读 skills.status"
 * 的注释仍然有效）：装/卸按钮与「已装 M 个」照旧看磁盘，网关侧的结论是**另一个**标签。
 */
describe('技能市场 · 助手侧能不能用', () => {
  const AGENT = 'agent-1';

  const statusReport = (skills: { skillKey: string; eligible?: boolean }[]) => ({
    workspaceDir: 'C:/ws',
    managedSkillsDir: 'C:/managed',
    skills: skills.map((s) => ({
      name: s.skillKey,
      description: '',
      source: 'openclaw-managed',
      bundled: false,
      filePath: '',
      baseDir: '',
      skillKey: s.skillKey,
      always: false,
      disabled: false,
      blockedByAllowlist: false,
      eligible: s.eligible ?? true,
      requirements: { bins: [], anyBins: [], env: [], config: [], os: [] },
      missing: { bins: [], anyBins: [], env: [], config: [], os: [] },
      configChecks: [],
      install: [],
    })),
  });

  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    useUiStore.setState({
      defaultGatewayId: GATEWAY,
      selectedAgentByGateway: { [GATEWAY]: AGENT },
      agentCatalogByGateway: { [GATEWAY]: { agents: [{ id: AGENT } as never], defaultId: AGENT } },
    });
  });

  const verdictOf = (container: HTMLElement, slug: string): string =>
    row(container, slug).getAttribute('data-verdict') ?? '';

  it('⭐ 网关说这个助手能看见它 ⇒ 明确标出来（不是我们自己乐观）', async () => {
    const stubs = installStubs({
      getSkillsStatus: vi.fn(async () => ({ ok: true, result: statusReport([{ skillKey: 'weekly-report' }]) })),
    });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(stubs.getSkillsStatus, '必须**点名助手**问（不带 agentId 会落到环境属主，那是假绿）').toHaveBeenCalledWith(
      GATEWAY,
      AGENT,
    );
    expect(verdictOf(container, 'weekly-report')).toBe('usable');
    expect(row(container, 'weekly-report').textContent).toContain('skillMarket.verdictUsable');
    unmount();
  });

  it('⭐ 不知道该问哪个助手 ⇒ **压根不发探测**，落成"不知道"', async () => {
    useUiStore.setState({ defaultGatewayId: GATEWAY, selectedAgentByGateway: {}, agentCatalogByGateway: {} });
    const stubs = installStubs({
      getSkillsStatus: vi.fn(async () => ({ ok: true, result: statusReport([{ skillKey: 'weekly-report' }]) })),
    });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(stubs.getSkillsStatus, '问不出助手名就不问 —— 问错人比不问更坏').not.toHaveBeenCalled();
    expect(verdictOf(container, 'weekly-report')).toBe('unknown');
    unmount();
  });

  it('⭐ 问不到（RPC 一直失败）⇒ "不知道"，既不说能用也不说不能用', async () => {
    installStubs({ getSkillsStatus: vi.fn(async () => ({ ok: false, error: 'boom' })) });
    vi.useFakeTimers();
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(verdictOf(container, 'weekly-report')).toBe('unknown');
    const text = row(container, 'weekly-report').textContent ?? '';
    expect(text).toContain('skillMarket.verdictUnknown');
    expect(text, '问不到**不许**说成能用').not.toContain('skillMarket.verdictUsable');
    unmount();
    vi.useRealTimers();
  });

  it('⭐ 三次 RPC 全部悬挂 ⇒ 2500ms 总超时收工，不永久停在确认中', async () => {
    const stubs = installStubs({ getSkillsStatus: vi.fn(() => new Promise(() => undefined)) });
    vi.useFakeTimers();
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(stubs.getSkillsStatus).toHaveBeenCalledTimes(3);
    expect(verdictOf(container, 'weekly-report')).toBe('unknown');
    expect(verdictOf(container, 'weekly-report')).not.toBe('checking');
    unmount();
    vi.useRealTimers();
  });

  it('⭐ 安装有约 0.7 秒可见延迟 ⇒ 第一遍没有它要重试，转绿（不是立刻判不能用）', async () => {
    let call = 0;
    installStubs({
      getSkillsStatus: vi.fn(async () => {
        call += 1;
        // 第一次网关还没认；第二次才认得
        return { ok: true, result: statusReport(call === 1 ? [] : [{ skillKey: 'weekly-report' }]) };
      }),
    });
    vi.useFakeTimers();
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    expect(verdictOf(container, 'weekly-report'), '第一遍还没认出来时不许下结论').not.toBe('blocked');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(verdictOf(container, 'weekly-report')).toBe('usable');
    unmount();
    vi.useRealTimers();
  });

  it('⭐ 卸载之后不许自相矛盾：网关还报"在"（缓存 ≥3 分钟），但磁盘说没装 ⇒ 不给标签、也不再问', async () => {
    /**
     * ⚠️ 夹具要**忠实于真身**：卸载之后 `listOurSkills` 必须真的不再报它已装 ——
     * 第一版这里让桩一直返回 `installed: true`，于是"磁盘说没装"这个前提压根没发生，
     * 测试以"组件是坏的"为理由假红（其实是夹具没跟上）。
     */
    let removed = false;
    const stubs = installStubs({
      listOurSkills: vi.fn(async () => ({
        ok: true,
        result: {
          managedDirKnown: true,
          skills: SKILLS.skills.map((s) => (s.slug === 'weekly-report' ? { ...s, installed: !removed } : s)),
        },
      })),
      removeOurSkill: vi.fn(async () => {
        removed = true;
        return { ok: true };
      }),
      // 网关侧照旧报 weekly-report 在（这就是卸载后那个 ≥3 分钟窗口）
      getSkillsStatus: vi.fn(async () => ({ ok: true, result: statusReport([{ skillKey: 'weekly-report' }]) })),
    });
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    expect(verdictOf(container, 'weekly-report')).toBe('usable');

    await act(async () => {
      (row(container, 'weekly-report').querySelector('[data-testid="our-skill-remove"]') as HTMLElement).click();
    });
    await flush();

    expect(verdictOf(container, 'weekly-report'), '没装就不该有任何助手侧标签').toBe('none');
    expect(
      stubs.getSkillsStatus.mock.calls.length,
      '卸载之后不该再为它发探测（网关那 3 分钟窗口是它的、不是我们的）',
    ).toBeLessThanOrEqual(1);
    unmount();
  });

  it('⭐ 去问网关失败**不会**影响磁盘那一半：按钮照旧按磁盘说话', async () => {
    installStubs({ getSkillsStatus: vi.fn(async () => ({ ok: false, error: 'boom' })) });
    vi.useFakeTimers();
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });

    expect(row(container, 'weekly-report').getAttribute('data-installed')).toBe('true');
    expect(row(container, 'meeting-minutes').getAttribute('data-installed')).toBe('false');
    unmount();
    vi.useRealTimers();
  });

  it('⭐ 数量装置：共 N 个 · 已装 M 个（已装数比总数更有用）', async () => {
    installStubs({ getSkillsStatus: vi.fn(async () => ({ ok: true, result: statusReport([]) })) });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    const counter = container.querySelector('[data-testid="our-skill-count"]') as HTMLElement;
    expect(counter, '要有数量装置').not.toBeNull();
    expect(counter.getAttribute('data-total')).toBe('2');
    expect(counter.getAttribute('data-installed')).toBe('1');
    expect(counter.textContent).toContain('skillMarket.allInstalled');
    unmount();
  });

  it('⭐ 慢的那次尝试回来得晚 ⇒ 不许把已经变绿的打回"正在确认…"（那会永久卡住）', async () => {
    /**
     * ⚠️ 2026-09-29 独立复核抓到的真 bug：三次尝试是一次性排好的，
     * 而**慢的那次**（网关冷启动，实测 0.7~2 秒）可能最后才回来 ——
     * 它拿着"还没有这个技能"的旧结果，把已经变绿的界面重新打回"正在确认…"，
     * 而那时定时器已经用完 ⇒ **永远卡在"正在确认…"**。
     */
    let releaseFirst!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    let call = 0;
    installStubs({
      getSkillsStatus: vi.fn(async () => {
        call += 1;
        if (call === 1) return pending; // 第 0 拍：慢
        return { ok: true, result: statusReport([{ skillKey: 'weekly-report' }]) };
      }),
    });
    vi.useFakeTimers();
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(verdictOf(container, 'weekly-report')).toBe('usable');

    // 第 0 拍现在才回来，且拿的是"还没有这个技能"的旧结果
    await act(async () => {
      releaseFirst({ ok: true, result: statusReport([]) });
      await Promise.resolve();
    });

    expect(verdictOf(container, 'weekly-report'), '旧的响应不许把已收工的结论打回去').toBe('usable');
    expect(verdictOf(container, 'weekly-report')).not.toBe('checking');
    unmount();
    vi.useRealTimers();
  });

  it('⭐ 刷新开启新 epoch 后，旧 epoch 的迟到响应不得覆盖新结论', async () => {
    let releaseOld!: (value: unknown) => void;
    const oldPending = new Promise((resolve) => {
      releaseOld = resolve;
    });
    let call = 0;
    installStubs({
      getSkillsStatus: vi.fn(async () => {
        call += 1;
        if (call === 1) return oldPending;
        return { ok: true, result: statusReport([{ skillKey: 'weekly-report' }]) };
      }),
    });
    vi.useFakeTimers();
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    await act(async () => {
      (container.querySelector('[data-testid="our-skill-refresh"]') as HTMLElement).click();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(verdictOf(container, 'weekly-report')).toBe('usable');

    await act(async () => {
      releaseOld({ ok: true, result: statusReport([]) });
      await Promise.resolve();
    });
    expect(verdictOf(container, 'weekly-report')).toBe('usable');
    expect(verdictOf(container, 'weekly-report')).not.toBe('checking');
    unmount();
    vi.useRealTimers();
  });

  it.each([
    ['失败', { ok: false, error: 'boom' }],
    ['缺项', { ok: true, result: statusReport([]) }],
  ])('⭐ 最后发出的请求先%s，早先请求后成功 ⇒ 完整成功必须胜出', async (_case, thirdResult) => {
    let releaseFirst!: (value: unknown) => void;
    const first = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const second = new Promise(() => undefined);
    let call = 0;
    installStubs({
      getSkillsStatus: vi.fn(async () => {
        call += 1;
        if (call === 1) return first;
        if (call === 2) return second;
        return thirdResult;
      }),
    });
    vi.useFakeTimers();
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1600);
    });
    expect(verdictOf(container, 'weekly-report'), '仍有完整报告在途，不许抢先结算').toBe('checking');

    await act(async () => {
      releaseFirst({ ok: true, result: statusReport([{ skillKey: 'weekly-report' }]) });
      await Promise.resolve();
    });
    expect(verdictOf(container, 'weekly-report')).toBe('usable');

    unmount();
    vi.useRealTimers();
  });

  it('⭐ 最后一次探测失败 ⇒ 不许把前面已经问到的好报告扔掉', async () => {
    /**
     * ⚠️ 同一个复核：原来失败那条路写的是 `report: null`，
     * 于是"第 1 拍问到了、第 3 拍超时"会把刚看到的绿/红**变成"没问出来"**。
     * 总超时那条路本来就写着"只降级不覆盖"，这两条路却反着来。
     */
    let call = 0;
    installStubs({
      listOurSkills: vi.fn(async () => ({
        ok: true,
        result: {
          managedDirKnown: true,
          skills: SKILLS.skills.map((s) => (s.slug === 'meeting-minutes' ? { ...s, installed: true } : s)),
        },
      })),
      getSkillsStatus: vi.fn(async () => {
        call += 1;
        // 第 1 拍：只认得其中一个（所以不会早停）；第 3 拍：失败
        if (call === 3) return { ok: false, error: 'boom' };
        return { ok: true, result: statusReport([{ skillKey: 'weekly-report' }]) };
      }),
    });
    vi.useFakeTimers();
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2600);
    });

    expect(verdictOf(container, 'weekly-report'), '已经问到的答案不许被后来的失败抹掉').toBe('usable');
    expect(verdictOf(container, 'meeting-minutes'), '没见到的那一个才是"不知道"').toBe('unknown');
    unmount();
    vi.useRealTimers();
  });

  it('空列表时**不显示**数量装置（"共 0 个"是噪音）', async () => {
    installStubs({
      listOurSkills: vi.fn(async () => ({ ok: true, result: { managedDirKnown: true, skills: [] } })),
    });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(container.querySelector('[data-testid="our-skill-count"]')).toBeNull();
    unmount();
  });
});

/**
 * ⭐⭐ E3（2026-10-09 终审）：`confirmed-repair` 原来**只有 IPC、没有用户可达入口** ——
 * 已装的那一行只有「卸载」。这里钉住的是"入口存在 + 确认语义 + 如实报结果"：
 *  · 修复是**独立动作**，绝不借用卸载（卸了再装会把用户额外文件一起删掉）；
 *  · 取消确认 = 一个 IPC 都不发；
 *  · 确认后只调 `installOurSkill`（主进程走 confirmed-repair）；
 *  · 失败不假报成功；成功要把**恢复备份位置**如实上屏。
 */
describe('技能市场 · 修复随包版本（E3）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    toastSpy.success.mockClear();
    toastSpy.error.mockClear();
    useUiStore.setState({ defaultGatewayId: GATEWAY });
  });

  const repairButton = (container: HTMLElement, slug: string): HTMLButtonElement | null =>
    row(container, slug).querySelector('[data-testid="our-skill-repair"]');

  const dialog = (): HTMLElement | null => document.body.querySelector('[role="dialog"]');

  const dialogButton = (text: string): HTMLButtonElement | null => {
    const root = dialog();
    if (!root) return null;
    return [...root.querySelectorAll('button')].find((button) => (button.textContent ?? '').includes(text)) ?? null;
  };

  async function openRepair(container: HTMLElement, slug: string): Promise<void> {
    await act(async () => {
      repairButton(container, slug)?.click();
    });
    await flush();
  }

  it('⭐ 已装的行有独立「修复」入口（卸载按钮保留）；取消确认 = 零 IPC', async () => {
    const stubs = installStubs();
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(repairButton(container, 'weekly-report'), '已装的行必须有修复入口').not.toBeNull();
    expect(repairButton(container, 'meeting-minutes'), '未装的行不显示修复（那是"安装"）').toBeNull();
    expect(
      row(container, 'weekly-report').querySelector('[data-testid="our-skill-remove"]'),
      '卸载按钮必须保留：修复不是"卸了再装"',
    ).not.toBeNull();

    await openRepair(container, 'weekly-report');
    const confirm = dialog();
    expect(confirm, '点修复先弹确认框，不许直接替换').not.toBeNull();
    const text = confirm?.textContent ?? '';
    expect(text, '确认框要说清替换的是厂商文件').toContain('skillMarket.repairConfirmBody');
    expect(text).toContain('skillMarket.repairConfirmTitle');

    await act(async () => {
      dialogButton('common.cancel')?.click();
    });
    await flush();
    expect(stubs.installOurSkill, '取消 ⇒ 一个 IPC 都不发').not.toHaveBeenCalled();
    expect(stubs.removeOurSkill).not.toHaveBeenCalled();
    expect(dialog()).toBeNull();
    unmount();
  });

  it('⭐ 确认之后只走「安装修复」这条路（卸载调用为 0），成功提示给出恢复备份位置', async () => {
    const backupDir = 'C:/data/Partner-W-运行数据/skill-backups/royin-skill-backup-abc';
    const stubs = installStubs({
      installOurSkill: vi.fn(async () => ({ ok: true, result: { backupDir } })),
    });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    await openRepair(container, 'weekly-report');
    await act(async () => {
      dialogButton('skillMarket.repairConfirm')?.click();
    });
    await flush();

    expect(stubs.installOurSkill).toHaveBeenCalledTimes(1);
    expect(stubs.installOurSkill).toHaveBeenCalledWith(GATEWAY, 'weekly-report');
    expect(stubs.removeOurSkill, '修复绝不走卸载').not.toHaveBeenCalled();
    const success = toastSpy.success.mock.calls.at(-1) as [string, { description?: string } | undefined];
    expect(success?.[0]).toContain('skillMarket.repaired');
    expect(success?.[1]?.description, '恢复备份位置必须上屏').toContain(backupDir);
    unmount();
  });

  it('⭐ 修复失败 ⇒ 如实报失败，不假报成功；列表也不重拉成"成功"的样子', async () => {
    const stubs = installStubs({
      installOurSkill: vi.fn(async () => ({ ok: false, error: 'skill-install-verify-failed; 恢复备份已保留：C:/b' })),
    });
    const { container, unmount } = render(<SkillMarket />);
    await flush();
    expect(stubs.listOurSkills).toHaveBeenCalledTimes(1);

    await openRepair(container, 'weekly-report');
    await act(async () => {
      dialogButton('skillMarket.repairConfirm')?.click();
    });
    await flush();

    expect(toastSpy.error).toHaveBeenCalledTimes(1);
    const error = toastSpy.error.mock.calls[0] as [string, { description?: string } | undefined];
    expect(error[0]).toContain('skillMarket.actionFailed');
    expect(error[0], '失败原因（含备份位置）如实上屏').toContain('恢复备份已保留');
    expect(toastSpy.success).not.toHaveBeenCalled();
    expect(stubs.listOurSkills, '失败不重拉列表（不制造"已完成"的假象）').toHaveBeenCalledTimes(1);
    unmount();
  });

  it('⭐ 网关没连上 ⇒ 修复按钮同样禁用（不能点了才知道不行）', async () => {
    installStubs({
      listOurSkills: vi.fn(async () => ({ ok: true, result: { managedDirKnown: false, skills: SKILLS.skills } })),
    });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    expect(repairButton(container, 'weekly-report')?.disabled).toBe(true);
    unmount();
  });

  it('⭐ 修复在途时按钮禁用：重复点击不会再发一个 IPC', async () => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      release = resolve;
    });
    const stubs = installStubs({ installOurSkill: vi.fn(() => pending) });
    const { container, unmount } = render(<SkillMarket />);
    await flush();

    await openRepair(container, 'weekly-report');
    await act(async () => {
      dialogButton('skillMarket.repairConfirm')?.click();
    });
    await flush();

    expect(stubs.installOurSkill).toHaveBeenCalledTimes(1);
    expect(repairButton(container, 'weekly-report')?.disabled, '在途 ⇒ 禁用（重复点击守卫）').toBe(true);
    await act(async () => {
      repairButton(container, 'weekly-report')?.click();
    });
    await flush();
    expect(stubs.installOurSkill, '重复点击不许再发一次').toHaveBeenCalledTimes(1);

    await act(async () => {
      release({ ok: true, result: { backupDir: 'C:/b' } });
    });
    await flush();
    expect(repairButton(container, 'weekly-report')?.disabled).toBe(false);
    unmount();
  });
});
