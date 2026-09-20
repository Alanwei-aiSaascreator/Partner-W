/**
 * 「本机的另一份已经在跑了」——把交付包里那个 `.bat` 唯一在做的事搬进程序（T-U4）。
 *
 * 为什么必须搬进来：单实例锁抢不到时旧行为是**裸 `app.quit()`** ——
 * 用户看到的就是"双击了没反应"，于是交付包里只好放一个 .bat 去 tasklist 查一遍
 * 再 echo 一段人话。现在 U 盘那份的应用数据也在盘上（见 `portable-app-data.test.ts`），
 * 交付包里不再需要 .bat，这句话就必须由程序自己说。
 *
 * ⚠️ 读取侧**一律不抛**：这是个"说不清就别说"的诊断文件，坏文件/没权限都必须
 *    退化成通用文案，绝不能让启动路径挂在一句解释上。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildInstanceBusyCopy,
  INSTANCE_OWNER_FILE,
  instanceOwnerPathFor,
  readInstanceOwner,
  recordInstanceOwner,
} from '../src/main/runtime/instance-guard.js';

describe('readInstanceOwner', () => {
  let dir = '';

  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    dir = mkdtempSync(path.join(tmpdir(), 'clawwork-instance-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('① 文件不存在 ⇒ null', () => {
    expect(readInstanceOwner({ userDataDir: dir })).toBeNull();
  });

  it('② 坏 JSON / 形状不对 ⇒ null（不抛）', () => {
    const file = instanceOwnerPathFor(dir);
    writeFileSync(file, '{ not json');
    expect(readInstanceOwner({ userDataDir: dir })).toBeNull();

    writeFileSync(file, JSON.stringify({ pid: 'x', exePath: 1 }));
    expect(readInstanceOwner({ userDataDir: dir })).toBeNull();

    writeFileSync(file, JSON.stringify({ pid: 42 }));
    expect(readInstanceOwner({ userDataDir: dir })).toBeNull();
  });

  it('③ 正常写进去的能读回来（真实临时目录往返）', () => {
    expect(
      recordInstanceOwner({ userDataDir: dir, exePath: 'E:\\荣盈魔方\\荣盈魔方.exe', portable: true, pid: 4242 }),
    ).toBe(true);

    expect(readInstanceOwner({ userDataDir: dir })).toEqual({
      pid: 4242,
      exePath: 'E:\\荣盈魔方\\荣盈魔方.exe',
      portable: true,
    });
  });

  it('④ 写失败（目录建不出来/盘只读）⇒ false，不抛', () => {
    const ok = recordInstanceOwner({
      userDataDir: dir,
      exePath: 'E:\\荣盈魔方\\荣盈魔方.exe',
      portable: true,
      write: () => {
        throw new Error('EPERM');
      },
    });

    expect(ok).toBe(false);
  });
});

describe('buildInstanceBusyCopy', () => {
  it('⑤ 知道是谁在跑 ⇒ 把那份的路径写出来（用户要能对上号）', () => {
    const copy = buildInstanceBusyCopy({
      owner: { pid: 1, exePath: 'E:\\荣盈魔方\\荣盈魔方.exe', portable: true },
      currentExePath: 'E:\\荣盈魔方\\荣盈魔方.exe',
    });

    expect(copy.title).toContain('已经在运行');
    expect(copy.detail).toContain('E:\\荣盈魔方\\荣盈魔方.exe');
    // 出口必须写清楚在哪儿找窗口（U 盘形态多半是托盘)
    expect(copy.detail).toContain('托盘');
    expect(copy.button).toBe('知道了');
  });

  it('⑥ 不知道是谁在跑 ⇒ 通用文案，不编造路径', () => {
    const copy = buildInstanceBusyCopy({ owner: null, currentExePath: 'E:\\荣盈魔方\\荣盈魔方.exe' });

    expect(copy.detail).not.toContain('E:\\');
    expect(copy.detail).toContain('托盘');
  });

  it('⑦ 主人是**另一条路径**上的那份 ⇒ 补一句"先退出那一份"', () => {
    const copy = buildInstanceBusyCopy({
      owner: { pid: 1, exePath: 'C:\\Users\\u\\AppData\\Local\\Programs\\魔方罗盘\\魔方罗盘.exe', portable: false },
      currentExePath: 'E:\\荣盈魔方\\荣盈魔方.exe',
    });

    expect(copy.detail).toContain('完全退出');
  });

  it('⑧ 主人就是本进程这条路径 ⇒ 不加"另一份"那句（同一个 exe 双击两次而已）', () => {
    const copy = buildInstanceBusyCopy({
      owner: { pid: 1, exePath: 'E:\\荣盈魔方\\荣盈魔方.exe', portable: true },
      currentExePath: 'e:\\荣盈魔方\\荣盈魔方.exe',
    });

    expect(copy.detail).not.toContain('完全退出');
  });
});

describe('INSTANCE_OWNER_FILE', () => {
  it('⑨ 落在 userData 里（单实例锁就是按这个目录算的 —— 读到的必然是同一个主人）', () => {
    expect(instanceOwnerPathFor('C:\\u\\@clawwork\\desktop')).toBe(
      path.win32.join('C:\\u\\@clawwork\\desktop', INSTANCE_OWNER_FILE),
    );
  });
});
