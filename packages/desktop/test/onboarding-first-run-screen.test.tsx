// @vitest-environment jsdom
import { act, type ComponentProps, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildOnboardingWorkMatchInput,
  loadOnboardingProfile,
  onboardingDraftScope,
  readOnboardingDraft,
  saveOnboardingProfile,
  type OnboardingProfile,
} from '../src/renderer/lib/user-onboarding';

const translationMode = vi.hoisted(() => ({ real: false }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => (translationMode.real ? actual.useTranslation() : { t: (key: string) => key }),
  };
});

import Onboarding from '../src/renderer/layouts/Onboarding';
import i18n from '../src/renderer/i18n';

function render(ui: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    rerender: (next: ReactElement) => {
      act(() => root.render(next));
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function click(container: HTMLElement, key: string) {
  const button = [...container.querySelectorAll('button')].find((item) => item.textContent?.includes(key));
  expect(button, `Missing button ${key}`).toBeDefined();
  act(() => button!.click());
}

function industry(container: HTMLElement, code: string) {
  const button = container.querySelector<HTMLButtonElement>(`[data-industry="${code}"]`);
  expect(button).not.toBeNull();
  act(() => button!.click());
}

/** 走完「趣味画像」页四题（全部跳过）。 */
function skipPortrait(container: HTMLElement) {
  for (let index = 0; index < 4; index += 1) click(container, 'onboarding.firstRun.questionSkip');
}

/**
 * 首跑流程翻转（2026-10-06 V1 收口）：先「工作资料」后「趣味画像」。
 * 资料页选好行业后点主按钮「生成我的 AI 团队」进入画像页；生成不再调模型，
 * 主按钮在选行业前保持禁用（旧版恒禁用是生产死按钮的根因）。
 */
function toPortrait(container: HTMLElement, code = 'H') {
  industry(container, code);
  click(container, 'onboarding.firstRun.generate');
}

/**
 * N1（2026-10-16）：已确认过的档案（v3 + 回执）**重开时落在「团队确认」（结果页）**，
 * 不再是资料页。要走"改资料"的老路径，先点结果页上的「修改我的资料」回到资料页 ——
 * 这就是重开之后的真实用户路径（不是测试迂回）。
 */
function toProfile(container: HTMLElement) {
  click(container, 'onboarding.firstRun.editProfile');
}

function fill(container: HTMLElement, selector: string, value: string) {
  const input = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  expect(input).not.toBeNull();
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value);
    input!.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function savedAiProfile(usageStatus: 'pending' | 'settled' = 'settled'): OnboardingProfile {
  const profile: OnboardingProfile = {
    version: 3,
    userId: 'user-1',
    nickname: 'Saved nickname',
    introduction: 'Saved introduction',
    role: 'finance',
    customRole: 'Hotel finance',
    useCases: ['office'],
    customGoal: 'Prepare monthly reports',
    selectedAssistantIds: ['family', 'research'],
    responseDetail: 'balanced',
    filePermission: 'ask-every-time',
    completedAt: '2026-10-03T00:00:00.000Z',
    industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
    questionnaire: { version: 1, answers: ['yes', 'no', null, 'yes'] },
    persona: { id: 'saved-character', source: 'user', ruleVersion: null },
  };
  return {
    ...profile,
    workMatch: {
      source: 'ai',
      profileVersion: buildOnboardingWorkMatchInput(profile, 'workspace-a').profileVersion,
      requestId: 'saved-request',
      runId: 'saved-run',
      modelId: 'actual-model',
      summary: 'A previously purchased work suggestion',
      starters: ['Review monthly reports'],
      usageStatus,
    },
  };
}

function failNextProfileWrite() {
  const failure = new DOMException('Profile storage unavailable', 'SecurityError');
  const observedErrors: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    if (event.error !== failure) return;
    observedErrors.push(event.error);
    event.preventDefault();
  };
  window.addEventListener('error', onError);
  const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
    throw failure;
  });
  return {
    observedErrors,
    write,
    restore: () => {
      write.mockRestore();
      window.removeEventListener('error', onError);
    },
  };
}

