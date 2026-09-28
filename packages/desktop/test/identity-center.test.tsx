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
const { toastSpy, selectAgentSpy, getAgentFileSpy, setAgentFileSpy, tSpy } = vi.hoisted(() => ({
  toastSpy: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  selectAgentSpy: vi.fn(),
  getAgentFileSpy: vi.fn(),
  setAgentFileSpy: vi.fn(),
  tSpy: vi.fn((key: string, _params?: unknown) => key),
}));

vi.mock('@/lib/toast', () => ({ toast: toastSpy }));

/**
 * 切助手那一步**打桩**：真身在 `test/agent-switch.test.ts`（纯逻辑）和实机里验。
 * 这里只问一件事 —— 按钮按下去**有没有走到切助手**，以及带的是哪个助手。
 */
vi.mock('@/hooks/useSelectAgent', () => ({ useSelectAgent: () => selectAgentSpy }));

import IdentityCenter from '../src/renderer/layouts/IdentityCenter';
import { IDENTITY_BLOCK_START } from '../src/renderer/lib/identity-persona';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { useTaskStore } from '../src/renderer/stores/taskStore';

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

const personaText = (container: HTMLElement): string =>
  container.querySelector('[data-field="persona"]')?.textContent ?? '';

/** 一份最小可用的助手目录：罗盘 + 电商运营（其余助手按需在用例里补）。 */
const catalog = (agents: string[]) => ({
  agents: agents.map((id) => ({ id }) as never),
  defaultId: agents[0] ?? '',
});

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  /**
   * ⚠️ 桩要忠实于真身：真 `useSelectAgent` 的**第一步**就是
   * `setSelectedAgent(gatewayId, agentId)`（见 `hooks/useSelectAgent.ts`），
   * 而这一页的"当前客群"读的正是 store 里那个值。桩成空操作 ⇒ 点了卡片页面上什么都不变
   * ——那是**夹具**在骗人，不是组件坏了（第一版这 7 条就是这么假红的）。
   */
  selectAgentSpy.mockImplementation((agentId: string) => {
    if (useUiStore.getState().defaultGatewayId) {
      useUiStore.getState().setSelectedAgent('gw-1', agentId);
    }
  });
  getAgentFileSpy.mockResolvedValue({ ok: true, result: { content: '' } });
  setAgentFileSpy.mockResolvedValue({ ok: true });
  Object.assign(window, {
    clawwork: { getAgentFile: getAgentFileSpy, setAgentFile: setAgentFileSpy },
  });
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    mainView: 'identity',
    agentCatalogByGateway: { 'gw-1': catalog(['main', 'rongying-ecommerce', 'rongying-office']) },
    selectedAgentByGateway: { 'gw-1': 'main' },
  });
});

/**
 * 身份中心 v2（2026-09-26）。
 *
 * 为什么要改：用户真机反馈「身份中心里面改不了，重新选择、换标签这些点击没反应」。
 * 真机复现（CDP 真实鼠标事件）的结论是 —— **不是事件坏了**：五个标签、重新选择、
 * 换一个标签、应用、保存**全都真的执行**；坏的是**页面承诺的事一件都没发生**：
 * 客群卡是死的（`cursor:auto`、无 onClick）、推荐技能是编的、画像文案是常量。
 *
 * ⇒ 所以这里的断言从"有没有 handler"升级成"**点下去世界有没有变**"，
 *   尤其是那四条 ⭐：客群能换、画像会变、保存真的写进助手记忆、超限如实拒绝。
 */
