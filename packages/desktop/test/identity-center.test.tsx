// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ⚠️ `t` 也是桩，但要**记下参数** —— 否则"几个助手没写成""上限多少"这些数字
//    在断言里全靠猜（本仓栽过"存在性断言绑不住值"）。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: tSpy }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

// ⚠️ `vi.mock` 的工厂会被提升到文件最上面 ⇒ 里面引用的变量**必须**用 `vi.hoisted`
//    造，否则是 "Cannot access 'toastSpy' before initialization"。
const { toastSpy, selectAgentSpy, getAgentFileSpy, setAgentFileSpy, tSpy, refreshAgentsSpy } = vi.hoisted(() => ({
  toastSpy: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  selectAgentSpy: vi.fn(),
  getAgentFileSpy: vi.fn(),
  setAgentFileSpy: vi.fn(),
  tSpy: vi.fn((key: string, _params?: unknown) => key),
  refreshAgentsSpy: vi.fn<(gatewayId: string, options?: { force?: boolean }) => Promise<void>>(async () => undefined),
}));

vi.mock('@/lib/toast', () => ({ toast: toastSpy }));

/**
 * 切助手那一步**打桩**：真身在 `test/agent-switch.test.ts`（纯逻辑）和实机里验。
 * 保存流程的最后一步会走到它（写完 USER.md → 切回当前助手）。
 */
vi.mock('@/hooks/useSelectAgent', () => ({ useSelectAgent: () => selectAgentSpy }));
vi.mock('@/hooks/useGatewayBootstrap', () => ({ fetchAgentsForGateway: refreshAgentsSpy }));

import IdentityCenter from '../src/renderer/layouts/IdentityCenter';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';
import { IDENTITY_BLOCK_START } from '../src/renderer/lib/identity-persona';
import { useUiStore } from '../src/renderer/stores/uiStore';

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

/** 点一下（包在 act 里，否则 React 的批处理不会 flush）。 */
function click(el: Element | null): void {
  if (!el) throw new Error('要点的元素不存在');
  act(() => {
    (el as HTMLElement).click();
  });
}

/** 等异步的保存流程落定（每个助手两轮 await，助手数量不定 ⇒ 多转几圈）。 */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 40; i += 1) await Promise.resolve();
  });
}

const selectedTagIds = (container: HTMLElement): string[] =>
  [...container.querySelectorAll('[data-tag][data-selected="true"]')].map((el) => el.getAttribute('data-tag') ?? '');

/** 一份最小可用的助手目录：罗盘 + 电商运营（其余助手按需在用例里补）。 */
const catalog = (agents: string[]) => ({
  agents: agents.map((id) => ({ id }) as never),
  defaultId: agents[0] ?? '',
});

beforeEach(() => {
  vi.clearAllMocks();
  refreshAgentsSpy.mockImplementation(async () => undefined);
  window.localStorage.clear();
  /**
   * ⚠️ 桩要忠实于真身：真 `useSelectAgent` 的第一步就是 `setSelectedAgent(...)`，
   * 而"当前助手"读的正是 store 里那个值。桩成空操作 ⇒ 保存流程看不到任何变化。
   */
  selectAgentSpy.mockImplementation((agentId: string) => {
    if (useUiStore.getState().defaultGatewayId) {
      useUiStore.getState().setSelectedAgent('gw-1', agentId);
    }
  });
  // ⚠️ 真机载荷是 `{ agentId, workspace, file: AgentFileEntry }`（白皮书 / preset-agent-installer
  //    / AgentsSection / TeamDetailView 四处都是 `result.file.content`）。以前这里桩成
  //    `{content}` —— 错位的形状让"覆盖用户记忆"那条路测不出来（2026-10-07 体检最大盲区）。
  getAgentFileSpy.mockResolvedValue({ ok: true, result: { file: { name: 'USER.md', content: '', missing: false } } });
  setAgentFileSpy.mockResolvedValue({ ok: true });
  Object.assign(window, {
    clawwork: { getAgentFile: getAgentFileSpy, setAgentFile: setAgentFileSpy },
  });
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    mainView: 'identity',
    agentCatalogByGateway: { 'gw-1': catalog(['main', 'partner-w-ecommerce', 'partner-w-office']) },
    selectedAgentByGateway: { 'gw-1': 'main' },
  });
});

