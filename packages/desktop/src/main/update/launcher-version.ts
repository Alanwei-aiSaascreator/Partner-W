import { spawn } from 'node:child_process';
import { parseSemanticVersion } from './portable-manifest.js';

/**
 * 盘上启动器的**真实版本**。
 *
 * 为什么需要它（2026-09-23 取证）：`ipc/update-handlers.ts` 以前把
 * `LAUNCHER_PROTOCOL_VERSION = '1.0.0'` 这个**硬编码**值当启动器版本传给服务，
 * `portable-manifest.ts:137-139` 拿它去比 `manifest.minLauncherVersion` ——
 * 比的是一个**我们编出来的数字**，不是盘上那个 exe 的版本 ⇒ `minLauncherVersion`
 * 是一道假门。
 *
 * 真值一直有通道，只是从没被调用：`launcher/cmd/partner-w-launcher/main.go:52-54` 收
 * `--version`、`:133-136` 把 `deps.version` 打到 stdout；版本由 ldflags
 * `-X main.version=<PARTNERW_LAUNCHER_VERSION>` 注入
 * （`scripts/lib/portable-launcher-build.mjs:49`）。
 *
 * 换成真值以后这道门才**真的**在办事，而且方向是对的："盘上启动器比清单要求的旧
 * ⇒ `launcher-incompatible`"意味着那份更新确实装不上，而该错误码对应的补救
 * （换一份新的完整交付包）也正是对的。
 *
 * ⚠️ 门槛的**来源**在 2026-09-23 的变量纠偏（`0aa532e2`）里被拆成两个量、两个名字：
 *   · 门槛 = `manifest.minLauncherVersion` ← `PARTNERW_MIN_LAUNCHER_VERSION`
 *     （**无默认值**，缺失即硬失败；`scripts/make-portable-update.mjs` 的
 *     `requireMinLauncherVersion()`），语义 = **最老的那个还能装这份更新的启动器**，
 *     通常就是当前基础包里那把；
 *   · `PARTNERW_LAUNCHER_VERSION` 只表示**本次构建的启动器自己的版本**
 *     （release.yml 的 `${RELEASE_TAG#v}`）——它**不再**决定门槛。
 * 两者曾共用一个名字，后果很具体：便携更新**从不更换启动器**（只能人工换基础包），
 * 于是 0.0.28 那次会把门槛写成 0.0.28、而盘上那把是 0.0.27
 * ⇒ 0.0.27 → 0.0.28 被 `launcher-incompatible` 挡死，且报错与真因对不上。
 * 硬编码的 '1.0.0' 之所以一直"没事"，只是因为它恰好 >= 真实版本而被蒙过去。
 *
 * ⚠️ 探测失败**不许静默退回某个版本号** —— 那正是这个洞本身。
 *    出口是 `{ kind: 'unavailable' }`，由服务把它变成**拒绝一切更新**
 *    （`launcher-incompatible`），并且把原因记进调试日志。
 */

/** 启动器认的唯一一个版本查询参数（见 `parseInvocation`）。 */
export const LAUNCHER_VERSION_ARGUMENT = '--version';

/** 探测超时：`--version` 只是解析内置文案然后打印一行，5 秒足够，卡住就必须放弃。 */
export const LAUNCHER_VERSION_PROBE_TIMEOUT_MS = 5_000;

export class LauncherVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LauncherVersionError';
  }
}

export type LauncherVersionProbeResult = { kind: 'version'; version: string } | { kind: 'unavailable'; reason: string };

export interface LauncherRunnerInput {
  launcherPath: string;
  args: string[];
  timeoutMs: number;
}

/** 跑一次启动器并拿到 stdout —— 注入点（单测不 spawn 真进程）。 */
export type LauncherRunner = (input: LauncherRunnerInput) => Promise<string>;

function clip(value: string, max = 64): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/**
 * 把 `--version` 的 stdout 归一成裸 semver；不合规就抛。
 *
 * 严格性复用 `portable-manifest.ts` 的 `parseSemanticVersion` —— 一份定义、
 * 两处使用，避免"清单认的版本"和"探测认的版本"漂移成两套。
 * 于是这些都会被拒（各自都有测试）：空输出、`dev`（ldflags 没注入时的 Go 默认值）、
 * `v0.0.27`（发布侧已经用 `RELEASE_TAG#v` 剥掉了 `v`，认了就等于放过一个坏构建）、
 * 以及多行输出（不做"猜哪一行"）。
 */
export function normalizeLauncherVersion(raw: string): string {
  const trimmed = raw.trim();
  try {
    parseSemanticVersion(trimmed);
  } catch {
    throw new LauncherVersionError(`the launcher reported a non-semver version: ${JSON.stringify(clip(trimmed))}`);
  }
  return trimmed;
}

/**
 * 真 spawn 一个启动器问版本。失败一律**抛**（由 `probeLauncherVersion` 收成
 * `unavailable`），这样"进程没起来"和"起来了但报的版本看不懂"在上层能区分开。
 */
export function spawnLauncherVersion(input: LauncherRunnerInput): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const child = spawn(input.launcherPath, input.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new LauncherVersionError(`probing the launcher version timed out after ${input.timeoutMs} ms`));
    }, input.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.once('error', (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new LauncherVersionError(`the launcher exited with code ${String(code)} for ${LAUNCHER_VERSION_ARGUMENT}`),
        );
        return;
      }
      resolve(stdout);
    });
  });
}

/**
 * 探测盘上启动器的版本。**永不抛**：拿不到就回 `unavailable` + 原因。
 */
export async function probeLauncherVersion(input: {
  launcherPath: string;
  runLauncher?: LauncherRunner;
  timeoutMs?: number;
}): Promise<LauncherVersionProbeResult> {
  const runLauncher = input.runLauncher ?? spawnLauncherVersion;
  const timeoutMs = input.timeoutMs ?? LAUNCHER_VERSION_PROBE_TIMEOUT_MS;

  let stdout: string;
  try {
    stdout = await runLauncher({ launcherPath: input.launcherPath, args: [LAUNCHER_VERSION_ARGUMENT], timeoutMs });
  } catch (error) {
    const reason = (error as Error | null)?.message ?? String(error);
    return { kind: 'unavailable', reason: `could not run the launcher: ${reason}` };
  }

  try {
    return { kind: 'version', version: normalizeLauncherVersion(stdout) };
  } catch (error) {
    const reason = (error as Error | null)?.message ?? String(error);
    return { kind: 'unavailable', reason };
  }
}
