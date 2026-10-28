// @vitest-environment jsdom

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { buildSessionKey } from '@clawwork/shared';
import { useAssistantIdentityIndex } from '../src/renderer/layouts/MainArea/useAssistantIdentityIndex';
import type { AssistantIdentity } from '../src/renderer/layouts/MainArea/assistant-identity';

/**
 * ⭐⭐ 「每个会话的身份对象不能每个 delta 换一个新的」（2026-09-29）。
 *
 * ## 这一条守的是什么
 *
 * `AssistantBlock` 是 `memo` 的，但 `MainArea` 在渲染循环里**每次调用**
 * `resolveAssistantIdentity()` —— 它返回一个**全新的对象字面量**。
 * 于是 `memo` 的浅比较**每次都失败**，推理链每来一个 delta 就重渲整棵子树，
 * 一路重渲到 `MarkdownContent`（那里当时零 `useMemo`，还会重建插件数组和内联 `components`
 * —— 那两处已在同一刀里补上，所以现在挡住重渲就真的省下了重新解析）。
 * 真机实测：一轮长思维链 **480 次整块重渲染**，界面直接卡住。
 *
 * ## 为什么判据是"同一个引用"
 *
 * 这不是实现细节，**正是让 `memo` 生效的那个条件**（React 的浅比较按引用比）。
 * 所以这条测试直接盯引用相等，而不是绕去数渲染次数。
 *
 * ⚠️ 另一半同样要守：**依赖变了必须换新对象**。只测"引用稳定"会把
 * "漏依赖 ⇒ 头像/名字冻住"这种改法判成绿的 —— 那种 bug 比性能问题更难查。
 */
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Inputs = Parameters<typeof useAssistantIdentityIndex>[0];

let getIdentity!: (sessionKey?: string, agentId?: string) => AssistantIdentity;

function Probe(props: Inputs): ReactElement {
  getIdentity = useAssistantIdentityIndex(props);
  return <span />;
}

function render(ui: ReactElement): { rerender: (next: ReactElement) => void; unmount: () => void } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(ui));
  return {
    rerender: (next) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/**
 * ⚠️ 会话键用**仓库自己的构造器**，别手写字符串。
 *
 * 我第一版手写成 `agent:main:1`，而真格式是
 * `agent:<agentId>:clawwork:task:<taskId>` —— 认不出来时 `parseAgentIdFromSessionKey`
 * **回落到 `'main'`**，于是有一条断言"因为变成 main 而恰好通过"（假绿）。
 */
const MAIN = buildSessionKey('t1', 'main');
const WRITER = buildSessionKey('t2', 'writer');
const REVIEWER = buildSessionKey('t3', 'reviewer');

const baseInputs = (): Inputs => ({
  entries: [{ sessionKey: MAIN }, { sessionKey: WRITER }],
  task: { sessionKey: MAIN, agentId: 'main' },
  gatewayId: 'gw-1',
  performerBySessionKey: new Map(),
  performerByAgentId: new Map(),
  catalogAgentById: new Map([['main', { id: 'main', name: '罗盘助手' }]]),
  conductorLabel: '主助手',
});

describe('useAssistantIdentityIndex', () => {
  it('⭐ 两次渲染、输入没变 ⇒ 同一个会话拿到**同一个引用**（这条不成立，memo 就是白挂的）', () => {
    const inputs = baseInputs();
    const { rerender, unmount } = render(<Probe {...inputs} />);
    const first = getIdentity(MAIN);

    // 模拟"来了一堆 delta"：父组件重渲，但身份相关的输入一个都没变
    for (let i = 0; i < 5; i += 1) rerender(<Probe {...inputs} />);

    expect(getIdentity(MAIN), '每渲一次换一个新对象 ⇒ memo 每次都被击穿').toBe(first);
    unmount();
  });

  it('不同会话拿到不同对象（别把所有人都映射成同一个）', () => {
    const inputs = baseInputs();
    const { unmount } = render(<Probe {...inputs} />);
    expect(getIdentity(MAIN)).not.toBe(getIdentity(WRITER));
    unmount();
  });

  it('⭐ 依赖真的变了 ⇒ **必须换新对象**（漏依赖会把头像/名字冻住）', () => {
    const inputs = baseInputs();
    const { rerender, unmount } = render(<Probe {...inputs} />);
    const before = getIdentity(MAIN);

    const changedCatalog = new Map([['main', { id: 'main', name: '改过名字的助手' }]]);
    rerender(<Probe {...inputs} catalogAgentById={changedCatalog} />);

    expect(getIdentity(MAIN), '目录改了还发旧对象 = 名字永远不会更新').not.toBe(before);
    expect(getIdentity(MAIN).agentName).toBe('改过名字的助手');
    unmount();
  });

  /**
   * ⭐⭐ **`agentId` 必须原样传下去**（2026-09-29 自查抓到的等价性缺口）。
   *
   * 旧代码在"定稿消息"那一支传的是 `agentId: message.agentId`
   * （历史消息里它由**网关**给，见 `session-sync.ts`），而另两支传的是从会话键解析的。
   * 我第一版只按会话键算 ⇒ 两者不一致时，那条消息显示的名字/头像会变
   * （`sessionKey` 缺、只有 `agentId` 时更是直接变空）。缓存键因此是**（会话，助手）对**。
   */
  it('⭐ 给了 agentId 就按它算（与会话键不一致时不许拿会话键顶替）', () => {
    const inputs: Inputs = {
      ...baseInputs(),
      // 两种形态各来一份：带 agentId 的（定稿消息那一支）和不带的（回合那一支）
      entries: [{ sessionKey: MAIN, agentId: 'writer' }, { sessionKey: MAIN }],
      catalogAgentById: new Map([
        ['main', { id: 'main', name: '罗盘助手' }],
        ['writer', { id: 'writer', name: '写手助手' }],
      ]),
    };
    const { unmount } = render(<Probe {...inputs} />);

    expect(getIdentity(MAIN, 'writer').agentName, '要按给的 agentId 算').toBe('写手助手');
    expect(getIdentity(MAIN).agentName, '不给就按会话键解析（旧行为的另一支）').toBe('罗盘助手');
    unmount();
  });

  it('只知道 agentId、没有会话键时也要给得出身份（不许返回空）', () => {
    const inputs: Inputs = {
      ...baseInputs(),
      entries: [{ sessionKey: '', agentId: 'writer' }],
      catalogAgentById: new Map([['writer', { id: 'writer', name: '写手助手' }]]),
    };
    const { unmount } = render(<Probe {...inputs} />);

    expect(getIdentity(undefined, 'writer').agentName).toBe('写手助手');
    unmount();
  });

  it('会话清单变了 ⇒ 新会话也能拿到身份', () => {
    const inputs = baseInputs();
    const { rerender, unmount } = render(<Probe {...inputs} />);

    rerender(<Probe {...inputs} entries={[...inputs.entries, { sessionKey: REVIEWER }]} />);

    expect(getIdentity(REVIEWER).agentName).toBe('reviewer');
    unmount();
  });
});
