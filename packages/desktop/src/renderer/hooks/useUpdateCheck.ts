import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';

/**
 * 启动后查一次更新（T-U3），并保持"长期不退出也能发现更新"（2026-10-11 升级补齐）。
 *
 * 「只亮一个红点」对远程/无人值守的用户等于没有：他们不会主动进设置翻。所以这里在
 * 发现新版本时给一条**可操作**的提示，直接把用户送到「设置 → 关于」那条已有的
 * 检查/下载/安装流程上（非便携形态下检查完就会自动开始下载，所以多数情况下
 * 点过去时已经在下载或已下载完；U 盘形态不下载，那边会提示"换包"）。
 *
 * ⚠️ 失败只记日志：更新检查失败不该打扰用户（离线、公司网络挡了更新源都很常见），
 *    更不能阻断聊天 —— 这里一切异常都在本地吞掉。
 *
 * 检查时机（四个来源，全部复用**现有**的 `window.clawwork.checkForUpdates()`，
 * 不新增推送服务/下载器）：
 *   · 启动 5 秒后（保留原行为）；
 *   · 每 30 分钟一次（长期不退出的挂机用户）；
 *   · `online`（离线启动后恢复联网）；
 *   · `visibilitychange → visible`（回前台/把最小化的窗口拉回来）。
 *
 * 三条节流纪律（防止事件源互相叠加把请求打爆）：
 *   · **请求进行中去重**：任何来源在飞的时候，后续触发都并入同一个请求；
 *   · **事件类检查 60 秒节流**：`online`/回前台/周期三种**事件**之间至少间隔 60 秒
 *     （启动那次是初始检查，不占事件节流额度 —— 所以"启动离线、随后恢复联网"
 *     能立刻补查一次）；
 *   · **同频道同版本的提示每应用生命周期仅一次**：30 分钟一轮的周期检查不会
 *     同一条更新反复弹 toast（红点 `hasUpdate` 照常保持）。
 *
 * 手动检查（设置 → 关于的按钮）走的是同一条 `window.clawwork.checkForUpdates()`，
 * 但**不经过本 hook**：这里从不包裹/替换那个 API，节流管不到手动路径。
 */

/** 启动后多久做第一次检查（保留 T-U3 的 5 秒）。 */
const STARTUP_DELAY_MS = 5_000;
/** 周期检查间隔。 */
const PERIODIC_INTERVAL_MS = 30 * 60_000;
/** 事件类检查之间的最小间隔。 */
const EVENT_THROTTLE_MS = 60_000;

interface UpdateCheckOutcome {
  hasUpdate: boolean;
  latestVersion?: string;
  currentVersion?: string;
  /**
   * 这次结果**实际归属**的频道（`'stable' | 'beta'`，主进程给）。
   *
   * ⚠️ B2（2026-10-11 整改）：盘上形态的「已就绪候选」可能属于**上一个频道**的事务
   *    （切了频道但事务没丢）—— 归属必须按事务实际频道记，不能按当前设置；
   *    旧 preload / 测试桩没有这个字段时退回"发起时读到的频道"（见 runUpdateCheck）。
   */
  channel?: string;
  /** 主进程的更新状态（`'available' | 'downloading' | 'ready' | …`）—— 见 ACTIVE_UPDATE_STATES。 */
  state?: string;
}

/**
 * ⭐ B2（复审二轮）：仍算「**有效在途/就绪事务**」的检查状态 —— 这些结果即使归属旧频道
 * 也**不许被丢**（盘上 ready 候选、装机版下载中/已下载都是可安装资产，提示要留、
 * 通知键要按事务实际频道记）。其余状态（available/idle/error/checking）在"检查在飞时
 * 用户切了频道"的场景里描述的是**旧频道的一次普通检查**，已经过期 ⇒ 整条忽略。
 *
 * 对齐主进程：便携事务相位（`auto-updater.PORTABLE_OPERATION_PHASES`）+ electron-updater
 * 的下载态（downloading/downloaded）。
 */
const ACTIVE_UPDATE_STATES: ReadonlySet<string> = new Set([
  'downloading',
  'downloaded',
  'verifying-archive',
  'extracting',
  'verifying-files',
  'ready',
  'applying',
  'awaiting-health',
]);

