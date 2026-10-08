// @vitest-environment jsdom

/**
 * 2026-10-08 对话可视化改造 · Task 4：工具过程**运行期平铺可见** + 工具行轻量化。
 *
 * 旧形态（pre21 及以前）：摘要行默认收起 → 组行再折叠 → 单卡再折叠 = 运行中要点三次
 * 才看得到"到底在做什么"。本套件钉住新语义（Codex 复审 v2 定稿）：
 *
 *   1. 运行期/未确认失败 ⇒ **不点击**就能看到工具行（forcedOpen）；
 *   2. settled 且全成功（或用户已确认/跳过）⇒ 才允许折叠为一层；展开后**平铺**
 *      （不再有按 kind 的二级分组折叠），且顺序 = 原始调用顺序；
 *   3. `ToolCallCard` 行轻量化：无卡片底/彩条/光效，错误说明块移到**行下方**（同级兄弟）；
 *   4. running 用 `tool-icon-loading` + `text-shimmer`；awaiting 用静态 Clock（不扫光）；
 *   5. 动作名显示映射：`read` 这类分类落在 `other` 的工具显示"读文件"，不是"使用工具"。
 */

import type { ToolCall, ToolCallStatus } from '@clawwork/shared';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => (values ? `${key}:${Object.values(values).join(':')}` : key),
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));

vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: ReactElement }) => children,
  motion: { div: 'div', span: 'span' },
}));

import ToolCallSummary from '../src/renderer/components/ToolCallSummary';
import ToolCallCard from '../src/renderer/components/ToolCallCard';
import { resolveDisplayKind } from '../src/renderer/lib/tool-display-kind';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function call(id: string, name: string, status: ToolCallStatus = 'done', over: Partial<ToolCall> = {}): ToolCall {
  return {
    id,
    name,
    status,
    startedAt: '2026-09-15T00:00:00.000Z',
    ...(status === 'running' || status === 'awaitingApproval' ? {} : { completedAt: '2026-09-15T00:00:01.000Z' }),
    ...over,
  };
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

function summaryButton(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-testid="tool-activity-summary"]') as HTMLElement;
}

describe('运行期平铺可见（settled=false）', () => {
  it('① 运行中：不点击就能看到工具行；点摘要也收不起来（没有"收起"这个动作）', () => {
    const { container, unmount } = render(<ToolCallSummary toolCalls={[call('1', 'ls')]} />);

    expect(container.querySelectorAll('[data-testid="tool-call-card"]'), '运行期必须平铺可见').toHaveLength(1);
    expect(container.querySelector('[data-testid="tool-call-card"]')?.textContent).toContain(
      'toolActivity.actions.listDirectory',
    );

    // forcedOpen：触发器不提供"收起" —— 点它不该把过程藏回去。
    act(() => summaryButton(container).click());
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(1);
    unmount();
  });
});

describe('settled：成功才折叠为一层，展开后平铺（取消分组折叠）', () => {
  it('② settled 且全成功 ⇒ 默认折叠；展开一层全见、顺序=原始调用顺序、无二级分组行', () => {
    const toolCalls: ToolCall[] = [
      call('1', 'ls', 'done', { title: 'ls 甲目录' }),
      call('2', 'exec', 'done', { title: 'exec 乙命令' }),
      call('3', 'read', 'done', { title: 'read 丙文件' }),
    ];
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={toolCalls} />);

    expect(container.querySelectorAll('[data-testid="tool-call-card"]'), '全成功才允许默认折叠').toHaveLength(0);

    act(() => summaryButton(container).click());

    const cards = [...container.querySelectorAll('[data-testid="tool-call-card"]')];
    expect(cards, '展开一层就该看到全部工具行').toHaveLength(3);
    expect(container.querySelectorAll('[data-testid^="tool-activity-group-"]'), '分组折叠已取消').toHaveLength(0);
    expect(
      cards.map((card) => ['甲目录', '乙命令', '丙文件'].find((marker) => (card.textContent ?? '').includes(marker))),
      '行按原始调用顺序平铺',
    ).toEqual(['甲目录', '乙命令', '丙文件']);
    unmount();
  });
});

describe('未确认失败不被"别的工具成功"清除可见性', () => {
  it('③ settled + 有成功步骤 + 未确认失败 ⇒ 默认可见；错误块在行下方、非触发器后代、不截断', () => {
    // Codex 复审 v2 的反例形状：ls 成功 + render 失败 —— softened=true 也不能折叠。
    const toolCalls: ToolCall[] = [call('1', 'read'), call('2', 'exec', 'error', { result: '工作区里没有这个文件' })];
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={toolCalls} />);

    expect(container.querySelectorAll('[data-testid="tool-call-card"]'), '未确认失败必须默认可见').toHaveLength(2);

    const error = container.querySelector('[data-testid="tool-call-error"]');
    expect(error, '失败原因要有独立错误块').not.toBeNull();
    expect(error!.textContent).toBe('工作区里没有这个文件');
    expect(error!.closest('.tool-row__trigger'), '错误块不是触发器后代（在行下方）').toBeNull();
    expect(error!.closest('button')).toBeNull();
    expect(error!.previousElementSibling?.className ?? '', '错误块紧跟在行之后').toContain('tool-row__trigger');
    expect(error!.className, '错误块整段可见，不截断').not.toContain('truncate');
    unmount();
  });

  it('③b 用户点过「跳过这个失败」⇒ 允许收成一层（语义不变：acknowledged 才折叠）', () => {
    const toolCalls: ToolCall[] = [
      call('1', 'exec', 'error', { result: 'boom' }),
      call('2', 'read', 'error', { result: 'nope' }),
    ];
    const { container, unmount } = render(<ToolCallSummary settled toolCalls={toolCalls} />);

    act(() => (container.querySelector('[data-testid="tool-failure-continue"]') as HTMLButtonElement).click());
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(0);

    act(() => summaryButton(container).click());
    expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(2);
    unmount();
  });
});

