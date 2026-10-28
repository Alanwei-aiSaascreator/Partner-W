/**
 * 冷启动开场片：视频层（增强）+ 吉祥物（兜底层）。
 *
 * 设计裁定（2026-10-05，施工图 §4/§6）：
 * - **默认态 = 现状**：素材缺失/404/解码失败/5s 无 canplay/reduced-motion → 视频永不登场，
 *   吉祥物独占（与未接视频前的页面逐字一致）。
 * - **循环**：播完回到 0 继续，直到用户点击"开始设置我的Partner-W"（stopRequested）或真实失败态。
 *   `loop=true` 时 Chromium 不派发 `ended`，状态机刻意不监听它。
 * - **声音**：默认带声（Electron 34 默认策略放行）；被拒/降级为静音继续播，按钮切到"打开声音"。
 * - **后台必停**：点窗口关闭 = hide 到托盘，不处理的话循环声音会在后台一直响。
 * - **红线**：任何视频事件都不许写进 `facts`、不许触碰 `deriveEntryPreparation`、
 *   不许改 `data-entry-continue` 的 disabled 条件（`test/entry-preparation-screen.test.tsx` 钉住）。
 *
 * ⚠️ U3/R6（2026-10-10 集中终审 §8）：**所有播放路径共用一套生命周期许可**。
 *    初始播放、静音降级、恢复前台、unmute 全部走 `playWithPermit`；许可判据
 *    （mounted / reduce-motion / stop / failed / unavailable / 后台）全部读**当前 refs**，
 *    不允许任何裸 `video.play()`。hidden / stop / failed / error / 动态 reduce-motion /
 *    卸载统一 `invalidateAndPause`（**pending 中也 pause**），任何迟到 resolve/reject
 *    先对号（attempt + 许可）再决定是否落状态。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX } from 'lucide-react';
import { OPENING_MEDIA_DIR_NAME, OPENING_MEDIA_SCHEME, OPENING_VIDEO_FILE_NAME } from '@clawwork/shared';

export const OPENING_VIDEO_URL = `${OPENING_MEDIA_SCHEME}://${OPENING_MEDIA_DIR_NAME}/${OPENING_VIDEO_FILE_NAME}`;
/** 产品要求"音量小"：自动播放的背景衬底，不是主内容。 */
export const OPENING_VIDEO_VOLUME = 0.3;
/** 慢盘/损坏文件的判定窗口（施工图 §4）。 */
export const OPENING_VIDEO_CANPLAY_TIMEOUT_MS = 5000;

type OpeningPhase = 'idle' | 'playing' | 'stopped' | 'unavailable';

interface OpeningMediaProps {
  /** 用户已点击"开始设置我的Partner-W"：暂停 + 淡出，本挂载内不再恢复。 */
  stopRequested: boolean;
  /** 真实失败态（hasError）：淡出，让错误信息成为焦点。 */
  failed: boolean;
  /** 与页面同源的 reduce-motion 判定：视频永不登场（动态开启同样作废在途播放）。 */
  reduceMotion: boolean;
}

