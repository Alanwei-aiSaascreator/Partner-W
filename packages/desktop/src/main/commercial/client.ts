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

/**
 * **本地快速态**（B7）：本地存着一个会话吗。**不发网络、同步返回**。
 *
 * ## 它解决什么
 *
 * 会话检查走的是 `supabase.auth.getUser()` —— **每次都要发网络**，主进程给它 8 秒；
 * 而界面那边的兜底只有 5 秒。两个时限顺序是反的 ⇒ 网络一慢，一个**已经登录**的用户
 * 在 5 秒时被扔进登录页，等真答案回来（≤8 秒）又从登录页弹进工作区。
 *
 * ⇒ 界面用它决定**兜底该怎么判**：命中就继续等真答案，缺席才回登录页。
 * 详见 `renderer/lib/app-entry-flow.ts` 的 `runAuthBootstrap`。
 *
 * ## 三条不许（用户拍板的口径）
 *
 * 1. **不得**拿它当"已登录"的结论 —— 它只说明"本地有个 token"，token 可能早就失效。
 * 2. **不得**因为它是 true 就跳过后台校验。
 * 3. **不得**让它去发网络 —— 发了就退回今天的问题。所以它是 `boolean` 而不是
 *    `Promise<boolean>`：同步函数**不可能** await 过一次网络，这条签名本身就是保证。
 *
 * ⚠️ 刻意**不用** `supabase.auth.getSession()`：`autoRefreshToken: true` 时它会在
 *    token 过期时**顺手发一次刷新请求** —— 那就不是"快速态"了。这里只读我们自己的
 *    那份会话文件（supabase-js 没配 `userStorage`，存下去的就是 session 对象本身，
 *    `access_token` 是顶层键）。
 *
 * ⚠️ 读不出来（没有文件 / JSON 坏 / 密文解不开）一律当**缺席**：宁可回到今天的行为，
 *    也不凭一个"读不到"去拖延登录页。
 */
export function hasLocalSession(): boolean {
  const raw = readSecure(sessionFilePath());
  if (!raw) return false;
  try {
    const parsed = JSON.parse(raw) as { access_token?: unknown } | null;
    return typeof parsed?.access_token === 'string' && parsed.access_token.length > 0;
  } catch {
    return false;
  }
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
