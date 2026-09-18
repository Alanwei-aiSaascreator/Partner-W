/**
 * 「检查更新」的返回值 → 界面该显示的状态（唯一真源）。
 *
 * ⚠️ 为什么不能只看 `hasUpdate`（2026-09-18 实测）：检查完会**自动开始下载**
 *    （非便携形态，见 auto-updater.ts），用户进设置页时更新往往已经下好了。
 *    只看 `hasUpdate` 就会显示成「下载更新」，用户一点，主进程回一句"早下好了"，
 *    而界面停在 0% 的下载进度上再也不动。
 *    规则只有一句：**主进程说是什么状态，就显示什么状态**。
 *
 * `state` 是可选的：老 preload / 测试桩可能没有这个字段，那时退回 `available`
 * （有新版本 ⇒ 至少可以下载）。
 */
type UpdateUiStatus = 'idle' | 'available' | 'downloading' | 'downloaded';

interface UpdateCheckLike {
  hasUpdate: boolean;
  state?: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
}

export function updateStatusFromCheck(result: UpdateCheckLike): UpdateUiStatus {
  // 已下好/下载中优先于 hasUpdate 判定：主进程那边"有下好的包"和"这次检查报没报
  // 新版本"是两码事（检查也可能返回不了 updateInfo），别让界面因此把安装入口藏起来。
  if (result.state === 'downloaded') return 'downloaded';
  if (result.state === 'downloading') return 'downloading';
  if (!result.hasUpdate) return 'idle';
  return 'available';
}