export default function OpeningMedia({ stopRequested, failed, reduceMotion }: OpeningMediaProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  /**
   * R6：**捕获的最后 video 实例** —— 卸载清理跑在 ref 摘除之后（`videoRef.current`
   * 已是 null），要暂停得靠这个引用，不能只读已被清空的 ref。
   */
  const lastVideoRef = useRef<HTMLVideoElement | null>(null);
  const [phase, setPhase] = useState<OpeningPhase>(reduceMotion ? 'unavailable' : 'idle');
  const [muted, setMuted] = useState(false);
  const canPlayRef = useRef(false);
  const hiddenPausedRef = useRef(false);
  const phaseRef = useRef(phase);
  const stopRequestedRef = useRef(stopRequested);
  const failedRef = useRef(failed);
  const reduceMotionRef = useRef(reduceMotion);
  const mountedRef = useRef(true);
  /** R6：终态（unavailable）后一切播放许可作废。 */
  const unavailableRef = useRef(reduceMotion);
  /**
   * U3/R6：每次 `play()` 领一个号；stop/failed/hidden/error/reduced-motion/unmount
   * 使号失效。迟到的 resolve/reject 一律先对号 —— 不再允许"迟到的回调把播放带回来"。
   */
  const playAttemptRef = useRef(0);
  /** R6：在途 `play()` 计数（含静音降级重试）——"隐藏时是否要给恢复留一手"的判据。 */
  const pendingPlaysRef = useRef(0);
  /**
   * U3/R6：所有 play 入口共用的"当前播放许可"（全部读**当前 refs**：
   * mounted / reduce-motion / stop / failed / unavailable / 后台 任一即失效）。
   */
  const mayPlayNow = (): boolean =>
    mountedRef.current &&
    !reduceMotionRef.current &&
    !failedRef.current &&
    !stopRequestedRef.current &&
    !unavailableRef.current &&
    !document.hidden;
  /**
   * R6：统一"作废 + 暂停"（hidden / stop / failed / error / 动态 reduce-motion / 卸载共用）。
   * 暂停对象优先取活着的 ref、其次取捕获的最后实例；**pending 中也 pause**。
   */
  const invalidateAndPause = (): void => {
    playAttemptRef.current += 1;
    (videoRef.current ?? lastVideoRef.current)?.pause();
  };
  /** R6：整条兜底（error / 5s 超时）—— 作废 + 暂停 + 进终态。 */
  const markUnavailable = (): void => {
    unavailableRef.current = true;
    invalidateAndPause();
    setPhase('unavailable');
  };

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    stopRequestedRef.current = stopRequested;
  }, [stopRequested]);
  useEffect(() => {
    failedRef.current = failed;
  }, [failed]);
  /**
   * R6：动态开启 reduced-motion 与 stop/failed 同等处理 —— 即时刷新许可（ref）、
   * 作废在途 attempt 并暂停；迟到的 resolve 不许把"没有视频"的界面顶成 playing，
   * 也不许残留声音键。
   */
  useEffect(() => {
    reduceMotionRef.current = reduceMotion;
    if (!reduceMotion) return;
    invalidateAndPause();
    unavailableRef.current = true;
    setPhase((previous) => (previous === 'playing' ? 'unavailable' : previous));
  }, [reduceMotion]);
  // 挂载/卸载：卸载同样要作废 + 暂停（用捕获的最后实例）。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateAndPause();
    };
  }, []);

  // 5s 内没有 canplay（慢盘/损坏文件）→ 整条兜底。
  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setTimeout(() => {
      if (!canPlayRef.current) markUnavailable();
    }, OPENING_VIDEO_CANPLAY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  // 用户点击继续 → 暂停 + 淡出，本挂载内不再恢复（换账号/重试会整体重挂）。
  useEffect(() => {
    if (!stopRequested) return;
    invalidateAndPause(); // R6：在途 play 的迟到回调从此无效；pending 中也 pause
    setPhase((previous) => (previous === 'playing' ? 'stopped' : previous));
  }, [stopRequested]);

  // 真实失败态 → 暂停 + 淡出（错误信息是唯一焦点）。
  useEffect(() => {
    if (!failed) return;
    invalidateAndPause(); // R6：同上
  }, [failed]);

  // 后台必停：hide 到托盘后一声不出；回到可见且仍应播放时续播。
  useEffect(() => {
    const onVisibilityChange = () => {
      const video = videoRef.current;
      if (!video) return;
      if (document.hidden) {
        // R6：进后台把在途 attempt 一并作废（迟到的 resolve/reject/canplay 都别想恢复
        // 播放），并且**不管在途与否都 pause** —— 用"曾活跃"（playing 或 play 在途）
        // 决定回前台要不要补播，而不是用它决定要不要停声音。
        const wasActive = phaseRef.current === 'playing' || pendingPlaysRef.current > 0;
        invalidateAndPause();
        if (wasActive) hiddenPausedRef.current = true;
        return;
      }
      if (hiddenPausedRef.current) {
        hiddenPausedRef.current = false;
        playWithPermit();
        return;
      }
      // U3：canplay 是**后台期间**才到的（当时的起播被许可挡下）——回到可见且仍该播放 ⇒ 补上这一次。
      if (phaseRef.current === 'idle' && canPlayRef.current) playWithPermit();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
    // 处理函数只读 refs；`playWithPermit` 每帧重建但语义相同（refs + 页面级 prop）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * R6：**唯一的 play 入口**（初始播放 / 静音降级 / 恢复前台 / unmute 全走这里）。
   * 领号 → 许可 → 结算记账；所有 then/catch 都验 attempt、存活与许可。
   */
  const playWithPermit = (): void => {
    const video = videoRef.current;
    if (!video) return;
    if (!mayPlayNow()) return;
    const attempt = ++playAttemptRef.current;
    const stillCurrent = (): boolean => playAttemptRef.current === attempt && mayPlayNow();
    video.volume = OPENING_VIDEO_VOLUME;
    pendingPlaysRef.current += 1;
    video
      .play()
      .then(() => {
        pendingPlaysRef.current = Math.max(0, pendingPlaysRef.current - 1);
        if (stillCurrent()) setPhase('playing');
      })
      .catch(() => {
        pendingPlaysRef.current = Math.max(0, pendingPlaysRef.current - 1);
        // R6：迟到的 reject（期间 stop/failed/hidden/reduced-motion/重挂已发生）不得降级重试。
        if (!stillCurrent()) return;
        // 被策略拒/被系统静音/解码异常：降级为静音继续播，按钮切"打开声音"。二次失败 ⇒ 整条兜底。
        video.muted = true;
        setMuted(true);
        const retryAttempt = ++playAttemptRef.current;
        pendingPlaysRef.current += 1;
        video
          .play()
          .then(() => {
            pendingPlaysRef.current = Math.max(0, pendingPlaysRef.current - 1);
            if (playAttemptRef.current === retryAttempt && mayPlayNow()) setPhase('playing');
          })
          .catch(() => {
            pendingPlaysRef.current = Math.max(0, pendingPlaysRef.current - 1);
            if (playAttemptRef.current === retryAttempt && mayPlayNow()) markUnavailable();
          });
      });
  };

  const onCanPlay = () => {
    canPlayRef.current = true;
    lastVideoRef.current = videoRef.current;
    playWithPermit();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = !muted;
    setMuted(next);
    video.muted = next;
    // 打开声音是一个用户手势：此刻再 play() 一定被允许（若之前被策略压制过）。
    // R6：仍走**统一许可入口** —— stop/failed/隐藏/动态 reduce-motion 之后不许把播放带回来。
    if (!next) playWithPermit();
  };

  const videoVisible = phase === 'playing' && !failed;
  const showVideo = !reduceMotion && phase !== 'unavailable';

  // 全屏版（用户裁定 2026-10-06：王者荣耀登录页式 —— 视频铺满、内容压底、进度在下面走）：
  // - 视频：object-cover 铺满整窗；兜底时居中吉祥物（不再是左栏小槽位）。
  // - 静音/开声音：右上角浮层，在**视频可见**（playing 且未失败）时渲染。
  return (
    <div data-opening-phase={phase} className="relative h-full w-full">
      {showVideo && (
        <video
          ref={videoRef}
          src={OPENING_VIDEO_URL}
          preload="auto"
          loop
          playsInline
          disablePictureInPicture
          aria-hidden="true"
          tabIndex={-1}
          onCanPlay={onCanPlay}
          onError={() => markUnavailable()}
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
            videoVisible ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}
      {videoVisible && !reduceMotion && (
        <button
          type="button"
          aria-pressed={muted}
          aria-label={muted ? t('entryPreparation.mediaUnmute') : t('entryPreparation.mediaMute')}
          title={muted ? t('entryPreparation.mediaUnmute') : t('entryPreparation.mediaMute')}
          onClick={toggleMute}
          className="glass-scrim absolute right-5 top-5 z-20 flex items-center gap-1.5 rounded-full px-3 py-1.5 type-meta text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
        >
          {muted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          {muted ? t('entryPreparation.mediaUnmute') : t('entryPreparation.mediaMute')}
        </button>
      )}
    </div>
  );
}