describe('first-run local onboarding', () => {
  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    translationMode.real = false;
    window.localStorage.clear();
    // 首跑草稿走 sessionStorage（问题 7）：不清会让上一个用例的填写漏进下一个用例。
    window.sessionStorage.clear();
  });

  it('puts the work action before compact result content and renders real skill reasons and task examples', () => {
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    click(view.container, 'onboarding.useCases.office.title');
    fill(view.container, '[data-first-run-goal]', 'Prepare manufacturing monthly reports');
    toPortrait(view.container, 'C');
    for (let index = 0; index < 4; index += 1) click(view.container, 'onboarding.firstRun.answerYes');
    click(view.container, 'onboarding.portrait.next');
    const content = view.container.querySelector('[data-result-work]')!;
    const action = view.container.querySelector('[data-result-actions] [data-primary-action]')!;
    expect(content).not.toBeNull();
    expect(action.compareDocumentPosition(content) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(view.container.querySelector('[data-testid="portrait-card"]')?.getAttribute('data-variant')).toBe('compact');
    expect(view.container.querySelector('[data-testid="portrait-radar"]')).toBeNull();
    expect(view.container.querySelector('[data-result-use-cases]')?.textContent).toContain(
      'onboarding.useCases.office.title',
    );
    expect(view.container.querySelector('[data-result-goal]')?.textContent).toBe(
      'Prepare manufacturing monthly reports',
    );
    expect(
      view.container.querySelector('[data-assistant="office"] [data-recommendation-reason]')?.textContent,
    ).toContain('onboarding.firstRun.result.reasons.office');
    expect(view.container.querySelectorAll('[data-recommendation-reason]')).toHaveLength(3);
    expect(view.container.querySelectorAll('[data-skill-task]')).toHaveLength(3);
    expect(view.container.textContent).toContain('onboarding.firstRun.result.capabilityNotice');
    click(view.container, 'onboarding.firstRun.result.viewPortrait');
    expect(document.body.querySelector('[role="dialog"] [data-testid="portrait-radar"]')).not.toBeNull();
    view.unmount();
  });

  it('opens on the work profile page with the slimmed form and eight named industry choices without charging', () => {
    // 反转（2026-10-06 V1 收口）：旧首屏是趣味画像页（画像→资料→匹配→结果）；
    // 新流程工作资料在前（资料→画像→结果），匹配页随 AI 匹配通道下线。
    const view = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    expect(view.container.querySelector('[data-first-run-nickname]')).not.toBeNull();
    expect(view.container.querySelectorAll('[data-industry]')).toHaveLength(8);
    expect(view.container.textContent).toContain('onboarding.firstRun.chargeNotice');
    // 首跑不再渲染「回答详细程度 / 文件访问方式」两块（仅编辑模式保留）；资料区只剩岗位 1 个下拉。
    expect(view.container.textContent).not.toContain('onboarding.responseDetail');
    expect(view.container.textContent).not.toContain('onboarding.filePermission');
    expect(view.container.querySelectorAll('select')).toHaveLength(1);
    // AI 匹配提示与匹配步骤一并下线（本地生成已可用）。
    expect(view.container.textContent).not.toContain('onboarding.firstRun.matchUnavailable');
    expect([...view.container.querySelectorAll('ol li')].map((item) => item.textContent)).toEqual([
      'onboarding.firstRun.steps.profile',
      'onboarding.firstRun.steps.portrait',
      'onboarding.firstRun.steps.result',
    ]);
    // 主按钮在选行业前禁用（旧版依赖永不传入的 workMatch 恒禁用 = 生产死按钮）。
    const primary = [...view.container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('onboarding.firstRun.generate'),
    ) as HTMLButtonElement;
    expect(primary.disabled).toBe(true);
    industry(view.container, 'H');
    expect(primary.disabled).toBe(false);
    click(view.container, 'onboarding.firstRun.generate');
    expect(view.container.querySelector('[data-question="popular"]')).not.toBeNull();
    view.unmount();
  });

  it('preserves answers across previous/skip, reveals the portrait, and requires confirmation', () => {
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    toPortrait(view.container);
    click(view.container, 'onboarding.firstRun.answerYes');
    click(view.container, 'onboarding.firstRun.answerNo');
    click(view.container, 'onboarding.firstRun.questionSkip');
    click(view.container, 'onboarding.firstRun.questionBack');
    expect(view.container.querySelector('[data-question="math"]')).not.toBeNull();
    click(view.container, 'onboarding.firstRun.questionSkip');
    click(view.container, 'onboarding.firstRun.answerYes');
    expect(view.container.querySelector('[data-testid="portrait-card"]')).not.toBeNull();
    // 有跳过题（Q3）⇒ 四字码显示 ?，只给"含未答题"旁注，不编 16 型名
    expect(view.container.querySelector('[data-portrait-letters]')?.textContent).toBe('EN?J');
    expect(view.container.querySelector('[data-portrait-partial]')?.textContent).toContain(
      'onboarding.firstRun.types.partial',
    );
    expect(view.container.textContent).not.toMatch(/onboarding\.firstRun\.types\.[A-Z]{4}\./);
    // 新流程：画像页收尾直接跑本地生成进结果页（不再回资料页点基础方案）。
    click(view.container, 'onboarding.portrait.next');
    expect(onComplete).not.toHaveBeenCalled();
    expect(view.container.textContent).toContain('onboarding.firstRun.sourceBasic');
    // 反转（2026-10-07 体检问题 6）：结果页不再恒画 UserRound 占位 —— 有画像就出角色卡
    //（立绘走 portraitArtworkFor 查表，与个性化中心同一条链）；四题全跳过才落占位文案。
    expect(view.container.querySelector('[data-testid="portrait-card"]')?.getAttribute('data-role')).toBe('hengchuan');
    expect(view.container.textContent).not.toContain('onboarding.firstRun.personaUnavailable');
    click(view.container, 'onboarding.firstRun.confirm');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 3,
        userId: 'user-1',
        industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
        questionnaire: { version: 1, answers: ['yes', 'no', null, 'yes'] },
        persona: { id: null, source: 'default', ruleVersion: null },
        portrait: {
          axes: { 外向力: 60, 探索力: 30, 理性力: 60, 条理力: 70, 共情力: 55 },
          letters: 'ENXJ',
          role: 'hengchuan',
          ruleVersion: 'portrait-v1',
          locked: true,
        },
        // 首跑隐藏了这两块设置，但缺省值照旧写进档案。
        responseDetail: 'balanced',
        filePermission: 'ask-every-time',
        workMatch: expect.objectContaining({ source: 'basic' }),
      }),
    );
    view.unmount();
  });

  it('reveals the fun portrait after four answers, can retest, and writes nothing when all are skipped', () => {
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    toPortrait(view.container);
    for (let index = 0; index < 4; index += 1) click(view.container, 'onboarding.firstRun.answerYes');
    expect(view.container.querySelector('[data-testid="portrait-radar"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="portrait-card"]')?.getAttribute('data-role')).toBe('hengchuan');
    // 四题全作答 ⇒ 一行 16 型展示（ESTJ · 总经理 + 一句话）
    expect(view.container.querySelector('[data-portrait-letters]')?.textContent).toBe('ESTJ');
    expect(view.container.textContent).toContain('onboarding.firstRun.types.ESTJ.name');
    expect(view.container.textContent).toContain('onboarding.firstRun.types.ESTJ.line');
    expect(view.container.querySelector('[data-portrait-partial]')).toBeNull();
    // 「重测」回到第一题（已选答案保留），结果区收起
    click(view.container, 'onboarding.portrait.retest');
    expect(view.container.querySelector('[data-question="popular"]')).not.toBeNull();
    expect(view.container.querySelector('[data-testid="portrait-card"]')).toBeNull();
    // 四题全跳过 ⇒ 不出角色卡、不生成虚构分数，保存里也不得有 portrait
    skipPortrait(view.container);
    expect(view.container.querySelector('[data-testid="portrait-card"]')).toBeNull();
    expect(view.container.textContent).toContain('onboarding.portrait.allSkipped');
    click(view.container, 'onboarding.portrait.next');
    // 没有画像（四题全跳过）⇒ 结果页才用占位文案，不许编立绘/类型
    expect(view.container.querySelector('[data-testid="portrait-card"]')).toBeNull();
    expect(view.container.textContent).toContain('onboarding.firstRun.personaUnavailable');
    click(view.container, 'onboarding.firstRun.confirm');
    const saved = onComplete.mock.calls.at(-1)?.[0];
    expect(saved).not.toHaveProperty('portrait');
    view.unmount();
  });

  it('⭐ 画像页收性别/年龄：完整四字码 + 性别 ⇒ 16 型形象，两件都落进档案', () => {
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    toPortrait(view.container);
    // 控件在答题之前就在（不答四题也照样往下走，不阻塞流程）
    expect(view.container.querySelector('[data-portrait-details]')).not.toBeNull();
    click(view.container, 'onboarding.portrait.gender.female');
    fill(view.container, '[data-portrait-age-input]', '28');
    for (let index = 0; index < 4; index += 1) click(view.container, 'onboarding.firstRun.answerYes');
    // 四字码 ESTJ + 女 ⇒ 卡面出 16 型身份行；素材真实在位 ⇒ 用的是 16 型全身卡
    expect(view.container.querySelector('[data-portrait-mbti-type]')?.textContent).toBe('ESTJ');
    expect(view.container.querySelector('[data-portrait-gender]')?.textContent).toBe(
      'onboarding.portrait.gender.female',
    );
    expect(view.container.querySelector('[data-portrait-age]')?.textContent).toBe('28');
    expect(view.container.querySelector('[data-mbti-artwork]')?.getAttribute('src')).toContain('mbti-ESTJ-f');
    click(view.container, 'onboarding.portrait.next');
    click(view.container, 'onboarding.firstRun.confirm');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        portrait: expect.objectContaining({ letters: 'ESTJ', role: 'hengchuan', gender: 'female', age: 28 }),
      }),
    );
    view.unmount();
  });

  it('没选性别就不硬凑 16 型形象：走六角色立绘，档案里也没有 gender/age 键', () => {
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    toPortrait(view.container);
    for (let index = 0; index < 4; index += 1) click(view.container, 'onboarding.firstRun.answerYes');
    expect(view.container.querySelector('[data-portrait-identity]')).toBeNull();
    expect(view.container.querySelector('[data-mbti-artwork]')).toBeNull();
    expect(view.container.querySelector('[data-portrait-artwork]')).not.toBeNull();
    click(view.container, 'onboarding.portrait.next');
    click(view.container, 'onboarding.firstRun.confirm');
    const saved = onComplete.mock.calls.at(-1)?.[0] as OnboardingProfile;
    expect(saved.portrait).not.toHaveProperty('gender');
    expect(saved.portrait).not.toHaveProperty('age');
    view.unmount();
  });

  it('年龄只放行 1–120 的整数：越界不写进档案（也不挡流程）、性别照留', () => {
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    toPortrait(view.container);
    click(view.container, 'onboarding.portrait.gender.male');
    fill(view.container, '[data-portrait-age-input]', '999');
    for (let index = 0; index < 4; index += 1) click(view.container, 'onboarding.firstRun.answerYes');
    expect(view.container.querySelector('[data-portrait-age]')).toBeNull();
    click(view.container, 'onboarding.portrait.next');
    click(view.container, 'onboarding.firstRun.confirm');
    const saved = onComplete.mock.calls.at(-1)?.[0] as OnboardingProfile;
    expect(saved.portrait?.gender).toBe('male');
    expect(saved.portrait).not.toHaveProperty('age');
    view.unmount();
  });

  it('性别/年龄也进首跑草稿：刷新接上，不用重选', () => {
    const first = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    industry(first.container, 'H');
    click(first.container, 'onboarding.portrait.editEntry');
    click(first.container, 'onboarding.portrait.gender.female');
    fill(first.container, '[data-portrait-age-input]', '31');
    first.unmount();

    const again = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    // 断点真的接上了：直接停在画像页，性别与年龄都是上一轮选的
    expect(again.container.querySelector('[data-portrait-details]')).not.toBeNull();
    expect(again.container.querySelector('[data-gender-option="female"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(again.container.querySelector<HTMLInputElement>('[data-portrait-age-input]')?.value).toBe('31');
    again.unmount();
  });

  it('N3 · AI 匹配通道已整条删除：向导不再接受任何匹配适配器，生成只跑本地 basic()', () => {
    // 删依据（本仓历史可查）：`App.tsx` 从任何版本起都没传过匹配适配器；
    // `validateOnboardingWorkMatchReply` 只有测试引用；结果页的 `source === 'ai'` 分支
    // 因此只能在测试里到达 ⇒ 留着的是一条"看起来在跑、其实永远不跑"的通道。
    // ① 类型面：入参表里已经没有 `workMatch`（`@ts-expect-error` 由 typecheck:tests 钉住；
    //    哪天有人把它加回来，这一行会变成"未使用的 expect-error"直接红）。
    // @ts-expect-error N3：`workMatch` 入参已删除（AI 匹配通道整条下线）
    const removedProp = <Onboarding userId="user-1" onComplete={vi.fn()} workMatch={{ scopeKey: 'workspace-a' }} />;
    expect(removedProp).toBeTruthy();
    // ② 行为面：就算运行时硬塞回来（绕过类型），向导也不认它 —— 不是通路就不该被当通路。
    const request = vi.fn();
    const onComplete = vi.fn();
    const smuggled = {
      userId: 'user-1',
      onComplete,
      workMatch: { scopeKey: 'workspace-a', request },
    } as unknown as ComponentProps<typeof Onboarding>;
    const view = render(<Onboarding {...smuggled} />);
    toPortrait(view.container, 'general');
    skipPortrait(view.container);
    click(view.container, 'onboarding.portrait.next');
    expect(view.container.textContent).toContain('onboarding.firstRun.sourceBasic');
    expect(request).not.toHaveBeenCalled();
    click(view.container, 'onboarding.firstRun.confirm');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ workMatch: expect.objectContaining({ source: 'basic' }) }),
    );
    expect(request).not.toHaveBeenCalled();
    view.unmount();
  });

  it('remounts local state when account changes and never imports the previous account profile', () => {
    const view = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    industry(view.container, 'H');
    click(view.container, 'onboarding.portrait.editEntry');
    click(view.container, 'onboarding.firstRun.answerYes');
    view.rerender(<Onboarding userId="user-2" onComplete={vi.fn()} />);
    // 换账号后整棵向导重挂：回到工作资料页（新首屏），上一账号的行业与答案都不在
    expect(view.container.querySelector('[data-first-run-nickname]')).not.toBeNull();
    expect(view.container.querySelector('[data-industry="H"]')?.getAttribute('aria-pressed')).toBe('false');
    click(view.container, 'onboarding.portrait.editEntry');
    expect(view.container.querySelector('[data-question="popular"]')).not.toBeNull();
    const yes = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'onboarding.firstRun.answerYes',
    );
    expect(yes?.getAttribute('aria-pressed')).toBe('false');
    view.unmount();
  });

  it('N3 · 首跑草稿作用域只剩账号：删掉 scopeKey 之后老草稿仍然接得上', () => {
    // 生产从来不传 scopeKey ⇒ 实际写进 sessionStorage 的键一直是 `userId:account-local`。
    // 删掉入参后这个键**不能变**（否则用户升级后填了一半的草稿会失联），所以把它钉死。
    expect(onboardingDraftScope('user-1')).toBe('user-1:account-local');
    const first = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    fill(first.container, '[data-first-run-nickname]', '接得上的草稿');
    industry(first.container, 'H');
    expect(readOnboardingDraft(onboardingDraftScope('user-1', undefined))?.nickname).toBe('接得上的草稿');
    first.unmount();

    const again = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    expect(again.container.querySelector<HTMLInputElement>('[data-first-run-nickname]')!.value).toBe('接得上的草稿');
    expect(again.container.querySelector('[data-industry="H"]')?.getAttribute('aria-pressed')).toBe('true');
    again.unmount();
  });

  it('⭐ 首跑草稿（资料页）：卸载再进来，填过的昵称/介绍/行业都还在（问题 7）', () => {
    const first = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    fill(first.container, '[data-first-run-nickname]', '填到一半的名字');
    fill(first.container, 'input[maxlength="400"]', '填到一半的介绍');
    industry(first.container, 'H');
    first.unmount();

    const second = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    expect(second.container.querySelector<HTMLInputElement>('[data-first-run-nickname]')!.value).toBe('填到一半的名字');
    expect(second.container.querySelector<HTMLInputElement>('input[maxlength="400"]')!.value).toBe('填到一半的介绍');
    expect(second.container.querySelector('[data-industry="H"]')!.getAttribute('aria-pressed')).toBe('true');
    second.unmount();
  });

  it('⭐ 首跑草稿（画像页断点）：答过一题后卸载，再进来停在第二题而不是从头', () => {
    const first = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    toPortrait(first.container);
    click(first.container, 'onboarding.firstRun.answerYes');
    first.unmount();

    const second = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    expect(second.container.querySelector('[data-question="sport"]')).not.toBeNull();
    // 早已答过的第一题不在屏上（断点真的接上了，不是从头再来）
    expect(second.container.querySelector('[data-question="popular"]')).toBeNull();
    second.unmount();
  });

  it('⭐ 草稿按账号隔离；确认完成后清掉（换账号不继承、完成后不复活）', () => {
    const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
    const first = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    fill(first.container, '[data-first-run-nickname]', 'A 填的');
    industry(first.container, 'H');
    first.unmount();

    // 换账号：读不到上一位的草稿
    const other = render(<Onboarding userId="user-2" onComplete={vi.fn()} />);
    expect(other.container.querySelector<HTMLInputElement>('[data-first-run-nickname]')!.value).toBe('');
    expect(other.container.querySelector('[data-industry="H"]')!.getAttribute('aria-pressed')).toBe('false');
    other.unmount();

    // 回到 user-1：草稿还在
    const again = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    expect(again.container.querySelector<HTMLInputElement>('[data-first-run-nickname]')!.value).toBe('A 填的');
    // 走完流程并确认 ⇒ 草稿使命结束
    click(again.container, 'onboarding.firstRun.generate'); // 资料页 → 画像页
    skipPortrait(again.container);
    click(again.container, 'onboarding.portrait.next');
    click(again.container, 'onboarding.firstRun.confirm');
    expect(onComplete).toHaveBeenCalled();
    expect(readOnboardingDraft(onboardingDraftScope('user-1'))).toBeNull();
    again.unmount();
  });

  it('allows reselecting a locally recommended assistant after toggling it off', () => {
    const view = render(<Onboarding userId="user-1" onComplete={vi.fn()} />);
    toPortrait(view.container);
    skipPortrait(view.container);
    click(view.container, 'onboarding.portrait.next');
    const assistant = () => view.container.querySelector<HTMLButtonElement>('[data-assistant="office"]')!;
    expect(assistant()).not.toBeNull();
    act(() => assistant().click());
    expect(assistant().getAttribute('aria-pressed')).toBe('false');
    act(() => assistant().click());
    expect(assistant().getAttribute('aria-pressed')).toBe('true');
    view.unmount();
  });

  it('preserves the saved character id and provenance when its artwork is unavailable', () => {
    const onComplete = vi.fn();
    const view = render(
      <Onboarding
        userId="user-1"
        mode="edit"
        onComplete={onComplete}
        initialProfile={{
          version: 3,
          userId: 'user-1',
          nickname: '',
          useCases: ['office'],
          customGoal: '',
          completedAt: '',
          industry: { code: 'H', generalConfirmed: false, source: 'user', catalogVersion: 1 },
          questionnaire: { version: 1, answers: [null, null, null, null] },
          persona: { id: 'approved-user-character', source: 'user', ruleVersion: null },
          workMatch: { source: 'basic', profileVersion: 'old' },
        }}
      />,
    );
    // ⚠️ N1：本夹具是**没有确认名单**的档案（`selectedAssistantIds` 缺省）⇒ 按新规则仍落在
    //    资料页（没有可复核的名单可去），所以这里不需要先跳页 —— 直接断言资料页两块。
    // 编辑模式仍保留「回答详细程度 / 文件访问方式」两块（首跑已瘦身，编辑不受影响）。
    expect(view.container.textContent).toContain('onboarding.responseDetail');
    expect(view.container.textContent).toContain('onboarding.filePermission');
    // 反转（2026-10-06 收口）：次级「使用基础方案」按钮已删除；编辑模式改点主按钮
    // 「生成我的 AI 团队」——同样跑本地 basic()，按编辑模式直接看结果。
    click(view.container, 'onboarding.firstRun.generate');
    expect(view.container.textContent).toContain('onboarding.firstRun.personaSourceUser');
    expect(view.container.textContent).not.toContain('onboarding.firstRun.personaSourceDefault');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ persona: { id: 'approved-user-character', source: 'user', ruleVersion: null } }),
    );
    view.unmount();
  });

  it.each(['pending', 'settled'] as const)(
    'saves ordinary v3 edits without losing %s stored receipts or manually selected assistants',
    (usageStatus) => {
      const profile = savedAiProfile(usageStatus);
      const onComplete = vi.fn((result: OnboardingProfile) => saveOnboardingProfile(result));
      const view = render(
        <Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={onComplete} />,
      );
      // N1：已确认档案重开落在结果页 ⇒ 先回资料页，再走画像页。
      toProfile(view.container);
      // 四题在「趣味画像」页：进去把第一题改成「否」，其余按原答案走完再回资料页。
      click(view.container, 'onboarding.portrait.editEntry');
      click(view.container, 'onboarding.firstRun.answerNo');
      click(view.container, 'onboarding.firstRun.answerNo');
      click(view.container, 'onboarding.firstRun.questionSkip');
      click(view.container, 'onboarding.firstRun.answerYes');
      // 编辑模式的画像收尾仍回资料页保存（不重算匹配，保住 AI 回执）。
      click(view.container, 'onboarding.portrait.next');
      fill(view.container, '[data-first-run-nickname]', 'Edited nickname');
      fill(view.container, 'input[maxlength="400"]', 'Edited introduction');
      click(view.container, 'onboarding.save');
      expect(onComplete).toHaveBeenCalledTimes(1);
      const result = loadOnboardingProfile('user-1');
      expect(result).toMatchObject({
        nickname: 'Edited nickname',
        introduction: 'Edited introduction',
        questionnaire: { version: 1, answers: ['no', 'no', null, 'yes'] },
        portrait: {
          axes: { 外向力: 20, 探索力: 30, 理性力: 60, 条理力: 70, 共情力: 35 },
          letters: 'INXJ',
          role: 'hengchuan',
          ruleVersion: 'portrait-v1',
          locked: true,
        },
        selectedAssistantIds: ['family', 'research'],
        persona: profile.persona,
        workMatch: profile.workMatch,
      });
      expect(profile.nickname).toBe('Saved nickname');
      view.unmount();
    },
  );

  it('keeps the original receipt version after work fields change without purchasing another suggestion', () => {
    const profile = savedAiProfile();
    const onComplete = vi.fn();
    const view = render(
      <Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={onComplete} />,
    );
    toProfile(view.container);
    industry(view.container, 'C');
    fill(view.container, '[data-first-run-goal]', 'Prepare manufacturing budgets');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledTimes(1);
    const saved = onComplete.mock.calls[0][0] as OnboardingProfile;
    expect(saved.customGoal).toBe('Prepare manufacturing budgets');
    expect(saved.industry?.code).toBe('C');
    expect(saved.workMatch).toEqual(profile.workMatch);
    expect(buildOnboardingWorkMatchInput(saved, 'workspace-a').profileVersion).not.toBe(
      saved.workMatch?.profileVersion,
    );
    expect(saved.selectedAssistantIds).toEqual(['family', 'research']);
    view.unmount();
  });

  it('keeps the locally generated result and manual assistant choices through later profile edits', () => {
    // 反转（2026-10-06 V1 收口）：旧版这里购买的是新的 AI 建议（source=ai）；
    // 生成改本地 basic() 后语义不变——显式生成的结果与手动勾选在后续编辑中不被悄悄还原。
    const profile = savedAiProfile();
    const onComplete = vi.fn();
    const view = render(
      <Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={onComplete} />,
    );
    // N1：重开落在结果页 ⇒ 先回资料页（要复核确认过的名单就留在结果页别按生成）。
    toProfile(view.container);
    // 「使用基础方案」已删除 ⇒ 编辑模式显式生成改点主按钮（本地 basic()，直接看结果）。
    click(view.container, 'onboarding.firstRun.generate');
    act(() => view.container.querySelector<HTMLButtonElement>('[data-assistant="research"]')!.click());
    click(view.container, 'onboarding.firstRun.editProfile');
    fill(view.container, '[data-first-run-nickname]', 'Another nickname');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Another nickname',
        selectedAssistantIds: ['office', 'content'],
        workMatch: expect.objectContaining({ source: 'basic' }),
      }),
    );
    view.unmount();
  });

  it('preserves a saved basic result and user assistant choices on ordinary save', () => {
    const profile: OnboardingProfile = {
      ...savedAiProfile(),
      workMatch: { source: 'basic', profileVersion: 'saved-basic-version' },
    };
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={onComplete} />);
    toProfile(view.container);
    fill(view.container, '[data-first-run-nickname]', 'Basic nickname');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: 'Basic nickname',
        selectedAssistantIds: ['family', 'research'],
        workMatch: profile.workMatch,
      }),
    );
    view.unmount();
  });

  it('keeps a stored portrait on an ordinary edit and re-derives it only after a real retest', () => {
    const stored = {
      axes: { 外向力: 1, 探索力: 2, 理性力: 3, 条理力: 4, 共情力: 5 },
      letters: 'EIST',
      role: 'baina',
      ruleVersion: 'portrait-v0',
      locked: true,
    } satisfies NonNullable<OnboardingProfile['portrait']>;
    const profile: OnboardingProfile = { ...savedAiProfile(), portrait: stored };
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={onComplete} />);
    toProfile(view.container);
    // 没动过四题 ⇒ 原样保留档案里的旧规则画像，不许用当前规则偷偷重算
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect((onComplete.mock.calls[0][0] as OnboardingProfile).portrait).toEqual(stored);
    // 真的重测并走完四题 ⇒ 按本次答案重算，锁到 portrait-v1
    click(view.container, 'onboarding.portrait.editEntry');
    expect(view.container.querySelector('[data-testid="portrait-card"]')?.getAttribute('data-role')).toBe('baina');
    click(view.container, 'onboarding.portrait.retest');
    for (let index = 0; index < 4; index += 1) click(view.container, 'onboarding.firstRun.answerYes');
    click(view.container, 'onboarding.portrait.next');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledTimes(2);
    const saved = onComplete.mock.calls[1][0] as OnboardingProfile;
    expect(saved.portrait).toEqual({
      axes: { 外向力: 80, 探索力: 70, 理性力: 80, 条理力: 80, 共情力: 65 },
      letters: 'ESTJ',
      role: 'hengchuan',
      ruleVersion: 'portrait-v1',
      locked: true,
    });
    expect(saved.questionnaire).toEqual({ version: 1, answers: ['yes', 'yes', 'yes', 'yes'] });
    view.unmount();
  });

  it('keeps ordinary save disabled when the user deselects the last assistant instead of restoring an old choice', () => {
    const onComplete = vi.fn();
    const view = render(
      <Onboarding userId="user-1" mode="edit" initialProfile={savedAiProfile()} onComplete={onComplete} />,
    );
    // 「使用基础方案」已删除 ⇒ 编辑模式显式生成改点主按钮（本地 basic()，直接看结果）。
    // N1：重开落在结果页 ⇒ 主按钮在资料页上，先回资料页再点。
    toProfile(view.container);
    click(view.container, 'onboarding.firstRun.generate');
    // 逐个取消勾选本地推荐助手，直到一个不剩
    const ids = [...view.container.querySelectorAll('[data-assistant]')].map((button) =>
      button.getAttribute('data-assistant'),
    );
    for (const id of ids) {
      const button = view.container.querySelector<HTMLButtonElement>(`[data-assistant="${id}"][aria-pressed="true"]`);
      if (button) act(() => button.click());
    }
    expect(view.container.querySelectorAll('[data-assistant][aria-pressed="true"]')).toHaveLength(0);
    click(view.container, 'onboarding.firstRun.editProfile');
    const save = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent === 'onboarding.save',
    )!;
    expect(save.disabled).toBe(true);
    act(() => {
      save.focus();
      save.click();
    });
    expect(document.activeElement).not.toBe(save);
    expect(onComplete).not.toHaveBeenCalled();
    view.unmount();
  });

  it.each([1, 2] as const)('keeps legacy v%s edits on the existing uncharged save flow', (version) => {
    const profile: OnboardingProfile = {
      version,
      userId: 'user-1',
      nickname: 'Legacy nickname',
      role: 'finance',
      customRole: 'Hotel finance',
      useCases: ['office'],
      customGoal: 'Prepare monthly reports',
      selectedAssistantIds: ['family', 'research'],
      responseDetail: 'balanced',
      filePermission: 'ask-every-time',
      completedAt: '2026-09-30T00:00:00.000Z',
    };
    const onComplete = vi.fn();
    const view = render(<Onboarding userId="user-1" mode="edit" initialProfile={profile} onComplete={onComplete} />);
    click(view.container, 'onboarding.next');
    click(view.container, 'onboarding.next');
    click(view.container, 'onboarding.next');
    click(view.container, 'onboarding.save');
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, selectedAssistantIds: ['family', 'research'] }),
    );
    expect(onComplete.mock.calls[0][0]).not.toHaveProperty('workMatch');
    view.unmount();
  });

  it('shows a save error and preserves the first-run basic draft until a user retry succeeds', () => {
    const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
    const view = render(<Onboarding userId="user-1" onComplete={onComplete} />);
    fill(view.container, '[data-first-run-nickname]', 'First-run nickname');
    fill(view.container, 'input[maxlength="400"]', 'First-run introduction');
    fill(view.container, '[data-first-run-goal]', 'First-run monthly report');
    toPortrait(view.container);
    click(view.container, 'onboarding.firstRun.answerYes');
    click(view.container, 'onboarding.firstRun.answerNo');
    click(view.container, 'onboarding.firstRun.questionSkip');
    click(view.container, 'onboarding.firstRun.questionSkip');
    click(view.container, 'onboarding.portrait.next');
    const manual = view.container.querySelector<HTMLButtonElement>('[data-assistant]')!;
    act(() => manual.click());
    const selected = [...view.container.querySelectorAll('[data-assistant][aria-pressed="true"]')].map((button) =>
      button.getAttribute('data-assistant'),
    );
    const failure = failNextProfileWrite();
    try {
      click(view.container, 'onboarding.firstRun.confirm');
      expect(failure.write).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('teams.wizard.saveError');
      expect(failure.observedErrors).toEqual([]);
      expect(loadOnboardingProfile('user-1')).toBeNull();
      expect(onComplete.mock.calls[0][0]).toMatchObject({
        nickname: 'First-run nickname',
        introduction: 'First-run introduction',
        customGoal: 'First-run monthly report',
        questionnaire: { answers: ['yes', 'no', null, null] },
        selectedAssistantIds: selected,
        workMatch: { source: 'basic' },
      });
      expect(view.container.querySelector('[data-match-source="basic"]')).not.toBeNull();
      click(view.container, 'onboarding.firstRun.confirm');
      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(loadOnboardingProfile('user-1')).toMatchObject({
        nickname: 'First-run nickname',
        introduction: 'First-run introduction',
        customGoal: 'First-run monthly report',
        questionnaire: { answers: ['yes', 'no', null, null] },
        selectedAssistantIds: selected,
      });
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
      click(view.container, 'onboarding.firstRun.editProfile');
      expect(view.container.querySelector<HTMLInputElement>('[data-first-run-nickname]')!.value).toBe(
        'First-run nickname',
      );
      expect(view.container.querySelector<HTMLInputElement>('input[maxlength="400"]')!.value).toBe(
        'First-run introduction',
      );
      expect(view.container.querySelector<HTMLTextAreaElement>('[data-first-run-goal]')!.value).toBe(
        'First-run monthly report',
      );
    } finally {
      failure.restore();
      view.unmount();
    }
  });

  it.each(['pending', 'settled'] as const)(
    'preserves v3 input and the %s stored receipt while a visible save failure is retried',
    (usageStatus) => {
      const original = savedAiProfile(usageStatus);
      saveOnboardingProfile(original);
      const onCancel = vi.fn();
      const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
      const view = render(
        <Onboarding
          userId="user-1"
          mode="edit"
          initialProfile={original}
          onComplete={onComplete}
          onCancel={onCancel}
        />,
      );
      // N1：已确认档案重开落在结果页 ⇒ 先回资料页。
      toProfile(view.container);
      // 四题在「趣味画像」页：Q1 改成「否」，其余按原答案走完，再回资料页改工作资料。
      click(view.container, 'onboarding.portrait.editEntry');
      click(view.container, 'onboarding.firstRun.answerNo');
      click(view.container, 'onboarding.firstRun.answerNo');
      click(view.container, 'onboarding.firstRun.questionSkip');
      click(view.container, 'onboarding.firstRun.answerYes');
      click(view.container, 'onboarding.portrait.next');
      fill(view.container, '[data-first-run-nickname]', 'Unsaved edited nickname');
      fill(view.container, 'input[maxlength="400"]', 'Unsaved introduction');
      fill(view.container, '[data-first-run-goal]', 'Unsaved report goal');
      industry(view.container, 'C');
      const failure = failNextProfileWrite();
      try {
        click(view.container, 'onboarding.save');
        expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('teams.wizard.saveError');
        expect(view.container.querySelector<HTMLInputElement>('[data-first-run-nickname]')!.value).toBe(
          'Unsaved edited nickname',
        );
        expect(view.container.querySelector<HTMLInputElement>('input[maxlength="400"]')!.value).toBe(
          'Unsaved introduction',
        );
        expect(view.container.querySelector<HTMLTextAreaElement>('[data-first-run-goal]')!.value).toBe(
          'Unsaved report goal',
        );
        expect(view.container.querySelector('[data-industry="C"]')!.getAttribute('aria-pressed')).toBe('true');
        expect(loadOnboardingProfile('user-1')).toMatchObject({
          nickname: original.nickname,
          workMatch: original.workMatch,
        });
        expect(onCancel).not.toHaveBeenCalled();
        expect(failure.observedErrors).toEqual([]);
        click(view.container, 'onboarding.save');
        expect(onComplete).toHaveBeenCalledTimes(2);
        expect(loadOnboardingProfile('user-1')).toMatchObject({
          nickname: 'Unsaved edited nickname',
          introduction: 'Unsaved introduction',
          customGoal: 'Unsaved report goal',
          industry: { code: 'C' },
          questionnaire: { answers: ['no', 'no', null, 'yes'] },
          selectedAssistantIds: ['family', 'research'],
          persona: original.persona,
          workMatch: original.workMatch,
        });
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
      } finally {
        failure.restore();
        view.unmount();
      }
    },
  );

  it.each([1, 2] as const)(
    'keeps legacy v%s edit controls and choices after a save error for a real button retry',
    (version) => {
      const original: OnboardingProfile = { ...savedAiProfile(), version, workMatch: undefined };
      saveOnboardingProfile(original);
      const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
      const onCancel = vi.fn();
      const view = render(
        <Onboarding userId="user-1" mode="edit" initialProfile={original} onComplete={onComplete} onCancel={onCancel} />,
      );
      click(view.container, 'onboarding.next');
      fill(view.container, 'textarea', 'Edited legacy goal');
      click(view.container, 'onboarding.next');
      const manual = view.container.querySelector<HTMLButtonElement>('[data-assistant][aria-pressed="false"]')!;
      act(() => manual.click());
      click(view.container, 'onboarding.next');
      fill(view.container, 'input', 'Edited legacy nickname');
      click(view.container, 'onboarding.responseOptions.detailed');
      click(view.container, 'onboarding.fileOptions.task-folder');
      const failure = failNextProfileWrite();
      try {
        click(view.container, 'onboarding.save');
        expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('teams.wizard.saveError');
        expect(view.container.querySelector<HTMLInputElement>('input')!.value).toBe('Edited legacy nickname');
        expect(loadOnboardingProfile('user-1')).toMatchObject({ nickname: original.nickname });
        expect(onCancel).not.toHaveBeenCalled();
        expect(failure.observedErrors).toEqual([]);
        const first = onComplete.mock.calls[0][0];
        expect(first.selectedAssistantIds).toContain(manual.dataset.assistant);
        click(view.container, 'onboarding.save');
        expect(onComplete).toHaveBeenCalledTimes(2);
        expect(loadOnboardingProfile('user-1')).toMatchObject({
          version: 2,
          nickname: 'Edited legacy nickname',
          customGoal: 'Edited legacy goal',
          selectedAssistantIds: first.selectedAssistantIds,
          responseDetail: 'detailed',
          filePermission: 'task-folder',
        });
        expect(view.container.querySelector('[role="alert"]')).toBeNull();
      } finally {
        failure.restore();
        view.unmount();
      }
    },
  );

  it.each(
    (['en', 'zh'] as const).flatMap((language) =>
      (['first-run', 'v3-edit', 'legacy-edit'] as const).map((surface) => ({ language, surface })),
    ),
  )('renders the real $language save error on $surface and allows an explicit retry', async ({ language, surface }) => {
    await i18n.changeLanguage(language);
    translationMode.real = true;
    const initialProfile = surface === 'v3-edit' ? savedAiProfile() : { ...savedAiProfile(), version: 2 as const };
    const onComplete = vi.fn((profile: OnboardingProfile) => saveOnboardingProfile(profile));
    const view = render(
      <Onboarding
        userId="user-1"
        mode={surface === 'first-run' ? 'first-run' : 'edit'}
        initialProfile={surface === 'first-run' ? null : initialProfile}
        onComplete={onComplete}
      />,
    );
    if (surface === 'first-run') {
      // 新流程：资料页选行业 → 主按钮进画像页 → 四题全跳过 → 收尾进结果页。
      industry(view.container, 'H');
      click(view.container, i18n.t('onboarding.firstRun.generate'));
      for (let index = 0; index < 4; index += 1) {
        click(view.container, i18n.t('onboarding.firstRun.questionSkip'));
      }
      click(view.container, i18n.t('onboarding.portrait.next'));
    } else if (surface === 'legacy-edit') {
      for (let step = 0; step < 3; step++) click(view.container, i18n.t('onboarding.next'));
    }
    const saveLabel = i18n.t(surface === 'first-run' ? 'onboarding.firstRun.confirm' : 'onboarding.save');
    const failure = failNextProfileWrite();
    try {
      expect(i18n.exists('teams.wizard.saveError')).toBe(true);
      expect(i18n.exists('team.wizard.saveError')).toBe(false);
      click(view.container, saveLabel);
      const alert = view.container.querySelector('[role="alert"]');
      expect(alert?.textContent).toBe(i18n.t('teams.wizard.saveError'));
      expect(alert?.textContent).not.toBe('teams.wizard.saveError');
      expect(failure.observedErrors).toEqual([]);
      expect(loadOnboardingProfile('user-1')).toBeNull();
      click(view.container, saveLabel);
      expect(onComplete).toHaveBeenCalledTimes(2);
      expect(loadOnboardingProfile('user-1')).toMatchObject({ userId: 'user-1' });
      expect(view.container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      failure.restore();
      view.unmount();
      translationMode.real = false;
      await i18n.changeLanguage('en');
    }
  });
});