describe('IdentityCenter — 版式不变量', () => {
  it('渲染标题、卡片标题与底部固定栏', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const text = container.textContent ?? '';

    expect(container.querySelector('[data-testid="identity-center"]')).toBeTruthy();
    expect(text).toContain('identity.title');
    expect(text).toContain('identity.cardTitle');
    expect(text).toContain('identity.save');
    unmount();
  });

  it('人群画像标签组合：共 5 个，其中恰好 4 个是选中态', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const tags = container.querySelectorAll('[data-tag]');

    expect(tags).toHaveLength(5);
    expect(selectedTagIds(container)).toEqual(['goalOriented', 'efficiency', 'logical', 'reporting']);
    const unselected = [...tags].filter((el) => el.getAttribute('data-selected') === 'false');
    expect(unselected.map((el) => el.getAttribute('data-tag'))).toEqual(['timeManagement']);
    unmount();
  });

  it('⭐ 客群卡是**真实助手**（7 个），不是设计稿上编出来的角色', () => {
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: { 'gw-1': catalog(['main']) },
    });
    const { container, unmount } = render(<IdentityCenter />);
    const groups = [...container.querySelectorAll('[data-group]')].map((el) => el.getAttribute('data-group'));

    expect(groups).toEqual([
      'main',
      'rongying-content',
      'rongying-video',
      'rongying-office',
      'rongying-ecommerce',
      'rongying-research',
      'rongying-family',
    ]);
    // 客群卡必须是**能点的按钮**（真机上死卡的形状是 div + cursor:auto）
    expect(container.querySelector('[data-group="main"]')?.tagName).toBe('BUTTON');
    unmount();
  });

  it('推荐角色与推荐技能来自**当前选区**（不是写死的"高效办公"）', () => {
    const { container, unmount } = render(<IdentityCenter />);
    expect(container.querySelector('[data-field="role"]')?.textContent).toBe('mainArea.compassAssistant');

    click(container.querySelector('[data-group="rongying-ecommerce"]'));

    expect(container.querySelector('[data-field="role"]')?.textContent).toBe('presetAgents.roles.ecommerce');
    const skills = container.querySelector('[data-field="skills"]');
    expect(skills?.children).toHaveLength(4);
    expect(skills?.textContent).toContain('assistantWorkspaces.ecommerce.starters.1.title');
    unmount();
  });
});