interface UpdateCheckContext {
  t: (key: string) => string;
  /**
   * 打**应用级**「更新与关于」弹窗（2026-10-19）。
   *
   * ⚠️ 绝不能改成"打开设置 → 关于"：设置页只在工作区挂载，登录页/准备页点了没反应
   *    （这正是用户报的问题）。弹窗挂在 App 层，任何界面都能落到同一个可操作界面。
   */
  openUpdateDialog: () => void;
  setHasUpdate: (has: boolean) => void;
  /** 卸载/销毁标记：晚到的答复不再动 store、不再弹提示。 */
  disposed: () => boolean;
}

/**
 * ⚠️ 这三个都是**模块作用域**（= 应用生命周期），不是组件实例状态：
 *    「每应用生命周期仅一次」这条纪律必须扛得住组件重挂载（哪怕只是重挂载）。
 *    测试用 {@link resetUpdateCheckLifecycleForTests} 复位。
 */
let inFlightCheck: Promise<void> | null = null;
let lastEventCheckStartedAt = 0;
const toastedUpdateKeys = new Set<string>();
/**
 * 检查**请求序号**（每次 runUpdateCheck 递增）。
 *
 * ⚠️ B2：响应必须按"**实际检查频道＋请求序号**"归属 —— 晚到的旧请求答复
 * （期间已有更新的检查发起）不再有写 status/写去重键的资格。
 */
let updateCheckSequence = 0;

/** 测试用：整表复位（模块级状态）。 */
export function resetUpdateCheckLifecycleForTests(): void {
  inFlightCheck = null;
  lastEventCheckStartedAt = 0;
  toastedUpdateKeys.clear();
  updateCheckSequence = 0;
}

async function runUpdateCheck(context: UpdateCheckContext): Promise<void> {
  try {
    // ⚠️ **请求归属在发起这一刻锁定**（频道 + 序号）。绝不 await 完再读当前设置
    //    冒充"这次检查的频道" —— 那正是 B2 的真身：stable 请求在飞、用户切到 beta，
    //    晚到的 stable 答复被记成 `beta::1.1.0`，把 beta 频道的通知键吃掉了。
    const requestChannel = useSettingsStore.getState().settings?.updateChannel ?? 'stable';
    const sequence = ++updateCheckSequence;
    const result = (await window.clawwork.checkForUpdates()) as UpdateCheckOutcome | undefined;
    if (context.disposed()) return;
    // ① 已被更新的请求取代 ⇒ 整条忽略：红点 / 去重键都不许被旧结果改写。
    if (sequence !== updateCheckSequence) return;
    // ② 实际检查/候选频道：主进程给了就信主进程（旧 ready 事务可能属于旧频道，
    //    那是**依然有效**的候选，提示不能丢、键必须记在它的频道名下）；
    //    没给（旧 preload / 测试桩）则退回发起时读到的频道。
    const reportedChannel = typeof result?.channel === 'string' ? result.channel : undefined;
    const attributedChannel = reportedChannel ?? requestChannel;
    // ③ ⭐ B2（复审二轮）：**归属必须对上当前设置**，且看的是实际入口的全量判据 ——
    //    真实 IPC 总带 channel，只看"channel 缺省"既挡不住旧频道的普通结果（红点被
    //    错误点亮、通知键被旧频道吃掉），也挡不住手动入口发起的旧检查。
    //    设置频道在飞行途中变过 ⇒ 这份答复描述的是**旧频道**的检查：
    //      · 普通结果（available/idle/error…）—— 已过期，整条忽略（红点与键都不许写）；
    //      · 在途/就绪事务（下载中/已下载/ready…）—— 仍是可安装资产，如实保留并按
    //        **事务实际频道**记账（见 ACTIVE_UPDATE_STATES）。
    //    旧 preload（没有 channel 字段）：无法归因，沿用旧口径 —— 设置动过就忽略。
    if ((useSettingsStore.getState().settings?.updateChannel ?? 'stable') !== attributedChannel) {
      const activeTransaction = reportedChannel !== undefined && ACTIVE_UPDATE_STATES.has(String(result?.state ?? ''));
      if (!activeTransaction) return;
    }
    const hasUpdate = result?.hasUpdate === true;
    // ⚠️ 两个方向都要写：只写 true 的话，红点一旦点亮就再也不会灭
    //    （`setHasUpdate` 这里全仓库唯一的写入点），用户手动查完"已是最新"也还亮着。
    context.setHasUpdate(hasUpdate);
    if (!hasUpdate) return;

    // 「同**频道**同版本」才算同一条更新：切到另一个频道后遇到同一个版本号时，
    // 那次提示的上下文已经不同了（用户主动换了渠道），允许再提示一次。
    const version = String(result?.latestVersion ?? result?.currentVersion ?? '');
    const key = `${attributedChannel}::${version}`;
    if (toastedUpdateKeys.has(key)) return;
    toastedUpdateKeys.add(key);

    toast(context.t('leftNav.updateAvailable'), {
      action: {
        label: context.t('settings.checkForUpdates'),
        onClick: () => context.openUpdateDialog(),
      },
    });
  } catch (err) {
    console.error('[useUpdateCheck] check failed:', err);
  }
}

