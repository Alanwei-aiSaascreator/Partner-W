// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ⭐ B3(a)（2026-10-11 整改）：**技能市场「修复随包版本」成功后，冲突报告要跟着收敛**。
 *
 * 真源复审（CHANGES_REQUIRED）：报告的唯一清除点是下一次开机 ensure —— 用户在这里
 * 修复成功后，`deck-layout` 的冲突还挂在「设置 → 技能」的常驻提示里，读起来就是
 * "修了没用"。直接调用 `clearBundledSkillsReport()` 的测试证明不了这条闭环，所以这条
 * 用例走**真实组件**：渲染技能市场 → 点已装行的「修复随包版本」 → 确认 →
 * 断言真实报告模块里那个 slug 消失、其他冲突原样保留。
 */

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/toast', () => ({ toast: toastMocks }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('../src/renderer/components/semantic/WindowTitlebar', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../src/renderer/components/semantic/InlineNotice', () => ({
  default: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../src/renderer/components/semantic/EmptyState', () => ({
  default: ({ title }: { title?: ReactNode }) => <div>{title}</div>,
}));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('../src/renderer/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
}));
// 确认框桩：把「确认」变成一个可点的按钮（真实对话用的仍是既有 ConfirmDialog）。
vi.mock('../src/renderer/components/semantic/ConfirmDialog', () => ({
  default: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? (
      <button data-testid="confirm-repair" onClick={onConfirm}>
        confirm
      </button>
    ) : null,
}));
vi.mock('../src/renderer/layouts/SkillMarket/use-skill-verdicts', () => ({
  useSkillVerdicts: () => ({}),
}));
vi.mock('../src/renderer/layouts/SkillMarket/SkillVerdictBadge', () => ({ default: () => null }));

import SkillMarket from '../src/renderer/layouts/SkillMarket/index';
import { useUiStore } from '../src/renderer/stores/uiStore';
import {
  captureBundledSkillsOperationScope,
  getBundledSkillsReport,
  publishBundledSkillsReport,
  reconcileBundledSkillsAfterResolvedSkill,
  resetBundledSkillsReportForTests,
} from '../src/renderer/lib/ensure-bundled-skills';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SKILLS = [
  { slug: 'deck-layout', name: '幻灯版面', installed: true },
  { slug: 'html-deliverable', name: '网页交付', installed: true },
];

function installClawStub(overrides: Record<string, unknown> = {}): {
  installOurSkill: ReturnType<typeof vi.fn>;
  listOurSkills: ReturnType<typeof vi.fn>;
} {
  const installOurSkill = vi.fn(async () => ({ ok: true, result: { backupDir: 'fixture-backup' } }));
  const listOurSkills = vi.fn(async () => ({ ok: true, result: { managedDirKnown: true, skills: SKILLS } }));
  (window as unknown as { clawwork: Record<string, unknown> }).clawwork = {
    installOurSkill,
    listOurSkills,
    removeOurSkill: vi.fn(),
    getSkillsStatus: vi.fn(async () => ({ ok: true, result: { skills: [] } })),
    skillsStatus: vi.fn(async () => ({ ok: true, result: { skills: [] } })),
    ...overrides,
  };
  return { installOurSkill, listOurSkills };
}

