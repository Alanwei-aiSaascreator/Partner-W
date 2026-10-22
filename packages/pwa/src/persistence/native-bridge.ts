import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

/**
 * 原生壳（Android/iOS）与浏览器之间的存储桥。
 *
 * 为什么需要：浏览器版把设备凭据放在 IndexedDB，清缓存/换浏览器就丢，
 * 用户又得重新扫码。装进原生壳后，凭据改存 Preferences（Android
 * SharedPreferences / iOS UserDefaults）——App 私有目录，系统清缓存不会动，
 * 只有卸载 App 才会消失。这就是"断联后拿起来就能用"的地基。
 */
export function isNativeApp(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

export async function nativeGetJson<T>(key: string): Promise<T | undefined> {
  const { value } = await Preferences.get({ key });
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export async function nativeSetJson(key: string, value: unknown): Promise<void> {
  await Preferences.set({ key, value: JSON.stringify(value) });
}

export async function nativeRemove(key: string): Promise<void> {
  await Preferences.remove({ key });
}
