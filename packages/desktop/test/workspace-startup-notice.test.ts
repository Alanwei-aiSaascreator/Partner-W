import { beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceStartupDecision } from '../src/main/workspace/portable.js';
import {
  clearWorkspaceStartupNotice,
  readWorkspaceStartupNotice,
  recordWorkspaceStartupDecision,
} from '../src/main/workspace/startup-notice.js';

/**
 * 「这次启动把工作区重建过」的记录 —— 边界照抄 `portable.ts` 的教义：
 * **只有 `recreated` 出通知**，其余 kind 一律 null（healed 是找回了、ask-user 自己弹框、
 * default/auto-portable 是首启）。切工作区（setup/change）后必须能清掉。
 */
describe('workspace 启动通知', () => {
  beforeEach(() => clearWorkspaceStartupNotice());

  it('⭐ 只有 recreated 出通知', () => {
    recordWorkspaceStartupDecision({ kind: 'recreated', path: 'C:\\ws' }, 100);
    expect(readWorkspaceStartupNotice()).toEqual({ kind: 'recreated', path: 'C:\\ws', at: 100 });
  });

  it.each<WorkspaceStartupDecision>([
    { kind: 'configured', path: 'C:\\ws' },
    {
      kind: 'healed',
      path: 'E:\\ws',
      from: 'F:\\ws',
      via: { path: 'E:\\ws', origin: 'same-letter', evidence: 'volume-marker' },
    },
    { kind: 'auto-portable', path: 'E:\\ws', volumeRoot: 'E:\\' },
    { kind: 'default', path: 'C:\\h' },
    { kind: 'ask-user', recordedPath: 'E:\\ws', candidates: [] },
  ])('其余 kind（%o）⇒ null', (decision) => {
    recordWorkspaceStartupDecision(decision, 100);
    expect(readWorkspaceStartupNotice()).toBeNull();
  });

  it('重记会覆盖；clear 清空（切工作区后旧通知不许挂着）', () => {
    recordWorkspaceStartupDecision({ kind: 'recreated', path: 'C:\\a' }, 1);
    recordWorkspaceStartupDecision({ kind: 'default', path: 'C:\\b' }, 2);
    expect(readWorkspaceStartupNotice()).toBeNull();
    recordWorkspaceStartupDecision({ kind: 'recreated', path: 'C:\\c' }, 3);
    clearWorkspaceStartupNotice();
    expect(readWorkspaceStartupNotice()).toBeNull();
  });
});