/**
 * 个性化中心（v3，2026-10-06；原名「身份中心」）。
 *
 * 为什么要改：六个预置能力（内容/拍摄/办公/电商/研究/家庭）是 **Skill，不是身份**。
 * v2 把它们做成了七张可点的客群卡（"选客群 = 选身份"，点卡片还会切助手）——这一版
 * 整块拿掉，页面变成五个只读/半只读区块：我的画像 / 我的工作身份 / 我的 AI 团队 /
 * 我的常用技能 / 我的偏好。
 *
 * ⇒ 断言跟着换：**没有 [data-group] 这种"身份选择"锚点**，技能标签全是不可点的 span；
 *   保住的既有行为（写各助手 USER.md、缺助手不静默换人）继续钉死。
 */
describe('个性化中心 — 五个区块', () => {
  it('渲染标题、底部固定栏；区块是 画像/工作身份/团队/技能/偏好 五块', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const text = container.textContent ?? '';

    expect(container.querySelector('[data-testid="identity-center"]')).toBeTruthy();
    expect(text).toContain('identity.title');
    expect(text).toContain('identity.save');
    const sections = [...container.querySelectorAll('[data-section]')].map((el) => el.getAttribute('data-section'));
    expect(sections).toEqual(['profile', 'work', 'team', 'skills', 'preferences']);
    unmount();
  });

  it('① 没有画像档案时显示空态（旧账号不受影响）', () => {
    const { container, unmount } = render(<IdentityCenter />);
    expect(container.querySelector('[data-field="portrait"]')).toBeNull();
    expect(container.querySelector('[data-testid="portrait-radar"]')).toBeNull();
    expect(container.querySelector('[data-field="portrait-empty"]')?.textContent).toBe('identity.profileEmpty');
    unmount();
  });

  it('① 有档案时立绘、角色名/描述、四字码与五维雷达都在', () => {
    const { container, unmount } = render(<IdentityCenter profile={portraitProfile()} />);
    const card = container.querySelector('[data-field="portrait"]');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('data-portrait-role')).toBe('zhenshan');
    expect(container.querySelector('[data-portrait-artwork]')).not.toBeNull();
    expect(container.querySelector('[data-portrait-role-name]')?.textContent).toBe(
      'onboarding.portrait.roles.zhenshan.name',
    );
    expect(card?.textContent).toContain('onboarding.portrait.roles.zhenshan.description');
    expect(container.querySelector('[data-portrait-letters]')?.textContent).toBe('ESTJ');
    const scores = [...card!.querySelectorAll('[data-testid="portrait-radar"] circle[data-score]')].map((el) =>
      el.getAttribute('data-score'),
    );
    expect(scores).toEqual(['80', '70', '80', '80', '65']);
    unmount();
  });

  it('① 未作答的字母位显示为 ?，不冒充完整四字码', () => {
    const profile = portraitProfile();
    const { container, unmount } = render(
      <IdentityCenter profile={{ ...profile, portrait: { ...profile.portrait!, letters: 'ENXJ' } }} />,
    );
    expect(container.querySelector('[data-portrait-letters]')?.textContent).toBe('EN?J');
    unmount();
  });

  it('① 完整四字码 + 性别 ⇒ 形象位画 16 型**全身卡**（不是小圆头像）', () => {
    const profile = portraitProfile();
    const mbti = render(
      <IdentityCenter
        profile={{ ...profile, portrait: { ...profile.portrait!, letters: 'ESTJ', gender: 'female' } }}
      />,
    );
    const img = mbti.container.querySelector('[data-mbti-artwork]')!;
    expect(img.getAttribute('src')).toContain('mbti-ESTJ-f.webp');
    // ⚠️ 用户实测反馈（2026-10-08）：这里不许是 256 的圆头像（-avatar）——本区要完整角色
    expect(img.getAttribute('src')).not.toContain('-avatar');
    expect(img.className).not.toContain('rounded-full');
    expect(mbti.container.querySelector('[data-mbti-avatar]')).toBeNull();
    expect(mbti.container.querySelector('[data-portrait-artwork]')).toBeNull();
    expect(mbti.container.querySelector('[data-portrait-fallback]')).toBeNull();
    expect(mbti.container.querySelector('[data-field="portrait"]')?.getAttribute('data-artwork-source')).toBe('mbti');
    mbti.unmount();
  });

  it('① 半份画像 / 缺性别 / 缺图 ⇒ 逐级退回（六立绘 → 占位）', () => {
    const profile = portraitProfile();
    // 半份画像（含跳过位）+ 有性别 ⇒ 不许硬凑 16 型形象，退回六角色立绘
    const partial = render(
      <IdentityCenter profile={{ ...profile, portrait: { ...profile.portrait!, letters: 'ENXJ', gender: 'male' } }} />,
    );
    expect(partial.container.querySelector('[data-mbti-artwork]')).toBeNull();
    expect(partial.container.querySelector('[data-portrait-artwork]')?.getAttribute('src')).toContain(
      'persona-zhenshan',
    );
    expect(partial.container.querySelector('[data-field="portrait"]')?.getAttribute('data-artwork-source')).toBe(
      'persona',
    );
    partial.unmount();

    // 四字码完整但没选性别 ⇒ 同样退回立绘（旧档案：一个新键都没有）
    const legacy = render(<IdentityCenter profile={portraitProfile()} />);
    expect(legacy.container.querySelector('[data-mbti-artwork]')).toBeNull();
    expect(legacy.container.querySelector('[data-portrait-artwork]')?.getAttribute('src')).toContain(
      'persona-zhenshan',
    );
    legacy.unmount();

    // 两张素材都坏（真机 = 图没了/内容坏）⇒ 占位文案，不许破图
    const broken = render(
      <IdentityCenter
        profile={{ ...profile, portrait: { ...profile.portrait!, letters: 'ESTJ', gender: 'female' } }}
      />,
    );
    act(() => broken.container.querySelector('[data-mbti-artwork]')!.dispatchEvent(new Event('error')));
    // 一级降级：16 型卡坏 ⇒ 退回六角色立绘
    expect(broken.container.querySelector('[data-mbti-artwork]')).toBeNull();
    expect(broken.container.querySelector('[data-portrait-artwork]')?.getAttribute('src')).toContain(
      'persona-zhenshan',
    );
    act(() => broken.container.querySelector('[data-portrait-artwork]')!.dispatchEvent(new Event('error')));
    // 二级降级：立绘也坏 ⇒ 占位
    expect(broken.container.querySelector('[data-portrait-fallback]')?.textContent).toContain(
      'onboarding.firstRun.personaUnavailable',
    );
    expect(broken.container.querySelector('[data-field="portrait"]')?.getAttribute('data-artwork-source')).toBe(
      'placeholder',
    );
    broken.unmount();
  });

  it('② 工作身份读 nickname / 岗位 / 主营行业；缺项显示 —', () => {
    const { container, unmount } = render(<IdentityCenter profile={portraitProfile()} />);
    expect(container.querySelector('[data-field="nickname"]')?.textContent).toBe('王老板');
    expect(container.querySelector('[data-field="job-role"]')?.textContent).toBe('onboarding.roles.operations.title');
    expect(container.querySelector('[data-field="industry"]')?.textContent).toBe('onboarding.firstRun.industries.C');
    unmount();

    const { container: bare, unmount: unmountBare } = render(<IdentityCenter />);
    expect(bare.querySelector('[data-field="nickname"]')?.textContent).toBe('—');
    expect(bare.querySelector('[data-field="job-role"]')?.textContent).toBe('—');
    expect(bare.querySelector('[data-field="industry"]')?.textContent).toBe('—');
    unmountBare();
  });

  it('② 也把首跑的「一句话介绍」读回来（问题 11：以前只写不读）', () => {
    const { container, unmount } = render(
      <IdentityCenter profile={{ ...portraitProfile(), introduction: '做小家电的' }} />,
    );
    expect(container.querySelector('[data-field="introduction"]')?.textContent).toBe('做小家电的');
    unmount();

    const { container: bare, unmount: unmountBare } = render(<IdentityCenter profile={portraitProfile()} />);
    expect(bare.querySelector('[data-field="introduction"]')?.textContent).toBe('—');
    unmountBare();
  });

  it('③ 团队 = 主罗盘 + 五岗位静态名单（没有可点的成员）', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const team = container.querySelector('[data-section="team"]');
    expect(team?.querySelector('[data-team-member="main"]')?.textContent).toContain('mainArea.compassAssistant');
    expect(team?.querySelector('[data-team-member="main"]')?.textContent).toContain('identity.teamLead');
    const positions = [...team!.querySelectorAll('[data-team-position]')].map((el) =>
      el.getAttribute('data-team-position'),
    );
    expect(positions).toEqual(['researcher', 'analyst', 'creator', 'producer', 'inspector']);
    expect(team?.querySelectorAll('button')).toHaveLength(0);
    unmount();
  });

  it('④ 常用技能 = 六类能力 × 每条四个技能标签，全是不可点的 span', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const skills = container.querySelector('[data-section="skills"]');
    const groups = [...skills!.querySelectorAll('[data-skill-group]')].map((el) => el.getAttribute('data-skill-group'));
    expect(groups).toEqual(['content', 'video', 'office', 'ecommerce', 'research', 'family']);
    const tags = [...skills!.querySelectorAll('[data-skill]')];
    expect(tags).toHaveLength(24);
    expect(tags.every((tag) => tag.tagName === 'SPAN')).toBe(true);
    expect(skills?.querySelectorAll('button')).toHaveLength(0);
    // 技能块里出现的是各助手的真实可做项（第 1 组第 1 条 = 内容创作的选题策划）
    expect(skills?.textContent).toContain('assistantWorkspaces.content.starters.1.title');
    unmount();
  });

  it('⭐ 页面里没有"身份选择"锚点：不存在 [data-group] 这类可选身份卡', () => {
    const { container, unmount } = render(<IdentityCenter profile={portraitProfile()} />);
    expect(container.querySelectorAll('[data-group]')).toHaveLength(0);
    expect(container.querySelector('[data-action="new-task-with-agent"]')).toBeNull();
    // 除编辑入口/保存/偏好三个按钮外，不该有别的交互控件
    const actions = [...container.querySelectorAll('button')].map((el) => el.getAttribute('data-action'));
    expect(actions.filter(Boolean).sort()).toEqual(['reset', 'save', 'shuffle']);
    unmount();
  });

  it('⑤ 偏好：共 5 个标签、默认 4 个选中；点未选的选上，再点一下取消', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const tags = container.querySelectorAll('[data-tag]');
    expect(tags).toHaveLength(5);
    expect(selectedTagIds(container)).toEqual(['goalOriented', 'efficiency', 'logical', 'reporting']);

    click(container.querySelector('[data-tag="timeManagement"]'));
    expect(selectedTagIds(container)).toEqual(['goalOriented', 'efficiency', 'logical', 'reporting', 'timeManagement']);

    click(container.querySelector('[data-tag="goalOriented"]'));
    expect(selectedTagIds(container)).toEqual(['efficiency', 'logical', 'reporting', 'timeManagement']);
    unmount();
  });

  it('⑤「重新选择」清空全部选中；「换一个标签」整体轮换一格（可预期）', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="reset"]'));
    expect(selectedTagIds(container)).toEqual([]);

    click(container.querySelector('[data-action="shuffle"]'));
    expect(selectedTagIds(container)).toEqual(['goalOriented', 'efficiency', 'logical', 'reporting']);

    click(container.querySelector('[data-action="shuffle"]'));
    // ⚠️ 断言按 **DOM 顺序**（标签的排列固定），不是数组内部顺序
    expect(selectedTagIds(container)).toEqual(['efficiency', 'logical', 'reporting', 'timeManagement']);
    unmount();
  });

  it('「编辑我的资料」入口：传了回调才渲染，点它真的回调', () => {
    const onEditProfile = vi.fn();
    const { container, unmount } = render(<IdentityCenter profile={portraitProfile()} onEditProfile={onEditProfile} />);
    click(container.querySelector('[data-action="edit-profile"]'));
    expect(onEditProfile).toHaveBeenCalledTimes(1);
    unmount();

    const { container: bare, unmount: unmountBare } = render(<IdentityCenter />);
    expect(bare.querySelector('[data-action="edit-profile"]')).toBeNull();
    unmountBare();
  });
});