describe('IdentityCenter — 按钮真的干活', () => {
  it('⭐ 点标签：点未选的选上，再点一下取消', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-tag="timeManagement"]'));
    expect(selectedTagIds(container)).toEqual(['goalOriented', 'efficiency', 'logical', 'reporting', 'timeManagement']);

    click(container.querySelector('[data-tag="goalOriented"]'));
    expect(selectedTagIds(container)).toEqual(['efficiency', 'logical', 'reporting', 'timeManagement']);
    unmount();
  });

  it('「重新选择」清空全部选中（一个都不剩）', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="reset"]'));
    expect(selectedTagIds(container)).toEqual([]);
    expect(container.querySelectorAll('[data-tag]')).toHaveLength(5);
    unmount();
  });

  it('⭐「换一个标签」整体轮换一格（不是随机 —— 连点两次结果可预期）', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="shuffle"]'));
    expect(selectedTagIds(container)).toEqual(['efficiency', 'logical', 'reporting', 'timeManagement']);

    click(container.querySelector('[data-action="shuffle"]'));
    expect(selectedTagIds(container)).toEqual(['goalOriented', 'logical', 'reporting', 'timeManagement']);
    unmount();
  });

  /**
   * ⭐⭐ 这一条就是用户反馈的形状：**点下去必须看得见变化**。
   * 上一版五个标签点下去只改自己的高亮，画像正文一个字不变 —— 用户的原话是"没反应"。
   */
  it('⭐ 点标签 ⇒ 画像正文跟着变（不是只改自己的高亮）', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const before = personaText(container);
    expect(before).not.toBe('');

    click(container.querySelector('[data-tag="timeManagement"]'));
    const afterAdd = personaText(container);
    expect(afterAdd, '选中一个标签后正文必须变').not.toBe(before);

    click(container.querySelector('[data-action="reset"]'));
    const afterReset = personaText(container);
    expect(afterReset, '清空标签后正文必须再变一次').not.toBe(afterAdd);
    unmount();
  });

  it('⭐ 换客群 ⇒ 画像、推荐角色、推荐技能一起变', () => {
    const { container, unmount } = render(<IdentityCenter />);
    const before = personaText(container);

    click(container.querySelector('[data-group="rongying-office"]'));

    expect(personaText(container)).not.toBe(before);
    expect(container.querySelector('[data-field="role"]')?.textContent).toBe('presetAgents.roles.office');
    unmount();
  });

  it('⭐ 点客群卡真的切助手，且**留在身份中心**（不是把用户甩进对话页）', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-group="rongying-ecommerce"]'));

    expect(selectAgentSpy).toHaveBeenCalledWith('rongying-ecommerce');
    expect(useUiStore.getState().mainView, '选完要留在这一页').toBe('identity');
    // ⚠️ 而且必须落在 store 里 —— 左侧「我的助手」与这一页读的是同一份状态
    expect(useUiStore.getState().selectedAgentByGateway['gw-1']).toBe('rongying-ecommerce');
    unmount();
  });

  it('⭐「应用此画像」切到**当前选中的客群**（不再写死高效办公）并报成功', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-group="rongying-ecommerce"]'));
    selectAgentSpy.mockClear();
    click(container.querySelector('[data-action="apply"]'));

    expect(selectAgentSpy).toHaveBeenCalledWith('rongying-ecommerce');
    expect(toastSpy.success).toHaveBeenCalledWith('identity.appliedToast');
    unmount();
  });

  it('⚠️ 一个标签都没选就点「应用」⇒ 不切助手、不写记忆，如实报错', async () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="reset"]'));
    click(container.querySelector('[data-action="apply"]'));
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

    click(container.querySelector('[data-action="apply"]'));
    await flush();

    expect(selectAgentSpy).not.toHaveBeenCalled();
    expect(setAgentFileSpy).not.toHaveBeenCalled();
    expect(toastSpy.error).toHaveBeenCalledWith('identity.applyFailed');
    unmount();
  });

  /**
   * ⭐⭐ 保存 = 把身份**写进助手的记忆**（`USER.md`，运行时每轮都读它）。
   * 这是"保存"唯一真实的效果 —— 上一版只写 localStorage，用户看不见任何变化。
   */
  it('⭐「保存并应用」把身份块合并写进每个助手的 USER.md，且不覆盖已有记忆', async () => {
    getAgentFileSpy.mockResolvedValue({ ok: true, result: { content: '用户自己写的：喜欢短句' } });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-tag="timeManagement"]'));
    click(container.querySelector('[data-action="save"]'));
    await flush();

    expect(selectAgentSpy).toHaveBeenCalledWith('main');
    // 三个助手各读各的、各写各的（读别人的再写过去会把别人的记忆冲掉）
    expect(getAgentFileSpy).toHaveBeenCalledTimes(3);
    expect(setAgentFileSpy).toHaveBeenCalledTimes(3);

    const written = setAgentFileSpy.mock.calls[0]?.[3] as string;
    expect(written).toContain('用户自己写的：喜欢短句');
    expect(written).toContain(IDENTITY_BLOCK_START);
    expect(written).toContain('identity.tag.timeManagement');
    expect(tSpy, '数字要被绑住：三个助手都写成了').toHaveBeenCalledWith('settings.memorySaved', { count: 3 });
    expect(toastSpy.success).toHaveBeenCalledWith('settings.memorySaved');
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
    getAgentFileSpy.mockResolvedValue({ ok: true, result: { content: 'x'.repeat(3990) } });
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

  it('⭐ 目录已加载但当前客群不在里面 ⇒ 如实说明、不静默换人、不假装成功', async () => {
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      mainView: 'identity',
      agentCatalogByGateway: { 'gw-1': catalog(['main']) },
      selectedAgentByGateway: { 'gw-1': 'rongying-ecommerce' },
    });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="apply"]'));
    await flush();

    expect(selectAgentSpy, '不许静默换人').not.toHaveBeenCalled();
    expect(toastSpy.success, '不许假装成功').not.toHaveBeenCalled();
    expect(container.textContent, '要如实说明').toContain('agent.missingTitle');
    unmount();
  });

  it('⭐ 目录还没拉回来时走老路：照常切，且不许说"不在本机"', async () => {
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: {},
      selectedAgentByGateway: { 'gw-1': 'main' },
    });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="apply"]'));
    await flush();

    expect(selectAgentSpy).toHaveBeenCalledWith('main');
    expect(container.textContent, '目录未加载时不许判缺失').not.toContain('agent.missingTitle');
    unmount();
  });
});

