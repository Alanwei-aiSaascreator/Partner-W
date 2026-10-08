import { describe, expect, it } from 'vitest';
import type { Artifact } from '@clawwork/shared';
import { artifactFamilyKey, groupArtifactVersions } from '../src/renderer/lib/artifact-versions.js';

/** 图16（2026-10-06）：同任务重复/失败产物的归并规则。 */

function make(
  id: string,
  name: string,
  createdAt: string,
  availability: Artifact['availability'] = 'available',
  taskId = 'task-1',
): Artifact {
  return {
    id,
    taskId,
    messageId: `msg-${id}`,
    type: 'file',
    name,
    filePath: `C:/ws/${name}`,
    localPath: `${taskId}/${name}`,
    mimeType: 'application/octet-stream',
    size: 10,
    createdAt,
    availability,
  };
}

describe('artifactFamilyKey', () => {
  it.each([
    ['deck-48b728a4.pptx', 'deck'],
    ['高退货率诊断与防刷单策略-cccc3333.pptx', '高退货率诊断与防刷单策略'],
    ['DECK-ABCD1234.PPTX', 'deck'],
    ['deck.pptx', 'deck.pptx'],
    ['报告-2.pptx', '报告-2.pptx'],
    ['报告-最终版.pptx', '报告-最终版.pptx'],
  ])('%s → %s', (name, expected) => {
    expect(artifactFamilyKey(name)).toBe(expected);
  });
});