async function render(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<SkillMarket />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function click(container: HTMLElement, testId: string): void {
  const button = container.querySelector(`[data-testid="${testId}"]`);
  if (!button) throw new Error(`找不到 ${testId}`);
  act(() => (button as HTMLButtonElement).click());
}

function repairRow(container: HTMLElement, slug: string): void {
  const row = container.querySelector(`[data-testid="our-skill-row"][data-slug="${slug}"]`);
  if (!row) throw new Error(`找不到 ${slug} 这一行`);
  const repair = row.querySelector('[data-testid="our-skill-repair"]');
  if (!repair) throw new Error(`${slug} 没有修复按钮`);
  act(() => (repair as HTMLButtonElement).click());
}

describe('技能市场「修复随包版本」→ 冲突报告收敛（B3a）', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    resetBundledSkillsReportForTests();
    toastMocks.success.mockClear();
    toastMocks.error.mockClear();
    useUiStore.setState({ defaultGatewayId: 'gw-1', gatewayStatusMap: { 'gw-1': 'connected' } } as never);
    installClawStub();
  });

  it('两个冲突修一个：只清掉修好的那个，其他冲突原样保留', async () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [
        { slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] },
        { slug: 'html-deliverable', reason: 'user-modified', paths: ['SKILL.md'] },
      ],
      failed: [],
      names: {},
      updatedAt: 1,
    });
    const { container, unmount } = await render();

    repairRow(container, 'deck-layout');
    click(container, 'confirm-repair');
    await act(async () => undefined);

    const report = getBundledSkillsReport();
    expect(report, '还有没修的冲突 ⇒ 报告整体不许消失').not.toBeNull();
    expect(report?.conflicts.map((entry) => entry.slug)).toEqual(['html-deliverable']);
    expect(toastMocks.success).toHaveBeenCalled();

    unmount();
  });

  it('最后一个冲突修好：报告整体撤下（与"下一次开机全生效"同一个出口）', async () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: {},
      updatedAt: 1,
    });
    const { container, unmount } = await render();

    repairRow(container, 'deck-layout');
    click(container, 'confirm-repair');
    await act(async () => undefined);

    expect(getBundledSkillsReport(), '修完最后一个冲突 ⇒ 报告撤下').toBeNull();

    unmount();
  });

  it('修复失败（ok:false）：报告一个字节都不动（不假报修好）', async () => {
    installClawStub({
      installOurSkill: vi.fn(async () => ({ ok: false, error: 'file-in-use' })),
    });
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: {},
      updatedAt: 1,
    });
    const { container, unmount } = await render();

    repairRow(container, 'deck-layout');
    click(container, 'confirm-repair');
    await act(async () => undefined);

    expect(getBundledSkillsReport()?.conflicts.map((entry) => entry.slug)).toEqual(['deck-layout']);
    expect(toastMocks.error).toHaveBeenCalled();

    unmount();
  });

  it('报告属于**别的网关**：修好当前网关后不许顺手把它清掉', async () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-other',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: {},
      updatedAt: 1,
    });
    const { container, unmount } = await render();

    repairRow(container, 'deck-layout');
    click(container, 'confirm-repair');
    await act(async () => undefined);

    expect(getBundledSkillsReport()?.gatewayId, '别的网关的报告不许被本次修复动到').toBe('gw-other');

    unmount();
  });

  // ─────────── ⭐ B3 四轮（2026-10-11）：按结果语义收敛（复审 P2 两项） ───────────

  it('⭐ B3 四轮 #1：修复在途时同工作区的新报告先返回 —— 后到的成功修复照常收敛（不因"报告被写过"被拒）', async () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [
        { slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] },
        { slug: 'html-deliverable', reason: 'user-modified', paths: ['SKILL.md'] },
      ],
      failed: [],
      names: {},
      updatedAt: 1,
      workspaceEpoch: 0,
    });
    let resolveInstall!: (value: unknown) => void;
    const installPending = new Promise((resolve) => (resolveInstall = resolve));
    installClawStub({ installOurSkill: vi.fn(() => installPending) });
    const { container, unmount } = await render();

    repairRow(container, 'deck-layout');
    click(container, 'confirm-repair');
    await act(async () => undefined);

    // 修复还在途：开机 ensure（同网关同代次）先发布了它自己的报告 —— 旧的"报告轮次"整表
    // 判据会从这里起把这次修复的成功回调当成过期结论（复审 P2 #1 的反例形状）。
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [
        { slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] },
        { slug: 'html-deliverable', reason: 'user-modified', paths: ['SKILL.md'] },
      ],
      failed: [],
      names: {},
      updatedAt: 2,
      workspaceEpoch: 0,
    });

    await act(async () => {
      resolveInstall({ ok: true, result: { backupDir: 'fixture-backup' } });
    });
    await act(async () => undefined);

    const report = getBundledSkillsReport();
    expect(report, '还有没修的冲突 ⇒ 报告整体保留').not.toBeNull();
    expect(
      report?.conflicts.map((entry) => entry.slug),
      '修好的那个按结果收敛，其余原样',
    ).toEqual(['html-deliverable']);
    unmount();
  });

  // ───────────── B3 复审二轮（2026-10-11）：报告/操作轮次校验 ─────────────

  it('⭐ B3：修复在途时报告已被**更晚的结论**取代（新工作区）—— 旧回调一个字节都不动', () => {
    // 复审反例：修复针对旧作用域发起、卡在重载里；期间新工作区（代次 1）的报告先发布了。
    // 旧回调回来时不许按"同 gatewayId + 同 slug"把新报告清掉（或改写）。
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: {},
      updatedAt: 1,
      workspaceEpoch: 0,
    });
    const scope = captureBundledSkillsOperationScope('gw-1', 0);

    const newerReport = {
      gatewayId: 'gw-1',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [],
      names: { 'deck-layout': 'new-workspace-result' },
      updatedAt: 2,
      workspaceEpoch: 1,
    };
    publishBundledSkillsReport(newerReport);

    // 回调到达时当下工作区已是代次 1（发起 scope 是代次 0）⇒ 直接退出，报告对象逐字保留。
    reconcileBundledSkillsAfterResolvedSkill(scope, 'deck-layout', { gatewayId: 'gw-1', workspaceEpoch: 1 });
    expect(getBundledSkillsReport(), '旧完成不许回写/清新状态').toBe(newerReport);
  });

  it('⭐ B3：同一工作区（代次未变）—— 同一入口照常收敛（正对照）', () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [
        { slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] },
        { slug: 'html-deliverable', reason: 'user-modified', paths: ['SKILL.md'] },
      ],
      failed: [],
      names: {},
      updatedAt: 1,
      workspaceEpoch: 0,
    });
    const scope = captureBundledSkillsOperationScope('gw-1', 0);
    reconcileBundledSkillsAfterResolvedSkill(scope, 'deck-layout', { gatewayId: 'gw-1', workspaceEpoch: 0 });
    expect(getBundledSkillsReport()?.conflicts.map((entry) => entry.slug)).toEqual(['html-deliverable']);
  });

  it('⭐ B3：成功安装的收敛 —— 开机失败过的缺装技能手动装上后，failed 条目跟着清掉', async () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [],
      failed: [{ slug: 'html-deliverable', error: 'fixture-unavailable' }],
      names: {},
      updatedAt: 1,
    });
    installClawStub({
      listOurSkills: vi.fn(async () => ({
        ok: true,
        result: {
          managedDirKnown: true,
          skills: [
            { slug: 'deck-layout', name: '幻灯版面', installed: true },
            { slug: 'html-deliverable', name: '网页交付', installed: false },
          ],
        },
      })),
    });
    const { container, unmount } = await render();

    click(container, 'our-skill-install');
    await act(async () => undefined);

    expect(getBundledSkillsReport(), '最后一个未解决项清掉 ⇒ 报告整体撤下').toBeNull();
    unmount();
  });

  it('⭐ B3：成功安装只清**本次解决的那个** —— 其他失败/冲突原样保留', async () => {
    publishBundledSkillsReport({
      gatewayId: 'gw-1',
      conflicts: [{ slug: 'deck-layout', reason: 'user-modified', paths: ['SKILL.md'] }],
      failed: [{ slug: 'html-deliverable', error: 'fixture-unavailable' }],
      names: {},
      updatedAt: 1,
    });
    installClawStub({
      listOurSkills: vi.fn(async () => ({
        ok: true,
        result: {
          managedDirKnown: true,
          skills: [
            { slug: 'deck-layout', name: '幻灯版面', installed: true },
            { slug: 'html-deliverable', name: '网页交付', installed: false },
          ],
        },
      })),
    });
    const { container, unmount } = await render();

    click(container, 'our-skill-install');
    await act(async () => undefined);

    const report = getBundledSkillsReport();
    expect(report?.failed, '装好的那个清掉').toEqual([]);
    expect(
      report?.conflicts.map((entry) => entry.slug),
      '没解决的冲突原样保留',
    ).toEqual(['deck-layout']);
    unmount();
  });
});
