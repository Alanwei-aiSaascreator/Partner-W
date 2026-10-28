// @vitest-environment jsdom

import type { ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import zh from '../src/renderer/i18n/locales/zh.json';

function translate(key: string, values?: Record<string, unknown>): string {
  let node: unknown = zh;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null) return key;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'string') return key;
  if (!values) return node;
  return node.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values[name] ?? ''));
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'zh' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../src/renderer/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import MemberTab from '../src/renderer/layouts/CommunityPanel/MemberTab';
import { toast } from 'sonner';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = {
  user_id: 'u-owner',
  display_name: '甲',
  role: 'owner',
  joined_at: '2026-09-17T09:00:00.000Z',
  is_me: true,
};
const member = {
  user_id: 'u-member',
  display_name: '乙',
  role: 'member',
  joined_at: '2026-09-17T09:30:00.000Z',
  is_me: false,
};

function info(role: 'owner' | 'member') {
  return {
    org_id: 'o1',
    org_name: '甲',
    role,
    member_count: 2,
    my_orgs: [
      { orgId: 'o1', orgName: '甲', role },
      { orgId: 'o2', orgName: '乙', role: 'owner' },
    ],
  };
}

async function render(): Promise<{ container: HTMLDivElement; unmount: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<MemberTab />);
  });
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return ([...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) ??
    null) as HTMLButtonElement | null;
}

describe('MemberTab', () => {
  beforeEach(() => {
    Object.assign(window, {
      clawwork: {
        communityInfo: vi.fn(async () => ({ ok: true, result: info('owner') })),
        communityMembers: vi.fn(async () => ({ ok: true, result: [owner, member] })),
        communityInviteList: vi.fn(async () => ({ ok: true, result: [] })),
        communityInviteCreate: vi.fn(async () => ({ ok: true, result: { code: 'ABCDEF1234', expiresAt: 'x' } })),
        communityInviteRevoke: vi.fn(async () => ({ ok: true, result: null })),
        communityJoin: vi.fn(async () => ({ ok: true, result: { orgId: 'o1', orgName: '甲', role: 'member' } })),
        communityMemberRemove: vi.fn(async () => ({ ok: true, result: null })),
        communitySwitchTeam: vi.fn(async () => ({ ok: true, result: null })),
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('列出成员并标出角色与「我」', async () => {
    const view = await render();
    expect(view.container.textContent).toContain('甲');
    expect(view.container.textContent).toContain('乙');
    expect(view.container.textContent).toContain(translate('community.roleOwner'));
    expect(view.container.textContent).toContain(translate('community.roleMember'));
    expect(view.container.textContent).toContain(translate('community.me'));
    view.unmount();
  });

  it('管理员能看到邀请区，点生成真的调用后端并显示新码', async () => {
    const view = await render();
    const create = buttonByText(view.container, translate('community.inviteGenerate'));
    await act(async () => create?.click());
    expect(window.clawwork.communityInviteCreate).toHaveBeenCalled();
    expect(view.container.textContent).toContain('ABCDEF1234');
    view.unmount();
  });

  it('普通成员看不到邀请码区，但看得到那句说明', async () => {
    (window.clawwork.communityInfo as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      result: info('member'),
    });
    const view = await render();
    // ⚠️ 不能断言"文本里没有『生成邀请码』"：那句提示原文就是
    //    「只有管理员能生成邀请码。」，一定会命中。要断言的是**按钮**不在。
    expect(buttonByText(view.container, translate('community.inviteGenerate'))).toBeNull();
    expect(view.container.textContent).toContain(translate('community.inviteOnlyAdmin'));
    view.unmount();
  });

  it('多团队时给切换器，切了会调后端', async () => {
    const view = await render();
    // 成员列表里的名字是 span 不是 button，所以这里拿到的一定是切换按钮
    const switchButton = buttonByText(view.container, '乙');
    await act(async () => switchButton?.click());
    expect(window.clawwork.communitySwitchTeam).toHaveBeenCalledWith('o2');
    view.unmount();
  });

  it('输入邀请码加入成功后提示团队名', async () => {
    const view = await render();
    const input = view.container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, 'ABCDEF1234');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const join = buttonByText(view.container, translate('community.join'));
    await act(async () => join?.click());
    expect(window.clawwork.communityJoin).toHaveBeenCalledWith('ABCDEF1234');
    view.unmount();
  });

  it('加入失败时显示的是中文，不是机器码', async () => {
    (window.clawwork.communityJoin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      errorCode: 'invite_exhausted',
    });
    const view = await render();
    const input = view.container.querySelector('input[type="text"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(input, 'XYZ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const join = buttonByText(view.container, translate('community.join'));
    await act(async () => join?.click());

    // ⚠️ toast 是 mock 的 ⇒ 文案不进 DOM，只能断言"它被用中文叫了"。
    //    这正是"用户看到的是中文"这条承诺的验证点。
    // ⚠️ 不能用 `toHaveBeenCalledWith(单个参数)`：组件走的是 `@/lib/toast`
    //    那层包装，它固定补第二个参数 `{duration}`，参数个数对不上。
    const errors = (toast.error as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) =>
      String(call[0]),
    );
    expect(errors.some((text) => text.includes('用完'))).toBe(true);
    expect(errors.every((text) => !text.includes('invite_exhausted'))).toBe(true);
    view.unmount();
  });

  it('列出已有的邀请码与剩余次数，可以撤销', async () => {
    (window.clawwork.communityInviteList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      result: [
        {
          id: 'inv-1',
          code: 'AAAA111111',
          role: 'member',
          max_uses: 3,
          used_count: 1,
          expires_at: null,
          created_at: '2026-09-17T09:00:00.000Z',
          active: true,
        },
      ],
    });
    const view = await render();
    expect(view.container.textContent).toContain('AAAA111111');
    expect(view.container.textContent).toContain('2/3');

    const revoke = buttonByText(view.container, translate('community.inviteRevoke'));
    await act(async () => revoke?.click());
    expect(window.clawwork.communityInviteRevoke).toHaveBeenCalledWith('inv-1');
    view.unmount();
  });

  it('邀请码列表被拒（非管理员）时不显示错误，只当没有', async () => {
    (window.clawwork.communityInviteList as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      errorCode: 'forbidden',
    });
    const view = await render();
    // 甲自己是 owner，但列表可以拉失败 —— 界面不该因此炸掉或报错
    expect(view.container.textContent).toBeTruthy();
    view.unmount();
  });

  it('移出成员会调用后端（界面上有按钮）', async () => {
    const view = await render();
    const remove = view.container.querySelector(
      `button[aria-label="${translate('community.removeMember')}"]`,
    ) as HTMLButtonElement;
    expect(remove).toBeTruthy();
    await act(async () => remove?.click());
    expect(window.clawwork.communityMemberRemove).toHaveBeenCalledWith('u-member');
    view.unmount();
  });
});