/**
 * 所有健康/周期/事件触发的**唯一入口**：这里集中执行去重与节流。
 * 返回本次（或正在飞行的）请求；被节流吞掉时返回 `null`。
 */
function scheduleUpdateCheck(
  trigger: 'startup' | 'periodic' | 'online' | 'foreground',
  context: UpdateCheckContext,
): Promise<void> | null {
  if (inFlightCheck) return inFlightCheck;
  if (trigger !== 'startup') {
    const now = Date.now();
    if (now - lastEventCheckStartedAt < EVENT_THROTTLE_MS) return null;
    lastEventCheckStartedAt = now;
  }
  const run = runUpdateCheck(context).finally(() => {
    if (inFlightCheck === run) inFlightCheck = null;
  });
  inFlightCheck = run;
  return run;
}

/**
 * @param enabled 默认 `true`（**所有界面**都可以检查并提示）。
 *
 *   2026-10-19 用户反馈：新版本提示只在进入工作区后才出现，登录页看不到、也没法下载。
 *   之前之所以只在工作区开，是因为提示的落点写死成"设置 → 关于"，而设置页只在工作区挂载
 *   ⇒ 登录页点了没反应。现在落点改成 App 层的「更新与关于」弹窗（`UpdateDialog`），
 *   任何界面都能打开、都能下载，**不需要登录**，所以这里不再按界面门控。
 */
export function useUpdateCheck(enabled = true): void {
  const { t } = useTranslation();
  // ⚠️ `t` 走 ref：它每个渲染都是新函数，直接进依赖数组会让 effect 重挂
  //    （语言一变就重新起 5 秒启动计时器 = 多查一轮）。文案在**用的时候**取。
  const tRef = useRef(t);
  tRef.current = t;
  const setHasUpdate = useUiStore((s) => s.setHasUpdate);
  const setUpdateDialogOpen = useUiStore((s) => s.setUpdateDialogOpen);

  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    const context: UpdateCheckContext = {
      t: (key) => tRef.current(key),
      openUpdateDialog: () => setUpdateDialogOpen(true),
      setHasUpdate,
      disposed: () => disposed,
    };

    const startupTimer = window.setTimeout(() => {
      void scheduleUpdateCheck('startup', context);
    }, STARTUP_DELAY_MS);
    const periodicTimer = window.setInterval(() => {
      void scheduleUpdateCheck('periodic', context);
    }, PERIODIC_INTERVAL_MS);
    const onOnline = (): void => {
      void scheduleUpdateCheck('online', context);
    };
    const onVisibilityChange = (): void => {
      // 只认"回到可见"：切到后台不是查更新的时机。
      if (document.visibilityState === 'visible') void scheduleUpdateCheck('foreground', context);
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      disposed = true;
      window.clearTimeout(startupTimer);
      window.clearInterval(periodicTimer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, setHasUpdate, setUpdateDialogOpen]);
}
