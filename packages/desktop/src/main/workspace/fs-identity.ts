import { closeSync, lstatSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, parse } from 'node:path';
import type { WorkspaceFsIdentity, WorkspaceFsIdentityState } from '@clawwork/shared';

/**
 * 量一量**工作区所在的文件系统**能不能支撑助手读写身份文件。
 *
 * ## 为什么需要（2026-09-24 真机定位，2026-09-25 落地）
 *
 * 同事那块盘上「几个助手失败」，日志里是 114 条一模一样的
 * `unsafe workspace file "IDENTITY.md"`。根因不在我们、也不在运行时坏了：
 * 随包运行时的 `@openclaw/fs-safe` 对"零身份"是 **fail-closed** ——
 *
 * > A zero Windows device or inode is **unknown**, not proof that a pathname still
 * > names the object we created. Cleanup must fail closed…
 *
 * 而 **FAT32 上 `dev` 恒为 0** ⇒ 凡走"变更/清理守卫"的路径必定失败 ⇒ 助手全废。
 *
 * ⭐ 实测三档：**FAT32 `dev=0` 必坏 / NTFS `dev≠0` 可用 / exFAT 见下**。
 *
 * ⚠️ **2026-09-27 纠正 —— exFAT 不是"可用"，我们之前写错了。**
 *
 *   原来这里写的是「exFAT `dev≠0` **可用**」。那条结论的问题是**它量的东西不够**：
 *   本探测只**建文件 + `lstat` 读 `dev`/`ino`**，**从来没有真写过一个文件**。
 *   于是它把「`dev≠0`」这个**代理指标**当成了「写入可用」这个**能力**。
 *
 *   真机反例（2026-09-27，58.6GB exFAT、簇 128KB）：同一份随包运行时的 `@openclaw/fs-safe`，
 *   **新文件 / 覆盖已有 / 建子目录 三条路全部失败**，底层是
 *   `inspect opened path failed with Windows error 87`（`ERROR_INVALID_PARAMETER`，
 *   发生在它**原生模块**的路径检查里）；同一序列在 NTFS 上三条全过。
 *   而 Node 自己的 `realpath.native` / `lstat` / `readdir` 在这块盘上**全是好的** ——
 *   所以**本探测（纯 Node）在原理上就看不见这个故障**。
 *
 *   ⇒ 结论：**本探测只能证伪（`dev=0` ⇒ 一定坏），不能证明"可用"。**
 *     `state: 'ok'` 的正确读法是"**没量到零身份**"，**不是**"这块盘写入没问题"。
 *     别再把它的 `ok` 当成能力保证 —— 顺 [[grep-presence-is-not-state]]。
 *   ⇒ 面向用户的结论：**只承诺 NTFS**。说明书与 `workspaceFilesystemUnsupported`
 *     文案都已按这一条改过，且各有一条反向守卫钉住（防止照旧结论改回去）。
 *
 * 客户端原来**认这个错**（`ws/gateway-client.ts` 写过回读缓解），但那条缓解的前提是
 * "其实写成功了、只是身份校验误报"，而 FAT32 上**回读也失败** ⇒ 缓解一次都没生效。
 * 用户看到的是「助手失败」，没有任何线索指向"换块盘"。这个探测就是把那条线索拿出来。
 *
 * ## 判据是量出来的，不是猜的
 *
 * 在**真实的工作区目录**里建一个探测文件、`lstat(bigint)` 看 `dev`/`ino`，然后删掉。
 * 不按盘符、不看卷标、不问 `DriveType`：那些都是"像不像 FAT32"，
 * 而 fs-safe 判的是**这两个数**。
 *
 * ⚠️ **两次探测**：Windows 在杀毒/索引器争用下会偶发返回零值（`sameFileIdentity`
 *    那条容忍零值的注释说的就是它）。所以只有**两次都零**才下结论；
 *    一次零一次不零 ⇒ `unknown`（不下结论、不上屏），宁可什么都不说也别冤枉一块好盘。
 */

/** 探测次数：1 次会被偶发零值骗到，2 次就够（再多也没意义，它们是同一瞬间的两份快照）。 */
const PROBE_COUNT = 2;

