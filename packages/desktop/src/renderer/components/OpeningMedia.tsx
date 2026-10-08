/**
 * 冷启动开场片：视频层（增强）+ 吉祥物（兜底层）。
 *
 * 设计裁定（2026-10-05，施工图 §4/§6）：
 * - **默认态 = 现状**：素材缺失/404/解码失败/5s 无 canplay/reduced-motion → 视频永不登场，
 *   吉祥物独占（与未接视频前的页面逐字一致）。
 * - **循环**：播完回到 0 继续，直到用户点击"开始设置我的魔方"（stopRequested）或真实失败态。
 *   `loop=true` 时 Chromium 不派发 `ended`，状态机刻意不监听它。
 * - **声音**：默认带声（Electron 34 默认策略放行）；被拒/降级为静音继续播，按钮切到"打开声音"。
 * - **后台必停**：点窗口关闭 = hide 到托盘，不处理的话循环声音会在后台一直响。
 * - **红线**：任何视频事件都不许写进 `facts`、不许触碰 `deriveEntryPreparation`、
 *   不许改 `data-entry-continue` 的 disabled 条件（`test/entry-preparation-screen.test.tsx` 钉住）。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX } from 'lucide-react';
import { OPENING_MEDIA_DIR_NAME, OPENING_MEDIA_SCHEME, OPENING_VIDEO_FILE_NAME } from '@clawwork/shared';
import GuideMascot, { type GuideMascotPose } from '@/components/GuideMascot';

export const OPENING_VIDEO_URL = `${OPENING_MEDIA_SCHEME}://${OPENING_MEDIA_DIR_NAME}/${OPENING_VIDEO_FILE_NAME}`;
/** 产品要求"音量小"：自动播放的背景衬底，不是主内容。 */
export const OPENING_VIDEO_VOLUME = 0.3;
/** 慢盘/损坏文件的判定窗口（施工图 §4）。 */
export const OPENING_VIDEO_CANPLAY_TIMEOUT_MS = 5000;

type OpeningPhase = 'idle' | 'playing' | 'stopped' | 'unavailable';

interface OpeningMediaProps {
  /** 用户已点击"开始设置我的魔方"：暂停 + 淡出，本挂载内不再恢复。 */
  stopRequested: boolean;
  /** 真实失败态（hasError）：淡出，让错误信息成为焦点。 */
  failed: boolean;
  /** 与页面同源的 reduce-motion 判定：视频永不登场。 */
  reduceMotion: boolean;
  /** 透传给兜底吉祥物（视频正常时不可见）。 */
  pose: GuideMascotPose;
  label: string;
}

export default function OpeningMedia({ stopRequested, failed, reduceMotion, pose, label }: OpeningMediaProps) {
  const { t } = useTranslation();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<OpeningPhase>(reduceMotion ? 'unavailable' : 'idle');
  const [muted, setMuted] = useState(false);
  const canPlayRef = useRef(false);
  const hiddenPausedRef = useRef(false);
  const phaseRef = useRef(phase);
  const stopRequestedRef = useRef(stopRequested);
  const failedRef = useRef(failed);
  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);
  useEffect(() => {
    stopRequestedRef.current = stopRequested;
  }, [stopRequested]);
  useEffect(() => {
    failedRef.current = failed;
  }, [failed]);

  // 5s 内没有 canplay（慢盘/损坏文件）→ 整条兜底。
  useEffect(() => {
    if (reduceMotion) return;
    const timer = window.setTimeout(() => {
      if (!canPlayRef.current) setPhase('unavailable');
    }, OPENING_VIDEO_CANPLAY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [reduceMotion]);

  // 用户点击继续 → 暂停 + 淡出，本挂载内不再恢复（换账号/重试会整体重挂）。
  useEffect(() => {
    if (!stopRequested) return;
    videoRef.current?.pause();
    setPhase((previous) => (previous === 'playing' ? 'stopped' : previous));
  }, [stopRequested]);

  // 真实失败态 → 暂停 + 淡出（错误信息是唯一焦点）。
  useEffect(() => {
    if (failed) videoRef.current?.pause();
  }, [failed]);

  // 后台必停：hide 到托盘后一声不出；回到可见且仍应播放时续播。
  useEffect(() => {
    const onVisibilityChange = () => {
      const video = videoRef.current;
      if (!video) return;
      if (document.hidden) {
        // 用状态机判据而不是 video.paused：pause() 对已暂停元素是无害的，
        // 而状态能被测试确定性驱动（jsdom 的 paused 恒为 true）。
        if (phaseRef.current === 'playing') {
          hiddenPausedRef.current = true;
          video.pause();
        }
        return;
      }
      if (!hiddenPausedRef.current) return;
      hiddenPausedRef.current = false;
      if (phaseRef.current === 'playing' && !stopRequestedRef.current && !failedRef.current) {
        void video.play().catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const beginPlayback = () => {
    const video = videoRef.current;
    if (!video) return;
    if (reduceMotion || failedRef.current || stopRequestedRef.current) return;
    video.volume = OPENING_VIDEO_VOLUME;
    video
      .play()
      .then(() => setPhase('playing'))
      .catch(() => {
        // 被策略拒/被系统静音/解码异常：降级为静音继续播，按钮切"打开声音"。二次失败 ⇒ 整条兜底。
        video.muted = true;
        setMuted(true);
        video
          .play()
          .then(() => setPhase('playing'))
          .catch(() => setPhase('unavailable'));
      });
  };

  const onCanPlay = () => {
    canPlayRef.current = true;
    beginPlayback();
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const next = !muted;
    setMuted(next);
    video.muted = next;
    // 打开声音是一个用户手势：此刻再 play() 一定被允许（若之前被策略压制过）。
    if (!next)
      void video
        .play()
        .then(() => setPhase('playing'))
        .catch(() => {});
  };

  const videoVisible = phase === 'playing' && !failed;
  const showVideo = !reduceMotion && phase !== 'unavailable';

  // 全屏版（用户裁定 2026-10-06：王者荣耀登录页式 —— 视频铺满、内容压底、进度在下面走）：
  // - 视频：object-cover 铺满整窗；兜底时居中吉祥物（不再是左栏小槽位）。
  // - 静音/开声音：右上角浮层，播放中才渲染。
  return (
    <div data-opening-phase={phase} className="relative h-full w-full">
      <div className="flex h-full w-full items-center justify-center">
        <div
          className={`w-64 md:w-80 ${videoVisible ? 'opacity-0' : 'opacity-100'} transition-opacity duration-500`}
          aria-hidden={videoVisible}
        >
          <GuideMascot pose={pose} trackPointer={false} label={label} />
        </div>
      </div>
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
          onError={() => setPhase('unavailable')}
          className={`pointer-events-none absolute inset-0 h-full w-full object-cover transition-opacity duration-500 ${
            videoVisible ? 'opacity-100' : 'opacity-0'
          }`}
        />
      )}
      {phase === 'playing' && (
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
