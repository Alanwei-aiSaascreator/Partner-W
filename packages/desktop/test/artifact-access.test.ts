import { link, mkdtemp, mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  __testing,
  copyArtifactToDestination,
  inspectArtifactFile,
  rootDirFor,
} from '../src/main/artifact/access.js';

const roots: string[] = [];

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mofang-artifact-access-'));
  roots.push(root);
  await mkdir(join(root, 'task-1'), { recursive: true });
  return root;
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/**
 * 文件身份判定（`dev` + `ino`）—— 这一组钉的是 2026-09-19 查出的一次**偶发失败的真因**。
 *
 * 现象：`keeps an existing destination intact…` 每跑几十遍红一次，报
 * `expected … to throw 'disk full' but got 'destination matches source'`。
 * 单跑永远不红 ⇒ 一直被当成"测试抖动"。
 *
 * 真因（实测，本机 NTFS）：`ino` 是 **64 位**文件索引，而 Node 用 **JS Number** 暴露它。
 * 这台机器上的真实值在 ~1.1e16，**超过 2^53**（9.007e15）⇒ Number 的间距是 **2**
 * ⇒ **相邻的两个 ino 会舍入成同一个 Number**。实测连开 200 个文件撞了 **5 次**。
 *
 * 于是 `sameIdentity` 会把两个毫不相干的文件判成"同一个文件" ⇒ 保存被莫名拒绝。
 * ⚠️ 方向是**保守的**（宁可不存也不写坏），所以线上只会表现为"偶尔存不了"，
 *    不会损坏数据 —— 这也正是它一直没被当成 bug 的原因。
 */
describe('文件身份判定（64 位 ino 不许丢精度）', () => {
  /** 只造身份判定用得到的字段（`snapshotOf` 的入参就是按"它真正用到的"收窄的）。 */
  const statsWith = (ino: bigint, size = 1n): Parameters<typeof __testing.snapshotOf>[0] => ({
    dev: 1n,
    ino,
    size,
    mtimeMs: 1n,
    ctimeMs: 1n,
  });

  it('⭐ 两个不同的 64 位 ino 转成 number 后相等 ⇒ 仍必须判为**不同**文件', () => {
    // 前提先钉死：这两个数在 Number 下**确实**相等（否则这条用例是空的）
    expect(Number(10977524094393692n) === Number(10977524094393693n), '前提：它们舍入后相等').toBe(true);

    const a = __testing.snapshotOf(statsWith(10977524094393692n));
    const b = __testing.snapshotOf(statsWith(10977524094393693n));

    expect(__testing.sameIdentity(a, b), '丢精度会把两个不相干的文件判成同一个').toBe(false);
  });

  it('同一个文件（硬链接）必须仍判为相同 —— 这道保护不能被削弱', () => {
    const ino = 39125021765459235n;
    expect(__testing.sameIdentity(__testing.snapshotOf(statsWith(ino)), __testing.snapshotOf(statsWith(ino)))).toBe(
      true,
    );
  });

  it('换盘（dev 不同）即使 ino 撞上也要判为不同', () => {
    const left = __testing.snapshotOf({ ...statsWith(7n), dev: 1n });
    const right = __testing.snapshotOf({ ...statsWith(7n), dev: 2n });

    expect(__testing.sameIdentity(left, right)).toBe(false);
  });

  it('size / mtime / ctime 仍以 number 存（调用方到处按 number 用）', () => {
    expect(__testing.snapshotOf({ dev: 1n, ino: 1n, size: 7n, mtimeMs: 12n, ctimeMs: 34n })).toMatchObject({
      size: 7,
      mtimeMs: 12,
      ctimeMs: 34,
    });
  });
});

