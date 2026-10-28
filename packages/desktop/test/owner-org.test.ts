import { describe, expect, it } from 'vitest';
import { selectOwnerOrg } from '../src/main/commercial/owner-org';
import type { CommercialOrg } from '../src/main/commercial/auth';

/**
 * 「这个账号的计费组织是哪个」——**唯一**的定义处。
 *
 * 规则必须与两处逐字一致：
 *   · 服务端 `activate_license`（迁移 56）：未绑卡 ⇒ 绑到
 *     `order by om.joined_at asc, om.org_id asc` 的**最早 owner 组织**；
 *   · `license.ts` 的 `firstOwnerOrg()`：同一条 ORDER BY。
 *
 * 2026-09-24 的缺陷：`auth.ts:339` 与 `usage-from-server.ts:260` 都写的是
 * `session.orgs[0]`，而 `org_members` 的查询**没有 order、也没有 role 过滤**
 * ⇒ 「第一个」是不确定的，而且可能是**只是 member** 的组织。
 * 后果：界面把别人组织的卡显示成「当前账户已绑定 {sku}」，
 * 用户既用不了、又因为激活页那时不渲染输入框而换不掉。
 */

function org(id: string, role: string, joinedAt: string | null): CommercialOrg {
  return { id, name: id, slug: id, plan: 'pro', role, joinedAt };
}

describe('selectOwnerOrg', () => {
  it('只有一个 owner ⇒ 选它', () => {
    const only = org('org-a', 'owner', '2026-01-01T00:00:00Z');
    expect(selectOwnerOrg([only])?.id).toBe('org-a');
  });

  it('两个 owner ⇒ 取**先加入**的那个（数组顺序颠倒也成立）', () => {
    const early = org('org-early', 'owner', '2026-01-01T00:00:00Z');
    const late = org('org-late', 'owner', '2026-06-01T00:00:00Z');

    expect(selectOwnerOrg([early, late])?.id).toBe('org-early');
    // ⭐ 这一半专门击杀「实现其实是 orgs[0]」——只测上面那半的话，
    //    一个退化成"取第一个元素"的实现照样全绿。
    expect(selectOwnerOrg([late, early])?.id).toBe('org-early');
  });

  it('更早加入但**不是 owner** 的组织不参与 —— member 用不了组织的卡（P1 明文拍过）', () => {
    const memberOrg = org('org-member', 'member', '2026-01-01T00:00:00Z');
    const ownerOrg = org('org-owner', 'owner', '2026-06-01T00:00:00Z');

    expect(selectOwnerOrg([memberOrg, ownerOrg])?.id).toBe('org-owner');
  });

  it('连 admin 也不算 —— 只有 owner 能激活/读到中转 key', () => {
    const adminOrg = org('org-admin', 'admin', '2026-01-01T00:00:00Z');
    const ownerOrg = org('org-owner', 'owner', '2026-06-01T00:00:00Z');
    expect(selectOwnerOrg([adminOrg, ownerOrg])?.id).toBe('org-owner');
  });

  it('一个 owner 都没有 ⇒ null（**不**退而求其次随便挑一个组织）', () => {
    expect(selectOwnerOrg([org('org-a', 'member', '2026-01-01T00:00:00Z')])).toBeNull();
    expect(selectOwnerOrg([])).toBeNull();
  });

  it('joinedAt 缺失的 owner 排在有时间的**后面**（未知不等于最早）', () => {
    const unknown = org('org-unknown', 'owner', null);
    const known = org('org-known', 'owner', '2026-06-01T00:00:00Z');

    expect(selectOwnerOrg([unknown, known])?.id).toBe('org-known');
    expect(selectOwnerOrg([known, unknown])?.id).toBe('org-known');
  });

  it('joinedAt 相同时按 org_id 升序 —— 两次读数必须挑到同一个组织', () => {
    const b = org('org-b', 'owner', '2026-06-01T00:00:00Z');
    const a = org('org-a', 'owner', '2026-06-01T00:00:00Z');

    expect(selectOwnerOrg([b, a])?.id).toBe('org-a');
    expect(selectOwnerOrg([a, b])?.id).toBe('org-a');
  });

  it('不修改入参（调用方还要用这份 orgs 列表）', () => {
    const list = [org('org-late', 'owner', '2026-06-01T00:00:00Z'), org('org-early', 'owner', '2026-01-01T00:00:00Z')];
    const snapshot = list.map((o) => o.id);

    selectOwnerOrg(list);

    expect(list.map((o) => o.id)).toEqual(snapshot);
  });
});
