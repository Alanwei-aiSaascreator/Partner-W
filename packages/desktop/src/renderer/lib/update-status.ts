import type { PortableUpdatePhase } from '@clawwork/shared';

/**
 * 「检查更新」的返回值 → 界面该显示的状态（唯一真源）。
 *
 * ⚠️ 为什么不能只看 `hasUpdate`（2026-09-18 实测）：检查完会**自动开始下载**
 *    （非便携形态，见 auto-updater.ts），用户进设置页时更新往往已经下好了。
 *    只看 `hasUpdate` 就会显示成「下载更新」，用户一点，主进程回一句"早下好了"，
 *    而界面停在 0% 的下载进度上再也不动。
 *    规则只有一句：**主进程说是什么状态，就显示什么状态**。
 *
 * 盘上运行（U 盘形态）走的是另一条链：主进程把签名的整目录包在**后台**下好、
 * 校验、解压、逐文件核对，全部通过才叫 `ready`。那之前的一切都算「准备中」，
 * 应用照常用；`ready` 之后才出现「立即重启更新」。
 *
 * ⚠️ `ready` **不许**并进 `available`：`available` 的意思是"发现了新版本、还能继续用"，
 *    `ready` 的意思是"已经验证完毕、重启就会换目录"。把后者显示成前者，用户点下去
 *    等的是下载、实际发生的是换目录。
 */
/**
 * 这个显示状态**允不允许**真的去换目录（调 `installUpdate` / 请求重启）。
 *
 * ⚠️ 单独抽成纯函数、而不是写在按钮的渲染条件里：渲染条件决定"按钮在不在"，
 *    而"换目录"是有副作用的动作 —— 双击、或被别处状态驱动着触到同一个 handler，
 *    都不该真的发出去。抽出来才**可证伪**（写在 JSX 里的话，删掉也全绿）。
 */
export function installAllowedForStatus(status: UpdateUiStatus | 'checking'): boolean {
  // ⚠️ 入参比 `UpdateUiStatus` 多一个 `'checking'`：那是设置页组件**本地**联合里
  //    才有的相位（"正在检查"），它同样不许换目录 —— 收窄入参会让调用点编不过。
  // 盘上形态：下载、验签、解压、逐文件核对全过才叫 `ready`。
  // 装机版：`downloaded` 才是"包已经下好"，其余（含一切失败相位）都不许。
  return status === 'ready' || status === 'downloaded';
}

export type UpdateUiStatus =
  | 'idle'
  | 'available'
  | 'downloading'
  | 'preparing'
  | 'ready'
  | 'downloaded'
  | 'applying'
  | 'committed'
  | 'rolled-back'
  | 'error';

type InstalledState = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';

/**
 * ⚠️ 只列**便携独有**的相位。`idle` / `checking` / `available` / `downloading` / `error`
 *    两条链都有，不能经这张表走：那会把已安装路径的「检查中 + 已知有新版本」从
 *    `available` 静默改成 `idle`，安装入口就此消失（0.0.21 实测踩过的同一类毛病）。
 */
const PORTABLE_ONLY_PHASES: Partial<Record<PortableUpdatePhase, UpdateUiStatus>> = {
  'verifying-archive': 'preparing',
  extracting: 'preparing',
  'verifying-files': 'preparing',
  ready: 'ready',
  applying: 'applying',
  'awaiting-health': 'applying',
  committed: 'committed',
  'rolled-back': 'rolled-back',
};

const PORTABLE_PHASE_TO_UI: Readonly<Record<PortableUpdatePhase, UpdateUiStatus>> = {
  idle: 'idle',
  checking: 'idle',
  available: 'available',
  downloading: 'downloading',
  'verifying-archive': 'preparing',
  extracting: 'preparing',
  'verifying-files': 'preparing',
  ready: 'ready',
  applying: 'applying',
  'awaiting-health': 'applying',
  committed: 'committed',
  'rolled-back': 'rolled-back',
  error: 'error',
};

interface UpdateCheckLike {
  hasUpdate: boolean;
  state?: InstalledState | PortableUpdatePhase;
}

export function portablePhaseToUiStatus(phase: PortableUpdatePhase): UpdateUiStatus {
  return PORTABLE_PHASE_TO_UI[phase];
}

export function updateStatusFromCheck(result: UpdateCheckLike): UpdateUiStatus {
  const portableOnly =
    result.state === undefined ? undefined : PORTABLE_ONLY_PHASES[result.state as PortableUpdatePhase];
  if (portableOnly !== undefined) return portableOnly;

  // 已下好/下载中优先于 hasUpdate 判定：主进程那边"有下好的包"和"这次检查报没报
  // 新版本"是两码事（检查也可能返回不了 updateInfo），别让界面因此把安装入口藏起来。
  if (result.state === 'downloaded') return 'downloaded';
  if (result.state === 'downloading') return 'downloading';
  if (!result.hasUpdate) return 'idle';
  return 'available';
}
