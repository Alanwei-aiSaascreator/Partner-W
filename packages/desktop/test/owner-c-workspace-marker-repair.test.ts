/**
 * Owner C / T15 —— 工作区标记**损坏**后的身份修复（RED→GREEN）。
 *
 * 合同依据：`PRODUCT_ARCHITECTURE.md` §7 / `2026-10-15-portable-first-start-contract.md`
 * 的 T15「盘符恢复」必验项之「标记损坏」。
 *
 * ## 缺陷（修前）
 *
 * `workspace/init.ts` 的 `writeWorkspaceMarker` 在标记文件**已存在**但**读不出**
 * （坏 JSON / 半截写 / 非对象）时，走 `if (!existing || …) return` —— 直接放弃，
 * **既不修复也不留痕**。后果是链式的：
 *
 *   ① `readWorkspaceId()` 永远返回 null ⇒ 这个工作区**永久没有身份**；
 *   ② 启动判定里 `configuredOrAsk` 会因「配置有 id ≠ 目录读出的 null」转
 *      `ask-user`（保守、正确），但用户确认之后 `startup.ts` 的 `locationOf()`
 *      会把 `workspaceId: readWorkspaceId(path)`（= null）写回配置 ⇒ **配置里的
 *      身份被静默清掉**，此后连"跨盘符自愈"都退化到最弱的那条判据；
 *   ③ 每次启动重复上述过程，工作区永远升级不成"身份可核证"的记录。
 *
 * ## 修法
 *
 * 标记文件**存在但不可读** ⇒ 把坏文件**改名保留**（`<marker>.corrupt-<ts>`，
 * 证据不丢 —— 与 quarantineUnusableLocks 同一条纪律），再写一份带新 `workspaceId`
 * 的标记。绝不原地覆盖、绝不直接删除。
 *
 * ⚠️ 只在 mkdtemp 里建删文件，绝不触碰真实工作区。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { ensureWorkspaceId, initWorkspace, readWorkspaceId } = await import('../src/main/workspace/init.js');

const MARKER = '.clawwork-workspace.json';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-c-workspace-marker-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function markerPath(): string {
  return join(dir, MARKER);
}

function backupEntries(): string[] {
  return readdirSync(dir).filter((name) => name.includes(`${MARKER}.`) || name.startsWith(`${MARKER}.corrupt`));
}

describe('T15 · 工作区标记损坏 ⇒ 修复身份（不许永久无身份）', () => {
  it('⭐ 坏 JSON 标记：修复后能读出 workspaceId', () => {
    writeFileSync(markerPath(), '{ this is not json', 'utf8');

    const id = ensureWorkspaceId(dir);

    expect(id, '损坏的标记必须被修复出身份，而不是永久返回 null').toBeTruthy();
    expect(readWorkspaceId(dir)).toBe(id);
  });

  it('⭐ 坏标记必须被**改名保留**（不得无备份删除/原地覆盖）', () => {
    const corrupt = '{"formatVersion":1,"app":"rongying-cube"  <<< truncated';
    writeFileSync(markerPath(), corrupt, 'utf8');

    ensureWorkspaceId(dir);

    const backups = backupEntries().filter((name) => name !== MARKER);
    expect(backups.length, '坏标记要留一份现场备份').toBeGreaterThan(0);
    const kept = readFileSync(join(dir, backups[0]), 'utf8');
    expect(kept, '备份必须是损坏前的原始字节').toBe(corrupt);
  });

  it('⭐ JSON 合法但不是对象（数组/标量）：同样算损坏并修复', () => {
    writeFileSync(markerPath(), '[1,2,3]', 'utf8');

    const id = ensureWorkspaceId(dir);

    expect(id).toBeTruthy();
    expect(backupEntries().filter((n) => n !== MARKER).length).toBeGreaterThan(0);
  });

  it('控制：标记**缺 workspaceId**（老格式）⇒ 原地补铸，不产生备份', () => {
    writeFileSync(markerPath(), `${JSON.stringify({ formatVersion: 1, app: 'rongying-cube' }, null, 2)}\n`, 'utf8');

    const id = ensureWorkspaceId(dir);

    expect(id).toBeTruthy();
    expect(backupEntries().filter((n) => n !== MARKER), '补铸不是损坏，不该留备份').toHaveLength(0);
  });

  it('控制：标记**已有** workspaceId ⇒ 原样保留（幂等，不换身份）', () => {
    const first = ensureWorkspaceId(dir);
    const second = ensureWorkspaceId(dir);

    expect(second).toBe(first);
    expect(readWorkspaceId(dir)).toBe(first);
  });

  it('控制：没有标记文件 ⇒ 新建（既有行为）', () => {
    expect(existsSync(markerPath())).toBe(false);

    const id = ensureWorkspaceId(dir);

    expect(id).toBeTruthy();
    expect(existsSync(markerPath())).toBe(true);
  });

  it('控制：initWorkspace 对损坏标记同样修复（首启/用户选择走这条）', async () => {
    writeFileSync(markerPath(), 'not json at all', 'utf8');

    await initWorkspace(dir);

    expect(readWorkspaceId(dir)).toBeTruthy();
  });
});
