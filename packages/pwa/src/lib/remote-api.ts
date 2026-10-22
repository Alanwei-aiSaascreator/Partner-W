import { listGateways } from '../persistence/db.js';

/**
 * 手机端调用桌面 API 时必须用**远程地址**，不能用相对路径。
 *
 * 为什么：原生壳（Capacitor）加载的是本地资源，页面 origin 是 `https://localhost`。
 * 相对路径 `/api/mobile/...` 会打到 WebView 自己的本地服务 —— 那里没有这个接口，
 * 返回的是 index.html，于是 fetch 拿到 `<!doctype html>`，JSON.parse 立刻炸
 * （真机报错：`Unexpected token '<', "<!doctype "... is not valid JSON`）。
 *
 * 所以从已保存的网关地址反推出 https 基址（wss://host → https://host），
 * 再由桌面端那侧放行 CORS。
 */
export async function mobileApiBase(): Promise<string> {
  const gateways = await listGateways();
  const url = (gateways[0]?.url ?? '').trim();
  if (url.startsWith('wss://')) return `https://${url.slice('wss://'.length)}`.replace(/\/+$/, '');
  if (url.startsWith('ws://')) return `http://${url.slice('ws://'.length)}`.replace(/\/+$/, '');
  if (url.startsWith('https://') || url.startsWith('http://')) return url.replace(/\/+$/, '');
  return '';
}

export async function mobileFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  const base = await mobileApiBase();
  const url = base ? `${base}${path}` : path;
  return fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'x-gateway-token': token,
    },
  });
}

export async function gatewayToken(): Promise<string | null> {
  const gateways = await listGateways();
  return gateways[0]?.token ?? null;
}
