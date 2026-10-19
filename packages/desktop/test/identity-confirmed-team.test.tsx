// @vitest-environment jsdom
/**
 * N2（2026-10-16）—— 「用户确认过的团队」必须有一个**真实的消费者**。
 *
 * 缺陷（Owner F 本轮核实、Owner N 复现）：`selectedAssistantIds` 除了校验/落盘之外
 * **没有任何运行时消费者** —— 个性化中心把六个能力组**静态**列全，谁确认过什么在界面上
 * 一个字都看不出来。也就是说：用户在首跑里挑的团队，写进档案之后就成了"只写不读"的数据。
 *
 * 语义边界（`PRODUCT_ARCHITECTURE.md` §1，词表唯一源 `identity.teamPosition.*`）：
 *   - **执行结构** = 主罗盘 + 五岗位（§③ 的固定名单，跟用户的勾选无关，不许被顶替）；
 *   - **Skill 能力层** = 六个能力组（§④），首跑里用户确认的就是它们（`StarterId`）。
 * ⇒ 本文件锁的是：确认过的名单**在 §③ 里如实提一句**（它们不是岗位，不能混进岗位名单），
 *    并且**在 §④ 的六个能力组上标出来**（这才是名单的真实归属层）。
 */
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tSpy, selectAgentSpy } = vi.hoisted(() => ({
  tSpy: vi.fn((key: string, _params?: unknown) => key),
  selectAgentSpy: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tSpy }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/hooks/useSelectAgent', () => ({ useSelectAgent: () => selectAgentSpy }));
vi.mock('@/hooks/useGatewayBootstrap', () => ({ fetchAgentsForGateway: vi.fn(async () => undefined) }));

import IdentityCenter from '../src/renderer/layouts/IdentityCenter';
import { useUiStore } from '../src/renderer/stores/uiStore';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/** 一份过了首跑、并**确认过团队**的档案（`workMatch` 只在 confirm 时写入）。 */
function confirmedProfile(selectedAssistantIds: OnboardingProfile['selectedAssistantIds']): OnboardingProfile {
  return {
    version: 3,
    userId: 'user-1',
    nickname: '小荣',
    introduction: '',
    role: 'operations',
    customRole: '',
    useCases: ['content'],
    customGoal: '',
    selectedAssistantIds,
    responseDetail: 'balanced',
    filePermission: 'ask-every-time',
    completedAt: '2026-09-16T00:00:00.000Z',
    industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
    questionnaire: { version: 1, answers: [null, null, null, null] },
    persona: { id: null, source: 'default', ruleVersion: null },
    workMatch: { source: 'basic', profileVersion: 'v1' },
  };
}

const confirmedGroups = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-skill-group][data-confirmed="true"]')].map(
    (el) => el.getAttribute('data-skill-group') ?? '',
  );

const allGroups = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-skill-group]')].map((el) => el.getAttribute('data-skill-group') ?? '');

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  tSpy.mockImplementation((key: string) => key);
  Object.assign(window, { clawwork: {}, });
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    mainView: 'identity',
    agentCatalogByGateway: { 'gw-1': { agents: [{ id: 'main' } as never], defaultId: 'main' } },
    selectedAgentByGateway: { 'gw-1': 'main' },
  });
});

describe('N2 · 个性化中心读回「用户确认过的团队」', () => {
  it('§④ 六个能力组标出用户确认过的那几个（不是静态列全）', () => {
    const { container, unmount } = render(<IdentityCenter profile={confirmedProfile(['office', 'content'])} />);
    // 六组仍然都在（它们是随包能力，不是"只留我选的"），但"确认过"这件事必须看得见
    expect(allGroups(container).sort()).toEqual(['content', 'ecommerce', 'family', 'office', 'research', 'video']);
    expect(confirmedGroups(container).sort()).toEqual(['content', 'office']);
    unmount();
  });

  it('换一份档案 ⇒ 标出来的组跟着换（名单来自档案，不是写死的）', () => {
    const first = render(<IdentityCenter profile={confirmedProfile(['family'])} />);
    expect(confirmedGroups(first.container)).toEqual(['family']);
    first.unmount();

    const second = render(<IdentityCenter profile={confirmedProfile(['content', 'research', 'ecommerce'])} />);
    expect(confirmedGroups(second.container).sort()).toEqual(['content', 'ecommerce', 'research']);
    second.unmount();
  });

  it('§③ 「我的 AI 团队」如实提一句确认过的能力，但**不**顶替主罗盘 + 五岗位', () => {
    const { container, unmount } = render(<IdentityCenter profile={confirmedProfile(['office', 'content'])} />);
    // 冻结的执行结构一个字不动：主罗盘 + 五岗位仍旧是那五个
    expect(container.querySelector('[data-team-member="main"]')).not.toBeNull();
    expect([...container.querySelectorAll('[data-team-position]')].map((el) => el.getAttribute('data-team-position'))).toEqual(
      ['researcher', 'analyst', 'creator', 'producer', 'inspector'],
    );
    // 确认过的能力被如实列出（名字直接复用首跑结果页那套能力名，不再造第二套词）
    const line = container.querySelector('[data-confirmed-skills]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain('identity.skillsConfirmed');
    expect(line?.textContent).toContain('onboarding.firstRun.result.capabilities.content');
    expect(line?.textContent).toContain('onboarding.firstRun.result.capabilities.office');
    // 名单只列确认过的那两个：没确认的能力不出现在这一行里
    expect(line?.textContent).not.toContain('onboarding.firstRun.result.capabilities.family');
    // 语义边界：六能力是 Skill，**不能**混进岗位名单里当成岗位
    const positionText = [...container.querySelectorAll('[data-team-position]')].map((el) => el.textContent ?? '');
    expect(positionText.some((text) => text.includes('onboarding.firstRun.result.capabilities.'))).toBe(false);
    unmount();
  });

  it('没有档案 / 没确认过任何能力时不说假话：不渲染那一行', () => {
    const empty = render(<IdentityCenter />);
    expect(empty.container.querySelector('[data-confirmed-skills]')).toBeNull();
    expect(confirmedGroups(empty.container)).toEqual([]);
    empty.unmount();

    const none = render(<IdentityCenter profile={confirmedProfile([])} />);
    expect(none.container.querySelector('[data-confirmed-skills]')).toBeNull();
    expect(confirmedGroups(none.container)).toEqual([]);
    none.unmount();
  });
});
