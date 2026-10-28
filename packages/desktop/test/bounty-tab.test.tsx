// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        'bounty.tab': '悬赏',
        'bounty.publish': '发布悬赏',
        'bounty.titlePlaceholder': '一句话说清要做什么',
        'bounty.descriptionPlaceholder': '补充说明（可选）',
        'bounty.empty': '还没有悬赏，发一个试试',
        'bounty.meta': '奖励 {{reward}} 成长值 · {{status}}',
        'bounty.author': '发布者：{{name}}',
        'bounty.claimant': '领取人：{{name}}',
        'bounty.claim': '领取任务',
        'bounty.release': '放弃',
        'bounty.submit': '提交成果',
        'bounty.accept': '通过验收',
        'bounty.reject': '打回',
        'bounty.cancel': '取消悬赏',
        'bounty.defaultSubmitNote': '已完成，请验收',
        'bounty.defaultRejectNote': '还需要修改',
        'bounty.status_open': '待领取',
        'bounty.status_claimed': '进行中',
        'bounty.status_submitted': '待验收',
        'bounty.status_accepted': '已完成',
        'bounty.status_cancelled': '已取消',
      };
      const raw = table[key] ?? key;
      return raw.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''));
    },
  }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import BountyTab from '../src/renderer/layouts/CommunityPanel/BountyTab';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const base = {
  description: '',
  claimant_id: null,
  claimant_name: null,
  submitted_note: '',
  created_at: '2026-09-17T10:00:00Z',
  accepted_at: null,
  is_mine: false,
  is_claimed_by_me: false,
  can_claim: false,
  can_release: false,
  can_submit: false,
  can_accept: false,
  can_reject: false,
  can_cancel: false,
};

// 三种身份各一条：别人发的（我能领）/ 我发的已提交（我能验收）/ 我领的（我能提交或放弃）
// ⚠️ 夹具必须是**数据库原始行**（snake_case）—— IPC 回来的就是这个形状，
//    写成驼峰的话归一化器一律读到 undefined，界面就永远没有动作按钮（实测踩过）。
const rows = [
  {
    ...base,
    id: 'b-open',
    title: '别人发的',
    reward: 100,
    status: 'open',
    author_id: 'u2',
    author_name: '乙',
    can_claim: true,
  },
  {
    ...base,
    id: 'b-sub',
    title: '我发的已提交',
    reward: 50,
    status: 'submitted',
    author_id: 'u1',
    author_name: '我',
    claimant_id: 'u2',
    claimant_name: '乙',
    is_mine: true,
    can_accept: true,
    can_reject: true,
  },
  {
    ...base,
    id: 'b-mine',
    title: '我领的',
    reward: 30,
    status: 'claimed',
    author_id: 'u2',
    author_name: '乙',
    claimant_id: 'u1',
    claimant_name: '我',
    is_claimed_by_me: true,
    can_submit: true,
    can_release: true,
  },
];

