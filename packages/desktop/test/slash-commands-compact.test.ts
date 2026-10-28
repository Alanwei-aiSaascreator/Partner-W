// @vitest-environment node

/**
 * `/compact` 必须出现在**命令注册表**里（自动补全 / 命令面板的可见性）。
 *
 * 缺陷：注册表旧有 19 条命令里没有 `compact` ⇒ 用户根本补全不出它。
 * 派发那一半由 `test/use-chat-send.test.tsx` 守（走既有 `applySlashCommand`）；
 * 这条只钉"注册表里有它"。修复前必红。
 */

import { describe, expect, it } from 'vitest';
import { getCommandsForGateway } from '../src/renderer/lib/slash-commands';

describe('slash command registry — /compact', () => {
  it('⭐ 目录为空（回退到 native overlay）时也含 compact', () => {
    const commands = getCommandsForGateway(undefined);
    const compact = commands.find((c) => c.name === 'compact');

    expect(compact, '/compact 必须出现在注册表里').toBeDefined();
    expect(compact?.acceptsArgs).toBe(false);
    expect(compact?.category).toBe('session');
    expect(compact?.source).toBe('native');
  });
});
