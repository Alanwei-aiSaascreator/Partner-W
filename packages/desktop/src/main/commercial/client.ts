import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocketImpl from 'ws';
import { resolveCommercialCredentials } from '@clawwork/shared';
import { readConfig } from '../workspace/config.js';
import { createTimeoutFetch } from './request-timeout.js';

// @supabase/supabase-js builds its Realtime client eagerly and requires a global
// WebSocket constructor. Electron 34 runs Node 20, which has none, so every
// networking call — including plain auth — throws "native WebSocket not found".
// Provide the `ws` implementation before createClient() is called.
if (typeof globalThis.WebSocket === 'undefined') {
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocketImpl;
}

const SESSION_FILE = 'commercial-session.json';
const ENCRYPTED_PREFIX = 'enc:';

let client: SupabaseClient | null = null;
let clientKey = '';

function sessionFilePath(): string {
  return join(app.getPath('userData'), SESSION_FILE);
}

function writeSecure(filePath: string, value: string): void {
  const payload = safeStorage.isEncryptionAvailable()
    ? ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64')
    : value;
  writeFileSync(filePath, payload, 'utf8');
}

function readSecure(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    if (!raw.startsWith(ENCRYPTED_PREFIX)) return raw;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const buf = Buffer.from(raw.slice(ENCRYPTED_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    return null;
  }
}

interface SecureStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function createStorage(): SecureStorage {
  return {
    getItem: () => readSecure(sessionFilePath()),
    setItem: (_key, value) => {
      writeSecure(sessionFilePath(), value);
    },
    removeItem: () => {
      const filePath = sessionFilePath();
      if (existsSync(filePath)) unlinkSync(filePath);
    },
  };
}

export function getCommercialClient(): SupabaseClient | null {
  // 读取期兜底（2026-09-18 P0）：干净机器上 `commercial` 段是空的，回落到随包
  // 下发的生产默认值。不兜底就是这里返回 null —— 登录/激活/用量全部静默失败。
  // 兜底只发生在**读取期**，绝不写回 config：见 shared/commercial-defaults.ts。
  const { supabaseUrl: url, supabaseAnonKey: anonKey } = resolveCommercialCredentials(readConfig()?.commercial);
  // 常量非空时这条恒假，留着是因为**它就是"凭据为空 ⇒ 返回 null"这个契约的落点**：
  // 哪天常量被清空（占位符化、分支裁剪），这里必须继续挡住，而不是拿着空 URL 去
  // createClient（那会在别处炸，报错还读不出原因）。
  if (!url || !anonKey) return null;

  const nextKey = `${url}::${anonKey}`;
  if (client && clientKey === nextKey) return client;

  client = createClient(url, anonKey, {
    // ⚠️ 给**所有**商业出站请求补上中止：调用点（probeAuth / readSessionState / 目录拉取…）
    //    到点就不再等了，但请求原来还挂在网络上 —— 那是实打实的资源泄漏，
    //    而且当日最可疑的正是"会话刷新锁被挂住的请求占着"（见 request-timeout.ts 的说明）。
    //    健康路径零行为改变：正常返回的请求走的是同一条路。
    global: { fetch: createTimeoutFetch() },
    auth: {
      storage: createStorage(),
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
    },
  });
  clientKey = nextKey;
  return client;
}

export function resetCommercialClient(): void {
  client = null;
  clientKey = '';
}

export function clearCommercialSession(): void {
  const filePath = sessionFilePath();
  if (existsSync(filePath)) unlinkSync(filePath);
  resetCommercialClient();
}
