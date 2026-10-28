/**
 * 「本机的另一份已经在跑了」——把交付包里那个 `.bat` 唯一在做的事搬进程序（T-U4）。
 *
 * 背景：单实例锁（`app.requestSingleInstanceLock()`）抢不到时的旧行为是**裸
 * `app.quit()`** —— 用户看到的就是"双击了没反应"。交付包因此放了个
 * `①双击这里启动.bat`：先 `tasklist` 查一遍，查到就 echo 一段人话再退出。
 *
 * 现在交付包不带 `.bat` 了（盘上那份的应用数据也在盘上，见 `portable-app-data.ts`），
 * 这句话必须由程序自己说 —— 而且只有程序才知道**是哪一份**在跑。
 *
 * ⚠️ 为什么把"主人"写在 userData 里：单实例锁就是按 userData 目录算的
 *    （Chromium 的 ProcessSingleton 语义）—— 抢不到锁 ⇒ 那一位用的就是这个目录，
 *    所以这里读到的 owner 基本不会是别人。放别处（比如全局临时目录）反而会读到
 *    过期信息、把用户带到错的结论上。
 *
 * ⚠️ **一律不抛**：这是"说不清就别说"的诊断文件。坏文件、没权限、盘只读都必须
 *    退化成通用文案 —— 启动路径不许挂在一句解释上。
 */

import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/json-file.js';

/** 落在 userData 里的锁主人文件（`.app-instance-owner.json`）。 */
export const INSTANCE_OWNER_FILE = '.app-instance-owner.json';

export interface InstanceOwner {
  pid: number;
  /** 那一份的可执行文件路径（给用户对号入座用）。 */
  exePath: string;
  /** 那一份是不是盘上形态（日志用）。 */
  portable: boolean;
}

export function instanceOwnerPathFor(userDataDir: string): string {
  return path.join(userDataDir, INSTANCE_OWNER_FILE);
}

function pathKey(p: string): string {
  const normalized = path.normalize(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * 记下"这一份在跑"。**抢到锁之后立刻调用**（越早越好：第二次双击时才有得读）。
 *
 * 返回是否写成功 —— 调用方**不要**因为 false 做任何事（这只是诊断信息）。
 */
export function recordInstanceOwner(opts: {
  userDataDir: string;
  exePath: string;
  portable: boolean;
  pid?: number;
  /** 注入：测"盘只读"这条退路。 */
  write?: (file: string, value: unknown) => void;
}): boolean {
  const file = instanceOwnerPathFor(opts.userDataDir);
  const owner: InstanceOwner = { pid: opts.pid ?? process.pid, exePath: opts.exePath, portable: opts.portable };
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    (opts.write ?? ((f: string, v: unknown): void => writeJsonAtomic(f, v)))(file, owner);
    return true;
  } catch {
    return false;
  }
}

/** 读锁主人；读不到/读不懂一律 null。 */
export function readInstanceOwner(opts: {
  userDataDir: string;
  /** 注入：测坏文件。 */
  read?: (file: string) => string;
}): InstanceOwner | null {
  let raw: string;
  try {
    raw = (opts.read ?? ((f: string): string => readFileSync(f, 'utf8')))(instanceOwnerPathFor(opts.userDataDir));
  } catch {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const { pid, exePath, portable } = record;
    if (typeof pid !== 'number' || !Number.isFinite(pid)) return null;
    if (typeof exePath !== 'string' || exePath.trim().length === 0) return null;
    return { pid, exePath, portable: portable === true };
  } catch {
    return null;
  }
}

/**
 * 本机端口被占住时的文案（**另一条路**的"另一份在跑"）。
 *
 * ⚠️ 为什么现在必须有这句：盘上那份与"装到电脑"那份的应用数据是**分开**的
 *    （各自一个单实例锁，见 `portable-app-data.ts`），于是"两份同时开着"
 *    从"第二份根本起不来（有 .bat 解释）"变成了"第二份能开、但本地网关抢不到
 *    18789" —— 这个失败**必须说出来**：界面只会显示"连不上"，用户无从下手。
 *
 * ⚠️ 不许把"是另一份Partner-W占的"写成断言：18789 上也可能坐着别的程序。
 */
export function buildPortBusyCopy(opts: { port: number }): InstanceBusyCopy {
  return {
    title: '本机端口被占用',
    message: `Partner-W要用本机的 ${opts.port} 端口跑自己的大脑（本地网关），这个端口现在被占着，所以这次没能把它启动起来。`,
    detail: [
      '最可能是这台电脑上还开着另一份Partner-W（"装到电脑"的那份、或另一个 U 盘里的那份）—— 两份会抢同一个端口。',
      '',
      '请把那一份完全退出（托盘图标 → 右键 → 退出），再重新打开这一份。',
      '如果不是Partner-W占着的，请检查有没有别的程序在用这个端口。',
    ].join('\n'),
    button: '知道了',
  };
}

export interface InstanceBusyCopy {
  title: string;
  message: string;
  detail: string;
  button: string;
}

/**
 * 抢不到锁时给用户看的话（**纯函数**：文案要能被测，不许只活在 `index.ts` 里）。
 *
 * 三条必须说清的事：① 已经开着一份了（不是坏了）；② 那一份在哪（能对号）；③ 出口在哪
 * （托盘/任务栏 —— U 盘形态关窗口只是收进托盘，用户最容易在这里卡住）。
 */
export function buildInstanceBusyCopy(opts: { owner: InstanceOwner | null; currentExePath: string }): InstanceBusyCopy {
  const where = '到任务栏右下角的托盘区（小箭头里）找到它的图标，点开就能用；也可以在任务管理器里找到它。';
  const lines: string[] = [];
  if (opts.owner) {
    lines.push(`正在运行的是：`, opts.owner.exePath, '', where);
    // 主人是**另一条路径**上的那份（例如"装到电脑上"的那份）⇒ 得先把它退出，
    // 否则用户会一直双击、一直看到这句话。
    if (pathKey(opts.owner.exePath) !== pathKey(opts.currentExePath)) {
      lines.push('', '如果你要开的是另一份（比如 U 盘里的这一份），请先把已经打开的那份完全退出，再重新打开。');
    }
  } else {
    lines.push(where);
  }

  return {
    title: 'Partner-W已经在运行',
    message: '这台电脑上已经开着一份Partner-W了，所以这次没有重复打开。',
    detail: lines.join('\n'),
    button: '知道了',
  };
}