interface StatLike {
  dev: bigint;
  ino: bigint;
}

export interface WorkspaceFsIdentityDeps {
  /** 注入用（测试里模拟"这个卷上 dev/ino 恒为零"）。缺省 = `fs.lstatSync(..., { bigint: true })`。 */
  stat?: (filePath: string) => StatLike;
  /** 探测文件的前缀，带上就带上了 —— 探测失败时它是唯一能看出是谁留下的线索。 */
  probePrefix?: string;
  filesystemType?: (dir: string) => string | null;
}

function defaultStat(filePath: string): StatLike {
  const stats = lstatSync(filePath, { bigint: true });
  return { dev: stats.dev, ino: stats.ino };
}

export interface WorkspaceFilesystemTypeReadDeps {
  platform?: NodeJS.Platform;
  execFile?: (
    file: string,
    args: string[],
    options: { encoding: 'utf8'; timeout: number; windowsHide: boolean },
  ) => string;
}

/**
 * Read the volume format at the time of the probe.
 *
 * Portable drive letters are reusable: E: can be NTFS now and exFAT after a
 * device swap.  A process-lifetime cache (especially a cached `null`) turns a
 * transient lookup failure into a permanent safety bypass, so this deliberately
 * performs a fresh lookup for every capability check.
 */
export function readWorkspaceFilesystemType(dir: string, deps: WorkspaceFilesystemTypeReadDeps = {}): string | null {
  if ((deps.platform ?? process.platform) !== 'win32') return null;
  const root = parse(dir).root;
  if (!/^[a-z]:\\$/i.test(root)) return null;
  try {
    const drive = root.slice(0, 2);
    const run: NonNullable<WorkspaceFilesystemTypeReadDeps['execFile']> =
      deps.execFile ?? ((file, args, options) => execFileSync(file, args, options) as string);
    return run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `[System.IO.DriveInfo]::new('${drive}').DriveFormat`],
      { encoding: 'utf8', timeout: 5_000, windowsHide: true },
    ).trim();
  } catch {
    return null;
  }
}

function defaultFilesystemType(dir: string): string | null {
  return readWorkspaceFilesystemType(dir);
}

/** 零 = fs-safe 会 fail-closed 的那一侧（**任一为零**就算）。 */
function isZeroIdentity(identity: StatLike): boolean {
  return identity.dev === 0n || identity.ino === 0n;
}

export function probeWorkspaceFsIdentity(dir: string, deps: WorkspaceFsIdentityDeps = {}): WorkspaceFsIdentity {
  const stat = deps.stat ?? defaultStat;
  const filesystemType = (deps.filesystemType ?? defaultFilesystemType)(dir);
  if (filesystemType && filesystemType.toUpperCase() !== 'NTFS') {
    return {
      state: 'unsupported-identity',
      dev: null,
      ino: null,
      error: `unsupported filesystem: ${filesystemType}`,
    };
  }
  const prefix = deps.probePrefix ?? '.rongying-fs-probe-';
  const samples: StatLike[] = [];

  for (let i = 0; i < PROBE_COUNT; i += 1) {
    const filePath = join(dir, `${prefix}${randomUUID()}`);
    try {
      const fd = openSync(filePath, 'w');
      try {
        writeSync(fd, 'probe');
      } finally {
        closeSync(fd);
      }
      samples.push(stat(filePath));
    } catch (error) {
      return { state: 'unwritable', dev: null, ino: null, error: (error as Error).message };
    } finally {
      try {
        unlinkSync(filePath);
      } catch {
        /* 删不掉也要把结论给出来；留下的探测文件没有内容、名字带前缀，可辨认 */
      }
    }
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  if (!first || !last) return { state: 'unknown', dev: null, ino: null };

  const asResult = (state: WorkspaceFsIdentityState): WorkspaceFsIdentity => ({
    state,
    dev: first.dev.toString(),
    ino: first.ino.toString(),
  });

  if (isZeroIdentity(first) !== isZeroIdentity(last)) {
    // 一次零一次不零：偶发零值的典型形状（争用），不下结论。
    return asResult('unknown');
  }
  return asResult(isZeroIdentity(first) ? 'unsupported-identity' : 'ok');
}