describe('artifact file access', () => {
  it('distinguishes available, missing, and unsafe files', async () => {
    const root = await workspace();
    await writeFile(join(root, 'task-1', 'report.txt'), 'trusted');

    await expect(inspectArtifactFile(root, 'task-1/report.txt')).resolves.toMatchObject({
      availability: 'available',
    });
    await expect(inspectArtifactFile(root, 'task-1/missing.txt')).resolves.toEqual({
      availability: 'missing',
    });
    await expect(inspectArtifactFile(root, '../outside.txt')).resolves.toEqual({ availability: 'unsafe' });
  });

  it.runIf(process.platform !== 'win32')('rejects a symlink even when it points inside the workspace', async () => {
    const root = await workspace();
    await writeFile(join(root, 'task-1', 'real.txt'), 'trusted');
    await symlink(join(root, 'task-1', 'real.txt'), join(root, 'task-1', 'alias.txt'));

    await expect(inspectArtifactFile(root, 'task-1/alias.txt')).resolves.toEqual({ availability: 'unsafe' });
  });

  it('copies an available artifact without changing the source', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const destination = join(root, 'exported.txt');
    await writeFile(source, 'final result');

    await expect(copyArtifactToDestination(root, 'task-1/report.txt', destination)).resolves.toEqual({
      status: 'saved',
      filePath: destination,
    });
    await expect(readFile(destination, 'utf8')).resolves.toBe('final result');
    await expect(readFile(source, 'utf8')).resolves.toBe('final result');
  });

  it('atomically replaces an existing destination after the save dialog has confirmed overwrite', async () => {
    const root = await workspace();
    const destination = join(root, 'exported.txt');
    await writeFile(join(root, 'task-1', 'report.txt'), 'new result');
    await writeFile(destination, 'old result');

    await expect(copyArtifactToDestination(root, 'task-1/report.txt', destination)).resolves.toEqual({
      status: 'saved',
      filePath: destination,
    });
    await expect(readFile(destination, 'utf8')).resolves.toBe('new result');
  });

  it('rejects missing, unsafe, and directory sources', async () => {
    const root = await workspace();
    const destination = join(root, 'exported.txt');

    await expect(copyArtifactToDestination(root, 'task-1/missing.txt', destination)).rejects.toThrow(
      'artifact missing',
    );
    await expect(copyArtifactToDestination(root, '../outside.txt', destination)).rejects.toThrow('artifact unsafe');
    await expect(copyArtifactToDestination(root, 'task-1', destination)).rejects.toThrow('artifact unsafe');
  });

  it('reports a destination failure and keeps the source intact', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    await writeFile(source, 'final result');

    await expect(
      copyArtifactToDestination(root, 'task-1/report.txt', join(root, 'missing', 'out.txt')),
    ).rejects.toThrow();
    await expect(readFile(source, 'utf8')).resolves.toBe('final result');
  });

  it('keeps an existing destination intact and removes only its temp file when writing fails', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const destination = join(root, 'exported.txt');
    await writeFile(source, 'new result');
    await writeFile(destination, 'keep me');

    await expect(
      __testing.copyArtifactToDestination(root, 'task-1/report.txt', destination, {
        writeChunk: async () => {
          throw new Error('disk full');
        },
      }),
    ).rejects.toThrow('disk full');

    await expect(readFile(destination, 'utf8')).resolves.toBe('keep me');
    expect((await readdir(root)).filter((name) => name.includes('.mofang-'))).toEqual([]);
  });

  it('rejects a destination hard-linked to the source without changing either name', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const destination = join(root, 'hardlink.txt');
    await writeFile(source, 'do not truncate');
    await link(source, destination);

    await expect(copyArtifactToDestination(root, 'task-1/report.txt', destination)).rejects.toThrow(
      'destination matches source',
    );
    await expect(readFile(source, 'utf8')).resolves.toBe('do not truncate');
    await expect(readFile(destination, 'utf8')).resolves.toBe('do not truncate');
  });

  it('preserves an existing destination when atomic publication fails', async () => {
    const root = await workspace();
    const destination = join(root, 'exported.txt');
    await writeFile(join(root, 'task-1', 'report.txt'), 'new result');
    await writeFile(destination, 'old result');

    await expect(
      __testing.copyArtifactToDestination(root, 'task-1/report.txt', destination, {
        publish: async () => {
          const error = new Error('replace unavailable') as NodeJS.ErrnoException;
          error.code = 'EPERM';
          throw error;
        },
      }),
    ).rejects.toThrow('Could not replace the selected file safely');
    await expect(readFile(destination, 'utf8')).resolves.toBe('old result');
    expect((await readdir(root)).filter((name) => name.includes('.mofang-'))).toEqual([]);
  });

  it('detects a source path swap after opening for copy and never publishes it', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const moved = join(root, 'task-1', 'original.txt');
    const destination = join(root, 'exported.txt');
    await writeFile(source, 'trusted');

    await expect(
      __testing.copyArtifactToDestination(root, 'task-1/report.txt', destination, {
        afterSourceOpen: async () => {
          await rename(source, moved);
          await writeFile(source, 'replacement');
        },
      }),
    ).rejects.toThrow('artifact changed while reading');
    await expect(readFile(destination, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('detects a source path swap while reading through the verified handle', async () => {
    const root = await workspace();
    const source = join(root, 'task-1', 'report.txt');
    const moved = join(root, 'task-1', 'original.txt');
    await writeFile(source, 'trusted');

    await expect(
      __testing.readVerifiedArtifactFile(root, 'task-1/report.txt', {
        afterSourceOpen: async () => {
          await rename(source, moved);
          await writeFile(source, 'replacement');
        },
      }),
    ).rejects.toThrow('artifact changed while reading');
  });
});

/**
 * 第二个受信根：**助手自己的工作区**（2026-09-27）。
 *
 * ## 现场
 *
 * 用户让助手做 PPT / HTML，文件**确实生成了**，但产物面板是空的。
 * 真机取证：`.clawwork.db` 里 `SELECT COUNT(*) FROM artifacts` = **0** ——
 * 产物表**从来没有过任何记录**，所以这不是"偶尔漏了"，是结构性的。
 *
 * 原因是原先只有**单一根**：所有 `localPath` 都当作相对**应用工作区**
 * （`<appWorkspace>/<taskId>/…`，见 `db/index.ts:91` 与 `workspace/init.ts`）。
 * 而助手把文件写在**它自己的工作区**（网关 `agents.entries.<id>.workspace`；
 * `main` = `<state>/workspace`，预置助手 = `<appWorkspace>/rongying-agents/<id>`）——
 * 那是任务目录的**兄弟**，永不重叠。
 *
 * ## ⚠️ 这一组真正要钉的**不是**"第二个根能用"
 *
 * 而是 **"多一个根没有把校验放松"**：下面每一条越界用例在单根时代就该红，
 * 现在**仍然**必须红。第二个根只是多了一个**允许的目录**，五道校验一条不减。
 */
describe('第二个受信根（助手工作区）', () => {
  /** 造一个"父目录 + agent 工作区"，用来验 `..` 越界。 */
  async function agentWorkspace(): Promise<{ root: string; parent: string }> {
    const parent = await mkdtemp(join(tmpdir(), 'mofang-agent-parent-'));
    roots.push(parent);
    const root = join(parent, 'agent-ws');
    await mkdir(root, { recursive: true });
    return { root, parent };
  }

  it('rootDirFor：缺省与未知都落回应用工作区（= 加这一列之前的行为）', () => {
    const both = { workspacePath: '/ws', agentWorkspacePath: '/agent' };
    expect(rootDirFor(both, undefined)).toBe('/ws');
    expect(rootDirFor(both, 'workspace')).toBe('/ws');
  });

  it('rootDirFor：agent 根读得到就用它', () => {
    expect(rootDirFor({ workspacePath: '/ws', agentWorkspacePath: '/agent' }, 'agent')).toBe('/agent');
  });

  it('⭐ rootDirFor：agent 根**读不到**时回 null，**绝不回落**到应用工作区', () => {
    // 回落会把 root:'agent' 的行解析到**别的目录**，而出错的方向恰好是
    // "把别的目录的文件当成这个任务的产物" ⇒ 宁可什么都不显示。
    expect(rootDirFor({ workspacePath: '/ws', agentWorkspacePath: null }, 'agent')).toBeNull();
  });

  it('⭐ 助手工作区里的文件能被正常解析 —— 这就是那个新根存在的理由', async () => {
    const { root } = await agentWorkspace();
    await mkdir(join(root, 'rongying-agents'), { recursive: true });
    await writeFile(join(root, 'rongying-agents', 'deck.pptx'), 'PPTX');

    expect(await inspectArtifactFile(root, 'rongying-agents/deck.pptx')).toMatchObject({
      availability: 'available',
    });
  });

  it('越界仍然被拒：`..` 爬到根外', async () => {
    const { root, parent } = await agentWorkspace();
    await writeFile(join(parent, 'sibling-secret.txt'), 'SECRET');

    expect((await inspectArtifactFile(root, '../sibling-secret.txt')).availability).toBe('unsafe');
  });

  it('越界仍然被拒：**绝对路径**', async () => {
    const { root } = await agentWorkspace();
    await writeFile(join(root, 'x.pptx'), 'X');

    expect((await inspectArtifactFile(root, join(root, 'x.pptx'))).availability).toBe('unsafe');
  });

  it('目录不算产物', async () => {
    const { root } = await agentWorkspace();
    await mkdir(join(root, 'sub'), { recursive: true });

    expect((await inspectArtifactFile(root, 'sub')).availability).toBe('unsafe');
  });

  // ⚠️ Windows 上建符号链接要权限 ⇒ 与文件里既有的那条同款跳过（那边也是这么处理的）。
  it.runIf(process.platform !== 'win32')('⭐ 符号链接仍然被拒：指向根外也不行', async () => {
    const { root, parent } = await agentWorkspace();
    await writeFile(join(parent, 'outside.txt'), 'SECRET');
    await symlink(join(parent, 'outside.txt'), join(root, 'link.txt'));

    expect((await inspectArtifactFile(root, 'link.txt')).availability).toBe('unsafe');
  });
});