describe('groupArtifactVersions', () => {
  it('同族只保留最新可用版；旧版与问题版进折叠区（保持时间倒序）', () => {
    const v3 = make('v3', 'deck-cccc3333.pptx', '2026-10-06T01:10:00.000Z', 'unsafe');
    const v2 = make('v2', 'deck-bbbb2222.pptx', '2026-10-06T01:05:00.000Z');
    const v1 = make('v1', 'deck-aaaa1111.pptx', '2026-10-06T01:00:00.000Z');
    const other = make('other', '笔记.txt', '2026-10-06T00:50:00.000Z');

    const { current, archived } = groupArtifactVersions([v3, v2, v1, other]);

    expect(current.map((a) => a.id)).toEqual(['v2', 'other']);
    expect(archived.map((a) => a.id)).toEqual(['v3', 'v1']);
  });

  it('整族都不可用 ⇒ 整族进折叠区，默认视图不出现', () => {
    const bad = make('bad', 'deck-bbbb2222.pptx', '2026-10-06T01:05:00.000Z', 'missing');
    const worse = make('worse', 'deck-aaaa1111.pptx', '2026-10-06T01:00:00.000Z', 'unsafe');

    const { current, archived } = groupArtifactVersions([bad, worse]);

    expect(current).toEqual([]);
    expect(archived.map((a) => a.id)).toEqual(['bad', 'worse']);
  });

  it('单文件不进折叠区；人类命名不归并', () => {
    const one = make('one', 'deck-aaaa1111.pptx', '2026-10-06T01:00:00.000Z');
    const plain = make('plain', '报告.pptx', '2026-10-06T01:00:00.000Z');
    const dashNumber = make('n2', '报告-2.pptx', '2026-10-06T01:01:00.000Z');

    const { current, archived } = groupArtifactVersions([one, plain, dashNumber]);

    expect(current.map((a) => a.id)).toEqual(['one', 'plain', 'n2']);
    expect(archived).toEqual([]);
  });

  it('空输入 → 两个空数组', () => {
    expect(groupArtifactVersions([])).toEqual({ current: [], archived: [] });
  });

  /**
   * ⭐ 2026-10-07 体检 P2-3：「还不知道」（`unknown` = 连接中）**不参与折叠降级**。
   *
   * 冷启动/网关没连上时助手根的 availability 解析不出来 ⇒ 旧口径算成 missing ⇒
   * 整族折进"历史与问题文件" ⇒ 主列表"交付物没了"。它是"暂时判不了"，不是"坏了"。
   */
  describe('unknown（暂不可用/连接中）', () => {
    it('⭐ 单份 unknown ⇒ 留在主列表（不折走）', () => {
      const pending = make('pending', 'deck-aaaa1111.pptx', '2026-10-06T01:00:00.000Z', 'unknown');

      const { current, archived } = groupArtifactVersions([pending]);

      expect(current.map((a) => a.id)).toEqual(['pending']);
      expect(archived).toEqual([]);
    });

    it('⭐ 整族都是 unknown（冷启动那一瞬）⇒ 最新那份仍留在主列表', () => {
      const newer = make('pending-new', 'deck-bbbb2222.pptx', '2026-10-06T01:05:00.000Z', 'unknown');
      const older = make('pending-old', 'deck-aaaa1111.pptx', '2026-10-06T01:00:00.000Z', 'unknown');

      const { current, archived } = groupArtifactVersions([newer, older]);

      expect(current.map((a) => a.id)).toEqual(['pending-new']);
      expect(archived.map((a) => a.id)).toEqual(['pending-old']);
    });

    it('有可用版本时，可用版本仍优先（unknown 不夺权）', () => {
      const pending = make('pending', 'deck-bbbb2222.pptx', '2026-10-06T01:05:00.000Z', 'unknown');
      const available = make('available', 'deck-aaaa1111.pptx', '2026-10-06T01:00:00.000Z');

      const { current, archived } = groupArtifactVersions([pending, available]);

      expect(current.map((a) => a.id)).toEqual(['available']);
      expect(archived.map((a) => a.id)).toEqual(['pending']);
    });
  });

  /**
   * ⭐ 2026-10-07 体检 P2-5：族键**带 taskId**。
   *
   * 会议模式下主列表是多任务合并的；两 turn 交出同名文件（会议里极常见）时，
   * 只按文件名算族会让其中一份被折进折叠区 —— 跨任务归属错误。
   */
  it('⭐ 同名但**不同任务** ⇒ 不归并，两份都留在主列表', () => {
    const mine = make('mine', '方案-aaaa1111.pptx', '2026-10-06T01:00:00.000Z', 'available', 'task-1');
    const otherTurn = make('other', '方案-aaaa1111.pptx', '2026-10-06T01:05:00.000Z', 'available', 'task-2');

    const { current, archived } = groupArtifactVersions([otherTurn, mine]);

    expect(current.map((a) => a.id)).toEqual(['other', 'mine']);
    expect(archived).toEqual([]);
  });

  /**
   * ⭐ 同一份成品在库里两行（不同 `root`）时，**默认视图只出一条**。
   *
   * 现场为什么会两行：CLI 那份稿子既可能被工作区**根层**的扫描原地收编
   * （第三个根，`root:'workspace-root'`），又可能被"跨根成品规范落位"复制进任务目录
   * （`root:'workspace'`）。族键 = `taskId + 去掉 -<8hex> 的名字`，**不含 root**
   * （`artifact-versions.ts:47`）⇒ 两行同族 ⇒ 只有最新那份可用版留在主列表，
   * 另一份进折叠区（"历史与问题文件"）——**不会有两条一模一样的卡片**。
   * ⚠️ 这只描述"万一两行"的收敛行为；线上下这一步之前已经先问过库
   *    （`isRegisteredDeck`）—— 已登记的**根本不复制**，所以正常路径上连折叠区那份都没有。
   */
  it('⭐ 同一份成品两行（不同 root）⇒ 同族归并，默认只出最新一条', () => {
    const scanned = {
      ...make('from-root-scan', '公司介绍-v2-ade3018a.pptx', '2026-10-07T01:00:00.000Z'),
      root: 'workspace-root' as Artifact['root'],
      localPath: '公司介绍-v2-ade3018a.pptx',
    };
    const relocated = {
      ...make('from-relocate', '公司介绍-v2-ade3018a.pptx', '2026-10-07T01:00:05.000Z'),
      root: 'workspace' as Artifact['root'],
    };

    const { current, archived } = groupArtifactVersions([scanned, relocated]);

    expect(current.map((a) => a.id)).toEqual(['from-relocate']);
    expect(archived.map((a) => a.id)).toEqual(['from-root-scan']);
  });
});