describe('ToolCallCard 行轻量化', () => {
  it('④ running：无 glass-card/glow-running/tool-scan/彩条，无转圈 spinner；图标与状态文字走工具行动效', () => {
    const { container, unmount } = render(
      <ToolCallCard toolCall={call('1', 'exec', 'running', { title: 'exec 跑命令' })} />,
    );
    const root = container.querySelector('[data-testid="tool-call-card"]');
    expect(root).not.toBeNull();
    expect(root!.className).toContain('tool-row');
    expect(root!.className, '单行不是卡片').not.toContain('glass-card');
    expect(container.querySelector('.glow-running')).toBeNull();
    expect(container.querySelector('.tool-scan')).toBeNull();
    // 旧形态的第一个子节点是"左侧彩条"div（inline background-color）；新形态第一子节点就是行触发器。
    expect(root!.firstElementChild?.className ?? '').toContain('tool-row__trigger');
    expect(
      [...root!.querySelectorAll('[style]')].some((node) => (node.getAttribute('style') ?? '').includes('background')),
      '左侧彩条已删除',
    ).toBe(false);
    expect(container.querySelector('.tool-icon-loading'), '运行图标用工具行专属动效').not.toBeNull();
    expect(container.querySelector('.animate-spin'), '不再用通用 spinner').toBeNull();

    const statusText = container.querySelector('[data-testid="tool-call-waiting-time"]');
    expect(statusText).not.toBeNull();
    expect(statusText!.closest('.text-shimmer'), '运行态状态文字用扫光').not.toBeNull();
    unmount();
  });

  it('⑤ awaitingApproval：静态 Clock（不转圈、不扫光），「等待批准」文案仍在', () => {
    const { container, unmount } = render(<ToolCallCard toolCall={call('1', 'exec', 'awaitingApproval')} />);

    expect(container.querySelector('[data-testid="awaiting-approval-label"]')).not.toBeNull();
    expect(container.querySelector('svg.lucide-clock'), '在等人 ≠ 在跑：静态时钟').not.toBeNull();
    expect(container.querySelector('.text-shimmer')).toBeNull();
    expect(container.querySelector('.tool-icon-loading')).toBeNull();
    expect(container.querySelector('.animate-spin')).toBeNull();
    unmount();
  });
});

describe('动作名显示映射（仅展示层）', () => {
  it('⑥ `read`（拿不到 title）⇒ 行显示"读文件"，不是"使用工具"', () => {
    const { container, unmount } = render(<ToolCallCard toolCall={call('1', 'read')} />);

    expect(container.textContent).toContain('toolActivity.actions.readFile');
    expect(container.textContent).not.toContain('toolActivity.actions.other');
    unmount();
  });

  it('⑥b 摘要行「正在做什么」同样走映射：running 的 read ⇒ 读文件', () => {
    const { container, unmount } = render(<ToolCallSummary toolCalls={[call('1', 'read', 'running')]} />);

    expect(summaryButton(container).textContent).toContain('toolActivity.actions.readFile');
    expect(summaryButton(container).textContent).not.toContain('toolActivity.actions.other');
    unmount();
  });

  it('⑥c 映射表：仅当分类落在 `other` 时按精确工具名补位；已有分类不被覆盖', () => {
    const table: Array<[string, string]> = [
      ['read', 'readFile'],
      ['ls', 'listDirectory'],
      ['write', 'writeFile'],
      ['edit', 'writeFile'],
      ['apply_patch', 'writeFile'],
      ['exec', 'execute'],
      ['process', 'execute'],
      ['browser', 'browseWeb'],
      ['web_search', 'search'],
      ['web_fetch', 'search'],
    ];
    for (const [toolName, kind] of table) {
      expect(resolveDisplayKind(toolName, 'other'), toolName).toBe(kind);
    }
    // fallback 不是 other ⇒ 原样返回（映射只补位，不改既有分类）
    expect(resolveDisplayKind('web_fetch', 'browseWeb')).toBe('browseWeb');
    // 表外工具 ⇒ 保持 other（不认识就不编）
    expect(resolveDisplayKind('memory_search', 'other')).toBe('other');
    // 大小写/空白归一后命中（网关工具名不保证大小写）
    expect(resolveDisplayKind(' READ ', 'other')).toBe('readFile');
  });
});
