// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GeneralSection from '../src/renderer/layouts/Settings/sections/GeneralSection';
import PairMobileDialog from '../src/renderer/layouts/Settings/components/PairMobileDialog';
import { useUiStore } from '../src/renderer/stores/uiStore';
import { resetSettingsStore, useSettingsStore } from '../src/renderer/stores/settingsStore';

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

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetSettingsStore();
  setGateways([]);
  window.clawwork = {
    getDeviceId: vi.fn().mockResolvedValue('test-device'),
    getSettings: vi.fn().mockResolvedValue(null),
  } as unknown as Window['clawwork'];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('mobile pairing availability', () => {
  it.each([
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
  ])('hides pairing for an endpoint unavailable to a phone: %s', (url) => {
    setGateways([url]);
    render(<GeneralSection />);
    expect(container.textContent).not.toContain('settings.pairMobileButton');
  });

  it.each(['ws://192.168.1.20:18789', 'wss://gateway.example.com', 'https://gateway.example.com'])(
    'preserves direct pairing for a reachable-address gateway: %s',
    (url) => {
      setGateways([url]);
      render(<GeneralSection />);
      expect(container.textContent).toContain('settings.pairMobileButton');
    },
  );

  it('does not offer generation when the dialog receives only a loopback gateway', () => {
    setGateways(['ws://127.0.0.1:18789']);
    render(<PairMobileDialog open onOpenChange={vi.fn()} />);
    expect(container.textContent).not.toContain('settings.pairGenerate');
    expect(window.clawwork.getDeviceId).not.toHaveBeenCalled();
  });

  it('selects the eligible gateway and excludes loopback credentials from the QR payload', async () => {
    setGateways(['ws://127.0.0.1:18789', 'wss://gateway.example.com']);
    render(<PairMobileDialog open onOpenChange={vi.fn()} />);
    expect(container.textContent).not.toContain('Gateway 0');
    const generate = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'settings.pairGenerate',
    );
    expect(generate).toBeDefined();
    await act(async () => generate?.click());
    const payload = JSON.parse(container.querySelector('output')?.textContent ?? '{}') as { g?: { u: string }[] };
    expect(payload.g?.map((gateway) => gateway.u)).toEqual(['wss://gateway.example.com']);
  });
});
