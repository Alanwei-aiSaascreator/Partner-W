/**
 * 原子写 JSON。
 *
 * 为什么单独一个模块：客户端配置（`workspace/config.ts`）与运行时指针
 * （`runtime/deploy.ts`）需要**同一套**落盘语义，但 `workspace/config.ts` 依赖
 * `electron`（safeStorage 加密凭据），而装载器要能在没有 electron 的环境里被单测。
 * 规则放这里，两边共用 —— 且**这份实现是从 `writeConfig` 原样搬出来的**，
 * 行为逐条相同（见 `workspace-config.test.ts` 这层安全网）。
 */
import { closeSync, existsSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { dirname } from 'path';

/**
 * 目录 fsync —— 让 rename 这个目录项变更本身也落到盘上。
 *
 * ⚠️ **Windows 上做不到**：`openSync(dir, 'r')` 能成功，但 `fsyncSync` 必定 `EPERM`
 *    （2026-09-13 实测 node 26.3.1 / win32）。所以这里**刻意跳过**，而不是
 *    "试一下、失败就吞掉"—— 后者会让每次写配置都往日志里丢一条假错误，
 *    真出问题时反而看不见。POSIX 上照常做。
 */
function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  try {
    const dirFd = openSync(dir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (syncErr) {
    console.error('[json-file] failed to sync directory:', syncErr);
  }
}

/**
 * 把 `value` 序列化成 JSON 原子落盘。
 *
 * 「原子」= 任何时刻 `filePath` 要么是完整旧内容、要么是完整新内容，
 * 绝不会是被截断的半截 JSON（同卷 rename 是原子的）。
 *
 * ⚠️ fsync 不是多余的：没有它，rename 可能先于数据真正落盘，
 * 掉电后会留下一个**长度为 0 但名字正确**的文件 —— 而"文件在"正是我们的快路径判据。
 *
 * ⚠️ 不负责创建父目录（与原 `writeConfig` 一致）：调用方自己保证目录在。
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmpPath = filePath + '.tmp';
  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, 'w', 0o600);
    writeFileSync(fd, JSON.stringify(value, null, 2), { encoding: 'utf-8' });
    fsyncSync(fd);
    try {
      closeSync(fd);
    } finally {
      fd = null;
    }
    renameSync(tmpPath, filePath);
    syncDirectory(dirname(filePath));
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch (closeErr) {
        console.error('[json-file] failed to close temp file:', closeErr);
      }
    }
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch (cleanupErr) {
      console.error('[json-file] failed to remove temp file:', cleanupErr);
    }
    throw err;
  }
}
