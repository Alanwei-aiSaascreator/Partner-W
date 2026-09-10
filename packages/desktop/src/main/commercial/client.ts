import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocketImpl from 'ws';
import { readConfig } from '../workspace/config.js';

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
  const config = readConfig();
  const url = config?.commercial?.supabaseUrl ?? '';
  const anonKey = config?.commercial?.supabaseAnonKey ?? '';
  if (!url || !anonKey) return null;

  const nextKey = `${url}::${anonKey}`;
  if (client && clientKey === nextKey) return client;

  client = createClient(url, anonKey, {
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
