/**
 * 产物预览的**布局裁定**（WorkBuddy 产物 UI A 批 Task 4，2026-10-09；纯函数、零状态）。
 *
 * 目标：宽窗并排读（主对话与预览各留 ≥360），窄窗改抽屉（不把两栏都挤成缝），
 * 极小窗全屏；**进入/退出用 24px 回滞**避免临界 resize 反复切换。
 *
 * ⚠️ `requestedPreviewWidth` 是**用户偏好**：窗口变小时只在有效宽度上 clamp，
 *    不回头覆盖偏好（窗口复原后宽度跟着回来）。非法输入回退安全默认。
 */

export type ArtifactPanelMode = 'inline' | 'drawer' | 'fullscreen';

export interface ArtifactPanelLayoutInput {
  viewportWidth: number;
  navigationWidth: number;
  requestedPreviewWidth: number;
  /** 上一次的裁定（回滞依据）；缺省 = 首次布局，用初始阈值。 */
  previousMode?: ArtifactPanelMode;
}

export interface ArtifactPanelLayout {
  mode: ArtifactPanelMode;
  width: number;
}

/** 主对话与预览各自的最小可读宽。 */
const CHAT_MIN = 360;
const PREVIEW_MIN = 360;
/** inline 进入/退出阈值（首次与抽屉→inline 用 720；inline→抽屉也用 720，回滞在 744 收尾）。 */
const INLINE_ENTER = 720;
const INLINE_EXIT = 720;
/** 抽屉→inline 的回归阈值：720 + 24 回滞。 */
const DRAWER_TO_INLINE = 744;
/** 全屏进入 <600；退出 ≥624（24px 回滞）。 */
const FULLSCREEN_ENTER = 600;
const FULLSCREEN_EXIT = 624;

const DEFAULT_VIEWPORT = 1280;
const DEFAULT_NAVIGATION = 224;
const DEFAULT_PREVIEW = 500;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resolveArtifactPanelLayout(input: ArtifactPanelLayoutInput): ArtifactPanelLayout {
  const viewport = finitePositive(input.viewportWidth, DEFAULT_VIEWPORT);
  const navigation =
    Number.isFinite(input.navigationWidth) && input.navigationWidth >= 0 ? input.navigationWidth : DEFAULT_NAVIGATION;
  const requested = finitePositive(input.requestedPreviewWidth, DEFAULT_PREVIEW);
  const usable = Math.max(0, viewport - navigation);
  const prev = input.previousMode;

  let mode: ArtifactPanelMode;
  if (prev === 'fullscreen') {
    // 回滞：不到 624 不退出；退出后按可用宽落 inline/drawer。
    mode = viewport < FULLSCREEN_EXIT ? 'fullscreen' : usable >= DRAWER_TO_INLINE ? 'inline' : 'drawer';
  } else if (prev === 'inline') {
    mode = viewport < FULLSCREEN_ENTER ? 'fullscreen' : usable < INLINE_EXIT ? 'drawer' : 'inline';
  } else if (prev === 'drawer') {
    mode = viewport < FULLSCREEN_ENTER ? 'fullscreen' : usable >= DRAWER_TO_INLINE ? 'inline' : 'drawer';
  } else {
    // 首次：<600 全屏；够 720 并排；否则抽屉。
    mode = viewport < FULLSCREEN_ENTER ? 'fullscreen' : usable >= INLINE_ENTER ? 'inline' : 'drawer';
  }

  let width: number;
  if (mode === 'fullscreen') width = viewport;
  else if (mode === 'drawer') width = clamp(requested, PREVIEW_MIN, viewport);
  else width = clamp(requested, PREVIEW_MIN, usable - CHAT_MIN);

  return { mode, width };
}
