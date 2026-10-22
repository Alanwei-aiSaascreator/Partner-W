import { app, ipcMain } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 身份画像的落盘层。
 *
 * 为什么需要它：画像原本只存在渲染进程的 localStorage 里（`user-onboarding.ts`），
 * 主进程读不到 —— 于是手机端「个性化中心」只能显示一个主题开关（用户原话：敷衍）。
 * 这里把画像同时镜像一份到 userData/profile.json，手机端 API 才能读到同一份数据。
 *
 * ⚠️ 只做镜像，**不改动**渲染层原有的存储与读取逻辑（旧版本升级上来的人照样能用）。
 */
function profilePath(): string {
  return join(app.getPath('userData'), 'profile.json');
}

export function readProfileMirror(): Record<string, unknown> | null {
  try {
    const file = profilePath();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function registerProfileHandlers(): void {
  ipcMain.handle('profile:save', (_event, profile: unknown) => {
    try {
      if (typeof profile !== 'object' || profile === null) return { ok: false, error: 'invalid profile' };
      writeFileSync(profilePath(), JSON.stringify(profile), 'utf8');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'save failed' };
    }
  });

  ipcMain.handle('profile:get', () => ({ ok: true, result: readProfileMirror() }));
}
