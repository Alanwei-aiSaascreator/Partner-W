import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';

export interface WindowsStaticProxy {
  enabled: boolean;
  server: string;
  bypass?: string;
}

const PROXY_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']);

function hasExplicitProxyPolicy(env: NodeJS.ProcessEnv): boolean {
  return Object.entries(env).some(([key, value]) => value !== undefined && PROXY_KEYS.has(key.toUpperCase()));
}

function endpoint(value: string): string | null {
  if (!/^(?:https?:\/\/)?(?:\[[\da-fA-F:]+\]|[\w.-]+):\d+$/.test(value)) return null;
  const port = Number(value.match(/:(\d+)$/)?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const parsed = new URL(/^https?:\/\//.test(value) ? value : `http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
    return `${parsed.protocol}//${parsed.hostname}:${port}`;
  } catch {
    return null;
  }
}

function bypassEntry(value: string): string | null {
  if (value.toLowerCase() === '<local>') return hostname();
  if (value.includes('*') && !value.startsWith('*.')) {
    const parts = value.split('.');
    if (
      parts.length < 2 ||
      parts.length > 4 ||
      parts[0] === '*' ||
      !parts.every((part) => part === '*' || (/^\d{1,3}$/.test(part) && Number(part) <= 255))
    )
      return null;
    return value;
  }
  if (
    !/^(?:\*\.)?[a-z\d](?:[a-z\d_.-]*[a-z\d])?(?::\d+)?$/i.test(value) &&
    !/^\[[\da-f:]+\](?::\d+)?$/i.test(value) &&
    value !== '::1'
  )
    return null;
  const port = /:(\d+)$/.exec(value)?.[1];
  if (value !== '::1' && port && (Number(port) < 1 || Number(port) > 65535)) return null;
  return value;
}

export function applyWindowsStaticProxy(
  env: NodeJS.ProcessEnv,
  settings: WindowsStaticProxy | null,
): NodeJS.ProcessEnv {
  const result = { ...env };
  if (hasExplicitProxyPolicy(env) || !settings?.enabled || !settings.server.trim()) return result;
  const server = settings.server.trim();
  const routes: NodeJS.ProcessEnv = {};
  if (!server.includes('=')) {
    const proxy = endpoint(server);
    if (!proxy) return result;
    routes.HTTP_PROXY = proxy;
    routes.HTTPS_PROXY = proxy;
  } else {
    const seen = new Set<string>();
    for (const entry of server
      .split(';')
      .map((value) => value.trim())
      .filter(Boolean)) {
      const match = /^(http|https|ftp|socks)=(.+)$/.exec(entry);
      if (!match || seen.has(match[1])) return result;
      seen.add(match[1]);
      if (match[1] !== 'http' && match[1] !== 'https') continue;
      const proxy = endpoint(match[2].trim());
      if (!proxy) return result;
      routes[`${match[1].toUpperCase()}_PROXY`] = proxy;
    }
  }
  if (Object.keys(routes).length === 0) return result;
  const bypass = new Set(['localhost', '127.0.0.1', '::1']);
  const rawBypass = settings.bypass ?? '';
  if (
    [...rawBypass].some(
      (character) => character === ',' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return result;
  for (const value of rawBypass
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    const entry = bypassEntry(value);
    if (!entry) return result;
    bypass.add(entry);
  }
  return { ...result, ...routes, NO_PROXY: [...bypass].join(',') };
}

type RegistryReader = (command: string, args: string[]) => string;

export function readWindowsStaticProxy(
  read: RegistryReader = (command, args) =>
    execFileSync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
): WindowsStaticProxy | null {
  try {
    const output = read('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']);
    if (/^\s*AutoConfigURL\s+REG_SZ\s+\S/im.test(output) || /^\s*AutoDetect\s+REG_DWORD\s+0x1\s*$/im.test(output))
      return null;
    const enabled = /^\s*ProxyEnable\s+REG_DWORD\s+0x1\s*$/im.test(output);
    const server = /^\s*ProxyServer\s+REG_SZ\s+(.+)$/im.exec(output)?.[1]?.trim() ?? '';
    const bypass = /^\s*ProxyOverride\s+REG_SZ\s+(.+)$/im.exec(output)?.[1]?.trim();
    return { enabled, server, ...(bypass ? { bypass } : {}) };
  } catch {
    return null;
  }
}

export function inheritWindowsSystemProxy(
  env: NodeJS.ProcessEnv,
  read: () => WindowsStaticProxy | null = readWindowsStaticProxy,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== 'win32' || hasExplicitProxyPolicy(env)) return { ...env };
  return applyWindowsStaticProxy(env, read());
}