/**
 * 底部「保存并应用」= 把身份**写进助手的记忆**（`USER.md`，运行时每轮都读它）。
 * v3 换版式但**没动这条**：各读各的、各写各的，超限/部分失败如实报，缺助手不静默换人。
 */
describe('个性化中心 — 保存并应用（既有行为不破）', () => {
  it('⭐「保存并应用」把身份块合并写进每个助手的 USER.md，且不覆盖已有记忆', async () => {
    getAgentFileSpy.mockResolvedValue({
      ok: true,
      result: { file: { name: 'USER.md', content: '用户自己写的：喜欢短句', missing: false } },
    });
    const { container, unmount } = render(<IdentityCenter profile={portraitProfile()} />);

    click(container.querySelector('[data-tag="timeManagement"]'));
    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(selectAgentSpy).toHaveBeenCalledWith('main');
    // 三个助手各读各的、各写各的（读别人的再写过去会把别人的记忆冲掉）
    expect(getAgentFileSpy).toHaveBeenCalledTimes(3);
    expect(setAgentFileSpy).toHaveBeenCalledTimes(3);

    const written = setAgentFileSpy.mock.calls[0]?.[3] as string;
    // 🔴 2026-10-07 体检问题 1 的核心断言：读入口错位时这里会是**只有身份块**
    expect(written).toContain('用户自己写的：喜欢短句');
    expect(written).toContain(IDENTITY_BLOCK_START);
    expect(written).toContain('identity.tag.timeManagement');
    // 手写内容在前、身份块在后（合并，不是覆盖）
    expect(written.indexOf('用户自己写的：喜欢短句')).toBeLessThan(written.indexOf(IDENTITY_BLOCK_START));
    expect(tSpy, '数字要被绑住：三个助手都写成了').toHaveBeenCalledWith('settings.memorySaved', { count: 3 });
    expect(toastSpy.success).toHaveBeenCalledWith('settings.memorySaved');
    unmount();
  });

  it('⭐「客群」写的是用户自己的行业·岗位（不是当前助手名），首跑介绍也进身份块（问题 10/11）', async () => {
    const { container, unmount } = render(
      <IdentityCenter profile={{ ...portraitProfile(), introduction: '做小家电的' }} />,
    );

    click(container.querySelector('[data-action="save"]'));
    await flush();

    const written = setAgentFileSpy.mock.calls[0]?.[3] as string;
    expect(written).toContain('onboarding.firstRun.industries.C');
    expect(written).toContain('onboarding.roles.operations.title');
    expect(written).toContain('- 介绍：做小家电的');
    // 旧实现会在这里写 'mainArea.compassAssistant'（当前助手名）
    expect(written).not.toContain('mainArea.compassAssistant');
    unmount();
  });

  it('⭐ 没有档案时「客群」如实写 common.notConfigured，不拿助手名顶上', async () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    const written = setAgentFileSpy.mock.calls[0]?.[3] as string;
    expect(written).toContain('common.notConfigured');
    expect(written).not.toContain('mainArea.compassAssistant');
    unmount();
  });

  it('🔴 读失败 ⇒ 不许当成空文件写回（问题 2）：计入失败、跳过这个助手', async () => {
    getAgentFileSpy.mockResolvedValueOnce({ ok: false, error: 'gateway down' });
    getAgentFileSpy.mockResolvedValue({
      ok: true,
      result: { file: { name: 'USER.md', content: '用户自己写的', missing: false } },
    });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    // 三个助手：一个读失败 ⇒ 只写了两个，并按"部分失败"如实报
    expect(setAgentFileSpy).toHaveBeenCalledTimes(2);
    expect(tSpy).toHaveBeenCalledWith('settings.memorySavePartial', { failed: 1, total: 3 });
    expect(toastSpy.error).toHaveBeenCalledWith('settings.memorySavePartial');
    expect(toastSpy.success).not.toHaveBeenCalled();
    unmount();
  });

  it('🔴 载荷形状不对（旧代码恒读空串的那种）⇒ 同样当读失败，绝不写回', async () => {
    getAgentFileSpy.mockResolvedValue({ ok: true, result: { content: '被错位的字段' } });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(setAgentFileSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('settings.memorySavePartial');
    unmount();
  });

  it('⭐ 标签选择会回读（问题 4）：保存过 timeManagement，重进页面它还是选中的', async () => {
    const first = render(<IdentityCenter profile={portraitProfile()} />);
    click(first.container.querySelector('[data-tag="timeManagement"]'));
    click(first.container.querySelector('[data-action="save"]'));
    await flush();
    expect(selectAgentSpy).toHaveBeenCalled();
    first.unmount();

    const second = render(<IdentityCenter profile={portraitProfile()} />);
    expect(selectedTagIds(second.container)).toEqual([
      'goalOriented',
      'efficiency',
      'logical',
      'reporting',
      'timeManagement',
    ]);
    second.unmount();

    // 另一个账号读不到这个缓存 ⇒ 回默认四个（换账号不串）
    const other = render(<IdentityCenter profile={{ ...portraitProfile(), userId: 'user-2' }} />);
    expect(selectedTagIds(other.container)).toEqual(['goalOriented', 'efficiency', 'logical', 'reporting']);
    other.unmount();
  });

  it('⚠️ 部分失败时不记标签缓存（下次回读不撒谎）', async () => {
    setAgentFileSpy.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, error: 'boom' });
    const first = render(<IdentityCenter profile={portraitProfile()} />);
    click(first.container.querySelector('[data-tag="timeManagement"]'));
    click(first.container.querySelector('[data-action="save"]'));
    await flush();
    first.unmount();

    const second = render(<IdentityCenter profile={portraitProfile()} />);
    expect(selectedTagIds(second.container)).toEqual(['goalOriented', 'efficiency', 'logical', 'reporting']);
    second.unmount();
  });

  it('⚠️ 一个标签都没选就保存 ⇒ 不切助手、不写记忆，如实报错', async () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="reset"]'));
    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(selectAgentSpy).not.toHaveBeenCalled();
    expect(setAgentFileSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('identity.needTag');
    expect(toastSpy.success).not.toHaveBeenCalled();
    unmount();
  });

  it('⚠️ 没有网关 ⇒ 不切助手、不写记忆，如实报错（不假装成功）', async () => {
    useUiStore.setState({ defaultGatewayId: null });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(selectAgentSpy).not.toHaveBeenCalled();
    expect(setAgentFileSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('identity.applyFailed');
    unmount();
  });

  it('⚠️ 部分助手写失败 ⇒ 说清几个没写成，不许报"已保存"', async () => {
    setAgentFileSpy
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, error: 'boom' })
      .mockResolvedValueOnce({ ok: false, error: 'boom' });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(tSpy, '要说清几个没写成').toHaveBeenCalledWith('settings.memorySavePartial', { failed: 2, total: 3 });
    expect(toastSpy.error).toHaveBeenCalledWith('settings.memorySavePartial');
    expect(toastSpy.success).not.toHaveBeenCalled();
    unmount();
  });

  it('⚠️ 合并后会超出 USER.md 上限 ⇒ 一个字都不写，如实报上限', async () => {
    getAgentFileSpy.mockResolvedValue({
      ok: true,
      result: { file: { name: 'USER.md', content: 'x'.repeat(3990), missing: false } },
    });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(setAgentFileSpy).not.toHaveBeenCalled();
    expect(tSpy, '上限的数字要被绑住').toHaveBeenCalledWith('settings.memoryTooLong', { max: 4000 });
    expect(toastSpy.error).toHaveBeenCalledWith('settings.memoryTooLong');
    unmount();
  });

  it('⚠️ 盘上一个助手都没有 ⇒ 不写、如实说', async () => {
    useUiStore.setState({ defaultGatewayId: 'gw-1', agentCatalogByGateway: { 'gw-1': catalog([]) } });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(setAgentFileSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('settings.memoryNoAgents');
    unmount();
  });

  it('⭐ 目录已加载但当前助手不在里面 ⇒ 不静默换人、如实说明（已装的助手照写）', async () => {
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      mainView: 'identity',
      agentCatalogByGateway: { 'gw-1': catalog(['main']) },
      selectedAgentByGateway: { 'gw-1': 'partner-w-ecommerce' },
    });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(selectAgentSpy, '不许静默换人').not.toHaveBeenCalled();
    expect(container.textContent, '要如实说明').toContain('agent.missingTitle');
    // 写入是**每个已装助手各写各的**（缺失的是"当前助手"这层身份，不是记忆本身）
    expect(setAgentFileSpy).toHaveBeenCalledTimes(1);
    expect(setAgentFileSpy.mock.calls[0]?.[1]).toBe('main');
    // ⚠️ 2026-10-07 体检问题 12a：applyPersona 说了没切成 ⇒ **不许**报"已保存"
    expect(toastSpy.success).not.toHaveBeenCalled();
    unmount();
  });

  it('⭐ 目录还没拉回来 ⇒ 先强制刷新一次再判有没有助手，不误报缺失', async () => {
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: {},
      selectedAgentByGateway: { 'gw-1': 'main' },
    });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(refreshAgentsSpy, 'loading 不是"没有助手"').toHaveBeenCalledWith('gw-1', { force: true });
    expect(selectAgentSpy).not.toHaveBeenCalled();
    expect(setAgentFileSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('settings.memoryNoAgents');
    expect(container.textContent, '目录未加载时不许判缺失').not.toContain('agent.missingTitle');
    unmount();
  });

  it('⭐ 刷新后目录回来了：照常写、照常应用', async () => {
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: {},
      selectedAgentByGateway: { 'gw-1': 'main' },
    });
    refreshAgentsSpy.mockImplementationOnce(async () => {
      useUiStore.setState({ agentCatalogByGateway: { 'gw-1': catalog(['main', 'partner-w-office']) } });
    });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(setAgentFileSpy).toHaveBeenCalledTimes(2);
    expect(selectAgentSpy).toHaveBeenCalledWith('main');
    expect(toastSpy.success).toHaveBeenCalledWith('settings.memorySaved');
    unmount();
  });
});

/** 3a 趣味画像档案夹具：四题全答、role=zhenshan。 */
function portraitProfile(): OnboardingProfile {
  return {
    version: 3,
    userId: 'user-1',
    nickname: '王老板',
    role: 'operations',
    useCases: ['content'],
    customGoal: '',
    completedAt: '2026-10-05T00:00:00.000Z',
    industry: { code: 'C', generalConfirmed: false, source: 'user', catalogVersion: 1 },
    portrait: {
      axes: { 外向力: 80, 探索力: 70, 理性力: 80, 条理力: 80, 共情力: 65 },
      letters: 'ESTJ',
      role: 'zhenshan',
      ruleVersion: 'portrait-v1',
      locked: true,
    },
  };
}