/**
 * ⭐ 客群卡与「新建任务」打通（0.0.35 账本 §六-3）。
 *
 * 原来这一页只能**切助手**，开不了任务 —— 用户挑好了助手，还得自己回左侧点一次
 * 「新任务」才用得上。
 *
 * ⚠️ 但**卡片本身仍然只切不甩人**（见 `chooseGroup` 的注释：用户是在挑，不是在开任务）。
 *    所以出口是卡片**下方**一个明确按钮，而不是把点击行为改掉 ——
 *    两条判据必须同时成立：点卡片**不**开任务；点那个按钮**真的**开。
 */
describe('客群卡 × 新建任务', () => {
  beforeEach(() => {
    // ⚠️ **任务 store 要自己清**：外层的 beforeEach 只重置了 uiStore，
    //    而这一组的用例之间通过 `pendingNewTask` 串了状态 —— 第二条用例第一次跑
    //    就是这么被上一条污染的（失败长得像产品 bug，其实是我夹具没隔离）。
    useTaskStore.setState({ pendingNewTask: null, activeTaskId: null });
  });

  it('⭐ 卡片下方那个按钮真的开了新任务，且待发任务带的是当前助手', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-group="rongying-ecommerce"]'));
    expect(useTaskStore.getState().pendingNewTask, '点卡片本身不该开任务').toBeNull();
    // ⚠️ 前置断言：**先确认此刻停在身份中心** —— 没有它，下面那句 `toBe('chat')`
    //    会被"初始就是 chat"满足（变异 I3 第一版就是这么活下来的）。
    expect(useUiStore.getState().mainView, '点之前该停在身份中心').toBe('identity');

    click(container.querySelector('[data-action="new-task-with-agent"]'));

    const pending = useTaskStore.getState().pendingNewTask;
    expect(pending?.agentId, '待发任务要带这个助手').toBe('rongying-ecommerce');
    expect(pending?.gatewayId).toBe('gw-1');
    expect(useTaskStore.getState().activeTaskId, '开新任务要离开旧会话').toBeNull();
    expect(useUiStore.getState().mainView, '开任务就该进对话页了').toBe('chat');
    unmount();
  });

  it('⚠️ 没有网关 ⇒ 如实报错，且**不**留下一个开不出来的任务', () => {
    useUiStore.setState({ defaultGatewayId: null });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="new-task-with-agent"]'));

    expect(toastSpy.error).toHaveBeenCalledWith('identity.applyFailed');
    expect(useTaskStore.getState().pendingNewTask, '开不出来就别留个假的').toBeNull();
    unmount();
  });

  it('⚠️ 对照：点卡片**仍然**只切、留在这一页（别顺手把上一版的取舍推翻）', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-group="rongying-ecommerce"]'));

    expect(useTaskStore.getState().pendingNewTask).toBeNull();
    expect(useUiStore.getState().mainView).toBe('identity');
    unmount();
  });
});

