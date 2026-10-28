// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeneralSection from '../src/renderer/layouts/Settings/sections/GeneralSection';
import PairMobileDialog from '../src/renderer/layouts/Settings/components/PairMobileDialog';
import { isMobileGatewayAddress } from '../src/renderer/lib/mobile-pairing';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { resetSettingsStore, useSettingsStore } from '../src/renderer/stores/settingsStore';

/**
 * 手机配对入口 + 二维码语义。
 *
 * 技术方案 v1.1 改变了这里的语义：
 *   - 入口不再要求"手机直接够得着的地址"—— 远程配对走隧道，本机 loopback 网关
 *     正是要配的那个对象（v1.0 时代的过滤会把主场景挡在门外）。
 *   - 二维码（生产）只带"公网地址 + 一次性 setup code"，不含网关 token。
 *   - "手机够不着就不给配对"这条判定被降级成 LAN 调试模式内部的约束，
 *     因此它继续在本文件里以 `isMobileGatewayAddress` 的单元测试形式被钉住。
 */

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../src/renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('qrcode.react', () => ({ QRCodeSVG: ({ value }: { value: string }) => <output>{value}</output> }));

const LOOPBACK_URLS = [
  'ws://127.0.0.1:18789',
  'ws://127.5.6.7:18789',
  'ws://127.1:18789',
  'ws://2130706433:18789',
  'ws://localhost:18789',
  'ws://LOCALHOST.:18789',
  'ws://runtime.localhost:18789',
  'ws://[::1]:18789',
  'ws://[::ffff:127.0.0.1]:18789',
  'ws://0.0.0.0:18789',
  'ws://[::]:18789',
  'not-a-url',
];

const REACHABLE_URLS = ['ws://192.168.1.20:18789', 'wss://gateway.example.com', 'https://gateway.example.com'];

const PUBLIC_URL = 'wss://abc12345.rym.example.com';

const IS_DEV = Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV);

let container: HTMLDivElement;
let root: Root;

function setGateways(urls: string[]): void {
  const gateways = urls.map((url, index) => ({
    id: `gw-${index}`,
    name: `Gateway ${index}`,
    url,
    token: 'test-token',
  }));
  useSettingsStore.getState().replaceSettings({ workspacePath: '/workspace', gateways });
  useUiStore.setState({
    gatewayInfoMap: Object.fromEntries(
      gateways.map((gateway) => [gateway.id, { id: gateway.id, name: gateway.name, url: gateway.url }]),
    ),
    gatewayStatusMap: Object.fromEntries(gateways.map((gateway) => [gateway.id, 'connected'])),
  });
}

function render(element: React.ReactElement): void {
  act(() => root.render(element));
}

function findButton(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find((button) => button.textContent === label);
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetSettingsStore();
  setGateways([]);
  localStorage.clear();
  window.clawwork = {
    getDeviceId: vi.fn().mockResolvedValue('test-device'),
    getSettings: vi.fn().mockResolvedValue(null),
    mobilePairSetupCode: vi.fn().mockResolvedValue({
      ok: true,
      result: {
        payload: {
          v: 2,
          s: 'test-device',
          g: [{ n: 'Gateway 0', u: `${PUBLIC_URL}/`, m: 'setupCode', c: 'SETUP-CODE' }],
        },
      },
    }),
  } as unknown as Window['clawwork'];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('手机配对入口', () => {
  it.each([...LOOPBACK_URLS, ...REACHABLE_URLS])('只要有网关就给入口（远程模式对 loopback 同样成立）: %s', (url) => {
    setGateways([url]);
    render(<GeneralSection />);
    expect(container.textContent).toContain('settings.pairMobileButton');
  });

  it('没有网关时不显示入口', () => {
    setGateways([]);
    render(<GeneralSection />);
    expect(container.textContent).not.toContain('settings.pairMobileButton');
  });
});

describe('isMobileGatewayAddress（LAN 调试模式的地址判定）', () => {
  it.each(LOOPBACK_URLS)('判为手机不可达: %s', (url) => {
    expect(isMobileGatewayAddress(url)).toBe(false);
  });

  it.each(REACHABLE_URLS)('判为手机可达: %s', (url) => {
    expect(isMobileGatewayAddress(url)).toBe(true);
  });
});

describe('PairMobileDialog · 远程模式（v2）', () => {
  it('没有公网地址时不能生成二维码', () => {
    setGateways(['ws://127.0.0.1:18789']);
    render(<PairMobileDialog open onOpenChange={vi.fn()} />);
    expect(container.textContent).toContain('Gateway 0');
    const generate = findButton('settings.pairGenerate');
    expect(generate).toBeDefined();
    expect(generate?.disabled).toBe(true);
    expect(window.clawwork.mobilePairSetupCode).not.toHaveBeenCalled();
  });

  it('有公网地址时生成 v2 二维码，且二维码里没有网关 token', async () => {
    setGateways(['ws://127.0.0.1:18789']);
    localStorage.setItem('clawwork.pair.publicUrl', PUBLIC_URL);
    render(<PairMobileDialog open onOpenChange={vi.fn()} />);

    const generate = findButton('settings.pairGenerate');
    expect(generate).toBeDefined();
    await act(async () => generate?.click());

    expect(window.clawwork.mobilePairSetupCode).toHaveBeenCalledWith('gw-0', PUBLIC_URL, {
      gatewayName: 'Gateway 0',
      deviceId: 'test-device',
    });

    const qr = container.querySelector('output')?.textContent ?? '';
    const payload = JSON.parse(qr) as { v: number; g: { m: string; c: string; u: string }[] };
    expect(payload.v).toBe(2);
    expect(payload.g[0].m).toBe('setupCode');
    expect(payload.g[0].u).toBe(`${PUBLIC_URL}/`);
    expect(qr).not.toContain('test-token');
  });
});

describe.runIf(IS_DEV)('PairMobileDialog · 局域网调试模式', () => {
  it('切到 LAN 后 loopback 网关被排除', async () => {
    setGateways(['ws://127.0.0.1:18789', 'wss://gateway.example.com']);
    render(<PairMobileDialog open onOpenChange={vi.fn()} />);

    const lan = findButton('settings.pairModeLan');
    expect(lan).toBeDefined();
    await act(async () => lan?.click());

    expect(container.textContent).not.toContain('Gateway 0');
    expect(container.textContent).toContain('Gateway 1');
  });
});
