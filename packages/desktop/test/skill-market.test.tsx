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
}

function installStubs(overrides: Partial<Stubs> = {}): Stubs {
  const stubs: Stubs = {
    listOurSkills: vi.fn(async (): Promise<IpcResult<OurSkillsListResult>> => ({ ok: true, result: SKILLS })),
    installOurSkill: vi.fn(async () => ({ ok: true })),
    removeOurSkill: vi.fn(async () => ({ ok: true })),
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
    installStubs({
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
