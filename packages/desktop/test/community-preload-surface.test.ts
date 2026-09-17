import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * preload 是 renderer 唯一能碰到的东西 —— 少一个方法，界面上就是
 * "undefined is not a function"；名字写错，这条测试能抓住。
 *
 * 同时约束**只能暴露这些**：`community` 前缀的方法必须和这里的清单逐字相等，
 * 免得顺手把别的能力（或半成品）带出去。
 * 频道的对应关系由 `community-handlers.test.ts` 钉住。
 */
describe('community preload surface', () => {
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
  const declarations = readFileSync(new URL('../src/preload/clawwork.d.ts', import.meta.url), 'utf8');

  const expected = [
    'communityInfo',
    'communityMembers',
    'communitySwitchTeam',
    'communityFeed',
    'communityCreatePost',
    'communityDeletePost',
    'communityComments',
    'communityAddComment',
    'communityLikeToggle',
    'communityInviteCreate',
    'communityInviteList',
    'communityInviteRevoke',
    'communityJoin',
    'communityMemberSetRole',
    'communityMemberRemove',
    'communityLeave',
  ];

  it('每个方法都在 preload 与类型声明里', () => {
    for (const name of expected) {
      expect(preload).toContain(`${name}:`);
      expect(declarations).toContain(`${name}:`);
    }
  });

  it('不额外暴露任何 community 前缀的方法', () => {
    const found = [...preload.matchAll(/\bcommunity[A-Z]\w*/g)].map((m) => m[0]);
    expect([...new Set(found)].sort()).toEqual([...expected].sort());
  });
});
