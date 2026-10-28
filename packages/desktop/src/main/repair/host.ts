/**
 * 修复引擎在**真机上**的接线（FEAT-03）—— 引擎本身不 import electron，这一层负责。
 *
 * 两条入口（`--repair` 独立窗口 / 设置页嵌入）共用这里的同一个 `RepairSession`，
 * 差别只在窗口与 IPC 通道，不在判据。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { CONFIG_FILE_NAME, GATEWAY_WS_PORT } from '@clawwork/shared';
import type { LanguageCode } from '@clawwork/shared';
import type { RepairSession, LiveInstanceProbe, SkillRecordsAccess } from './engine.js';
import { createRepairSession } from './engine.js';
import { resolveRepairTargets, type RepairTargets } from './targets.js';
import { readConfig, updateConfig } from '../workspace/config.js';
import { readInstanceOwner } from '../runtime/instance-guard.js';
import { probePidLiveness } from '../runtime/process-liveness.js';
import { parseListeningPid } from '../runtime/port-occupant.js';
import { getPortableRoots } from '../runtime/portable-root.js';
import { resolveBundledRuntimeRoot } from '../runtime/locate.js';

export interface RepairHost {
  targets: RepairTargets;
  userDataDir: string;
  appVersion: string;
  bundledRuntimeRoot: string | null;
  isPackaged: boolean;
}

/**
 * 这台机器上的修复目标。
 *
 * ⚠️ **不枚举盘**：`getPortableRoots()` 的惰性兜底只做两条纯文件判据（盘根 marker /
 *    交付夹形状）。枚举是一次 PowerShell（秒级），而修复工具允许在"工作区已经建坏"
 *    的状态下跑 —— 那一步会弹选盘对话框，正是我们要绕开的东西。判不出来就按本机安装
 *    形态退化成"只看 userData"，并在报告里如实说。
 */
export function resolveRepairHost(opts: {
  userDataDir: string;
  isPackaged: boolean;
  resourcesPath: string | null;
  appVersion: string;
}): RepairHost {
  const roots = getPortableRoots();
  return {
    targets: resolveRepairTargets({
      userDataDir: opts.userDataDir,
      programDir: path.dirname(process.execPath),
      portableRoots: roots,
    }),
    userDataDir: opts.userDataDir,
    appVersion: opts.appVersion,
    bundledRuntimeRoot:
      resolveBundledRuntimeRoot({
        isPackaged: opts.isPackaged,
        ...(opts.resourcesPath ? { resourcesPath: opts.resourcesPath } : {}),
      }) ?? null,
    isPackaged: opts.isPackaged,
  };
}

/**
 * 「本机是不是已经有一份在跑」—— 三条独立判据，任一命中就禁止写动作。
 *
 * ① 单实例锁的主人还活着（正常启动的那一份刚写过这个文件）
 * ② 18789 上有监听（可能是孤儿网关、可能是另一份，**不猜是谁**）
 * ③ 扫到一把实锤在跑的网关锁（引擎内部判，见 `detectLiveInstance`）
 */
export function createHostLiveInstanceProbe(opts: { dataRoot: string; port?: number }): LiveInstanceProbe {
  const port = opts.port ?? GATEWAY_WS_PORT;
  return {
    ownerAlive: () => {
      const owner = readInstanceOwner({ userDataDir: opts.dataRoot });
      if (!owner) return null;
      return { alive: probePidLiveness(owner.pid) === 'alive', pid: owner.pid };
    },
    portListener: () => {
      if (process.platform !== 'win32') return null;
      try {
        const output = execFileSync('netstat', ['-ano', '-p', 'tcp'], {
          timeout: 2_000,
          windowsHide: true,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        return parseListeningPid(output, port);
      } catch {
        // 查不到 = 不知道，不是"没有"（但也不能因此禁止一切；保守方向取"没占"）
        return null;
      }
    },
  };
}

/**
 * 用户上次选的语言（修复窗口要跟界面一致）。
 *
 * ⚠️ **不用 `readConfig()`**：它在配置损坏时会**当场改名隔离**（`config.corrupted-<时间戳>`）——
 *    那是一次没经用户确认的写动作，而修复工具的纪律是"动手前先预览"。
 *    这里只读一次 JSON，坏就回 `null`（界面退回系统语言）。
 */
export function readPersistedLanguage(dataRoot: string): LanguageCode | null {
  try {
    const raw = fs.readFileSync(path.join(dataRoot, CONFIG_FILE_NAME), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const language = (parsed as { language?: unknown }).language;
    return typeof language === 'string' && language.length > 0 ? (language as LanguageCode) : null;
  } catch {
    return null;
  }
}

/**
 * 技能账（`bundledSkillRecords`）的真机读写面（T31）。
 *
 * ⚠️ **不无脑走 `readConfig()`**：它在配置坏 JSON 时会**当场改名隔离**
 *    （`config.corrupted-<时间戳>`）—— 那是一次没经用户确认的写动作，与修复模式的
 *    "动手前先预览"冲突（同一个坑 `readPersistedLanguage()` 已经绕过一次）。
 *    所以先纯读一次 JSON：坏 ⇒ 直接回 `null`（这一项报"读不到"，一个字节都不动）。
 */
export function createHostSkillRecordsAccess(): SkillRecordsAccess {
  const configPath = (): string => path.join(app.getPath('userData'), CONFIG_FILE_NAME);
  return {
    read: () => {
      const file = configPath();
      try {
        JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        // 不存在 / 坏 JSON：到此为止，绝不触发 readConfig 的改名隔离
        return null;
      }
      try {
        const config = readConfig();
        return config ? { records: config.bundledSkillRecords ?? {}, configPath: file } : null;
      } catch {
        return null;
      }
    },
    write: (records) => {
      try {
        updateConfig({ bundledSkillRecords: records });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function createSessionForHost(host: RepairHost, now: () => Date = () => new Date()): RepairSession {
  return createRepairSession({
    targets: host.targets,
    appVersion: host.appVersion,
    bundledRuntimeRoot: host.bundledRuntimeRoot,
    isPackaged: host.isPackaged,
    now,
    liveInstance: createHostLiveInstanceProbe({ dataRoot: host.targets.dataRoot }),
    skillRecords: createHostSkillRecordsAccess(),
  });
}
