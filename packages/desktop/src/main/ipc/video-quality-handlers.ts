import { ipcMain } from 'electron';
import type { IpcResult } from '@clawwork/shared';
import { getVideoQuality, setVideoQuality, type VideoQuality } from '../videogen/quality.js';

/**
 * 视频画质档位的 IPC（2026-10-17 用户要求）。
 *
 * 只有两个值：`standard`（H3，便宜）/ `seedance`（豆包 Seedance 2.5，更贵但更清晰）。
 * 界面负责解释价格差异；主进程只保存**这一档**，并在消息收尾解析 `videogen` 围栏时使用。
 */
export function registerVideoQualityHandlers(): void {
  ipcMain.handle('videogen:get-quality', (): IpcResult<{ quality: VideoQuality }> => {
    return { ok: true, result: { quality: getVideoQuality() } };
  });

  ipcMain.handle('videogen:set-quality', (_event, value: unknown): IpcResult<{ quality: VideoQuality }> => {
    return { ok: true, result: { quality: setVideoQuality(value) } };
  });
}