async function render(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<BountyTab />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function cardOf(container: HTMLElement, title: string): HTMLElement {
  const card = [...container.querySelectorAll('[data-bounty]')].find((el) => el.textContent?.includes(title));
  if (!card) throw new Error(`找不到悬赏卡片：${title}`);
  return card as HTMLElement;
}

function setInput(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('BountyTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(window, {
      clawwork: {
        bountyList: vi.fn(async () => ({ ok: true, result: rows })),
        bountyCreate: vi.fn(async () => ({ ok: true, result: 'b-new' })),
        bountyClaim: vi.fn(async () => ({ ok: true, result: null })),
        bountyRelease: vi.fn(async () => ({ ok: true, result: null })),
        bountySubmit: vi.fn(async () => ({ ok: true, result: null })),
        bountyAccept: vi.fn(async () => ({ ok: true, result: null })),
        bountyReject: vi.fn(async () => ({ ok: true, result: null })),
        bountyCancel: vi.fn(async () => ({ ok: true, result: null })),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('只显示后端允许的动作按钮', async () => {
    const view = await render();

    const open = cardOf(view.container, '别人发的');
    expect(open.querySelector('button[data-action="claim"]')).toBeTruthy();
    expect(open.querySelector('button[data-action="accept"]')).toBeNull();

    const submitted = cardOf(view.container, '我发的已提交');
    expect(submitted.querySelector('button[data-action="accept"]')).toBeTruthy();
    expect(submitted.querySelector('button[data-action="reject"]')).toBeTruthy();
    expect(submitted.querySelector('button[data-action="claim"]')).toBeNull();

    const mine = cardOf(view.container, '我领的');
    expect(mine.querySelector('button[data-action="submit"]')).toBeTruthy();
    expect(mine.querySelector('button[data-action="release"]')).toBeTruthy();
    expect(mine.querySelector('button[data-action="accept"]')).toBeNull();

    view.unmount();
  });

  it('状态、奖励与双方名字都按中文展示', async () => {
    const view = await render();
    expect(view.container.textContent).toContain('奖励 100 成长值 · 待领取');
    expect(view.container.textContent).toContain('奖励 50 成长值 · 待验收');
    expect(view.container.textContent).toContain('发布者：乙');
    expect(view.container.textContent).toContain('领取人：我');
    view.unmount();
  });

  it('发布：标题为空 ⇒ 不可点；填好后调用后端并刷新', async () => {
    const view = await render();
    const publish = () => view.container.querySelector('button[data-action="publish"]') as HTMLButtonElement;
    expect(publish().disabled).toBe(true);

    await act(async () => {
      setInput(view.container.querySelector('input[data-field="new-bounty-title"]') as HTMLInputElement, '写周报');
      setInput(view.container.querySelector('input[data-field="new-bounty-reward"]') as HTMLInputElement, '120');
    });
    expect(publish().disabled).toBe(false);

    await act(async () => publish().click());

    expect(window.clawwork.bountyCreate).toHaveBeenCalledWith({ title: '写周报', description: '', reward: 120 });
    expect(window.clawwork.bountyList).toHaveBeenCalledTimes(2); // 初次 + 发布后刷新
    view.unmount();
  });

  it('奖励超出 10–1000 ⇒ 发布按钮不可点（前端先挡一道）', async () => {
    const view = await render();
    await act(async () => {
      setInput(view.container.querySelector('input[data-field="new-bounty-title"]') as HTMLInputElement, '写周报');
      setInput(view.container.querySelector('input[data-field="new-bounty-reward"]') as HTMLInputElement, '5000');
    });
    expect((view.container.querySelector('button[data-action="publish"]') as HTMLButtonElement).disabled).toBe(true);
    view.unmount();
  });

  it('★ 动作失败 ⇒ 中文原因，不出现机器码', async () => {
    (window.clawwork.bountyClaim as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      errorCode: 'insufficient_growth',
    });
    const view = await render();
    await act(async () => {
      (cardOf(view.container, '别人发的').querySelector('button[data-action="claim"]') as HTMLButtonElement).click();
    });
    const { toast } = await import('sonner');
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('成长值不够托管这笔奖励，先做任务或签到攒一些。', expect.anything()),
    );
    expect(view.container.textContent).not.toContain('insufficient_growth');
    view.unmount();
  });

  it('领取成功 ⇒ 重新拉列表；提交带上默认说明', async () => {
    const view = await render();
    await act(async () => {
      (cardOf(view.container, '别人发的').querySelector('button[data-action="claim"]') as HTMLButtonElement).click();
    });
    expect(window.clawwork.bountyClaim).toHaveBeenCalledWith('b-open');
    expect(window.clawwork.bountyList).toHaveBeenCalledTimes(2);

    await act(async () => {
      (cardOf(view.container, '我领的').querySelector('button[data-action="submit"]') as HTMLButtonElement).click();
    });
    expect(window.clawwork.bountySubmit).toHaveBeenCalledWith({ id: 'b-mine', note: '已完成，请验收' });
    view.unmount();
  });

  it('空列表 ⇒ 空态文案', async () => {
    (window.clawwork.bountyList as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, result: [] });
    const view = await render();
    expect(view.container.textContent).toContain('还没有悬赏，发一个试试');
    view.unmount();
  });
});
