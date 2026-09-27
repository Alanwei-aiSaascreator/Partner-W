import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeWorkspaceFsIdentity } from '../src/main/workspace/fs-identity.js';

/**
 * 工作区所在**文件系统**能不能支撑助手读写（2026-09-25）。
 *
 * 为什么要有这一层：**FAT32 上 `dev = 0`**，而随包运行时的 `@openclaw/fs-safe`
 * 对"零身份"是 **fail-closed**（注释原话：零值是 *unknown*，不是"还是我们建的那个文件"的证明）
 * ⇒ 六个预置助手全部报 `unsafe workspace file "IDENTITY.md"`，界面只说"助手失败"，
 * 用户完全无从判断（同事那块盘的真机形状：114 条 `agents.files.get` 全是这一句）。
 *
 * 判据是**量出来的**（在目标目录真建一个文件、真 lstat），不是按盘符/卷标猜：
 * 实测三档 —— FAT32 `dev=0` 必坏 / NTFS `dev≠0` 可用 / **exFAT 见下**。
 *
 * ⚠️ **2026-09-27 纠正**：这里原来写的是「exFAT `dev≠0` **可用**」，**那是错的**。
 *    本探测只建文件 + `lstat` 读 `dev`/`ino`，**从来没真写过一个文件** ——
 *    把「`dev≠0`」这个代理指标当成了「写可用」这个能力。
 *    真机反例：同一份 `@openclaw/fs-safe`，在 58.6GB exFAT（簇 128KB）上
 *    新文件/覆盖/建子目录**三条全失败**（底层 `Windows error 87`），NTFS 上三条全过。
 *    而 Node 自己的 `realpath.native` / `lstat` 在那块盘上全是好的
 *    ⇒ **本探测在原理上看不见这个故障**。
 *    ⇒ 它的 `ok` 只能读作「**没量到零身份**」，**不是**「这块盘写入没问题」。
 *      即：**只能证伪，不能证明。** 顺 [[grep-presence-is-not-state]]。
 *
 * ⚠️ 探测必须在**真实的工作区目录**里做：fs-safe 校验的是工作区里那些身份文件所在的卷。
 */

const temps: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-identity-'));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  while (temps.length) fs.rmSync(temps.pop()!, { recursive: true, force: true });
});

/** 假 stat：模拟"这个文件系统上 dev/ino 恒为零"。 */
function zeroStat(dev = 0n, ino = 851386624n) {
  return () => ({ dev, ino });
}

describe('probeWorkspaceFsIdentity', () => {
  it('普通的可写目录（本机 NTFS）⇒ ok，并把量到的 dev/ino 带出来', () => {
    const dir = tmpDir();
    const result = probeWorkspaceFsIdentity(dir);
    expect(result.state).toBe('ok');
    expect(result.dev).not.toBeNull();
    expect(result.dev).not.toBe('0');
  });

  it('⭐ 两次探测都量到零身份 ⇒ unsupported-identity（FAT32 的形状）', () => {
    const result = probeWorkspaceFsIdentity(tmpDir(), { stat: zeroStat() });
    expect(result.state).toBe('unsupported-identity');
    expect(result.dev).toBe('0');
  });

  it('⭐ 只有 ino 为零 ⇒ 同样算 unsupported（fs-safe 的判据是"任一为零"）', () => {
    const result = probeWorkspaceFsIdentity(tmpDir(), { stat: zeroStat(1611287400n, 0n) });
    expect(result.state).toBe('unsupported-identity');
  });

  it('⭐ 两次探测结果**不一致** ⇒ unknown（可能是杀毒/索引器争用造成的偶发零值，不许下结论）', () => {
    let call = 0;
    const result = probeWorkspaceFsIdentity(tmpDir(), {
      stat: () => {
        call += 1;
        return call === 1 ? { dev: 0n, ino: 1n } : { dev: 1611287400n, ino: 4785074606070117n };
      },
    });
    expect(result.state).toBe('unknown');
  });

  it('目录不存在 / 建不出探测文件 ⇒ unwritable（不是"文件系统不支持"）', () => {
    const missing = path.join(tmpDir(), 'nope', 'deeper');
    const result = probeWorkspaceFsIdentity(missing);
    expect(result.state).toBe('unwritable');
    expect(result.error).toBeTruthy();
  });

  it('探测不留垃圾：跑完目录里不多任何文件', () => {
    const dir = tmpDir();
    probeWorkspaceFsIdentity(dir);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('负对照：探测完再放一个真文件，目录里只剩它（证明"不留垃圾"不是因为压根没建过）', () => {
    const dir = tmpDir();
    probeWorkspaceFsIdentity(dir);
    fs.writeFileSync(path.join(dir, '真实文件.txt'), 'x');
    expect(fs.readdirSync(dir)).toEqual(['真实文件.txt']);
  });
});