/**
 * ⭐⭐ 绕过判据的另外两个入口（2026-09-29）。
 *
 * 「点了团队里的助手却落到主罗盘」那一族（层 2）在 2026-09-24 已经修掉，判据收在
 * `lib/requested-agent.ts`，`applyPersona` 也接上了。**但这一页还有两个入口没接**：
 * 点客群卡（`chooseGroup`）和「用它开任务」（`startTaskWithAgent`）。
 * 它们让"这个助手不在本机"只在**跳进对话页之后**才由欢迎屏说出来 ——
 * 而 `TeamsPanel` 的注释明确反对这种"跳过去才说"（用户已经换了页面，才知道刚才那下没成）。
 *
 * ⭐ 判据必须**复用** `resolveRequestedAgent`：它在目录**还没拉回来**时返回 `loading`，
 * 不判缺失。自己写 `agents.some(...)` 会把"还没加载"误报成"不在本机"——
 * 那是用一个新的误报换掉旧的静默。
 */
describe('绕过判据的入口 × 缺失的助手', () => {
  beforeEach(() => {
    useTaskStore.setState({ pendingNewTask: null, activeTaskId: null });
    // 目录里只有罗盘；选中的却是电商运营（盘上没有它）
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      mainView: 'identity',
      agentCatalogByGateway: { 'gw-1': catalog(['main']) },
      selectedAgentByGateway: { 'gw-1': 'rongying-ecommerce' },
    });
  });

  it('⭐ 「用它开任务」：缺失时不许开出一个指向不存在助手的任务', () => {
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-action="new-task-with-agent"]'));

    expect(useTaskStore.getState().pendingNewTask, '不许留个开不出来的待发任务').toBeNull();
    expect(useUiStore.getState().mainView, '要留在原地说明，不是先跳走再说').toBe('identity');
    expect(container.textContent, '要如实说明').toContain('agent.missingTitle');
    unmount();
  });

  it('⭐ 点一个不在本机的客群卡：不许静默切过去', () => {
    useUiStore.setState({ selectedAgentByGateway: { 'gw-1': 'main' } });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-group="rongying-ecommerce"]'));

    expect(selectAgentSpy, '不许静默换人').not.toHaveBeenCalled();
    expect(container.textContent, '要如实说明').toContain('agent.missingTitle');
    unmount();
  });

  it('对照：目录**还没拉回来**时两个入口都走老路（不许把 loading 判成缺失）', () => {
    useUiStore.setState({
      defaultGatewayId: 'gw-1',
      mainView: 'identity',
      agentCatalogByGateway: {},
      selectedAgentByGateway: { 'gw-1': 'rongying-ecommerce' },
    });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-group="rongying-ecommerce"]'));
    expect(selectAgentSpy, '目录未加载时照常切').toHaveBeenCalledWith('rongying-ecommerce');

    click(container.querySelector('[data-action="new-task-with-agent"]'));
    expect(useTaskStore.getState().pendingNewTask?.agentId, '目录未加载时照常开').toBe('rongying-ecommerce');
    expect(container.textContent, '目录未加载时不许判缺失').not.toContain('agent.missingTitle');
    unmount();
  });

  it('对照：装着的助手照常切、照常开（别把守卫修成谁都拦）', () => {
    // ⚠️ 这一组的外层 beforeEach 把目录**收窄成只有 main**（为了造缺失），
    //    所以这里必须把目录还原成完整的 —— 否则"装着的助手"根本不装着，
    //    这条对照会以"守卫是对的"为理由假红（第一版就是这么红的）。
    useUiStore.setState({
      selectedAgentByGateway: { 'gw-1': 'main' },
      agentCatalogByGateway: { 'gw-1': catalog(['main', 'rongying-ecommerce', 'rongying-office']) },
    });
    const { container, unmount } = render(<IdentityCenter />);

    click(container.querySelector('[data-group="rongying-office"]'));
    expect(selectAgentSpy).toHaveBeenCalledWith('rongying-office');

    click(container.querySelector('[data-action="new-task-with-agent"]'));
    expect(useTaskStore.getState().pendingNewTask?.agentId).toBe('rongying-office');
    expect(container.textContent).not.toContain('agent.missingTitle');
    unmount();
  });
});
