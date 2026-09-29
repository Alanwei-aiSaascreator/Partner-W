import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const desktopSrc = join(__dirname, '../src');
const repoRoot = join(__dirname, '../../..');

function source(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

describe('tools.effective cross-layer wiring', () => {
  it('exposes one session-scoped IPC method from main through the renderer port', () => {
    const handlers = source(desktopSrc, 'main/ipc/ws-handlers.ts');
    const preload = source(desktopSrc, 'preload/index.ts');
    const declarations = source(desktopSrc, 'preload/clawwork.d.ts');
    const adapter = source(desktopSrc, 'renderer/platform/electron-adapter.ts');

    expect(handlers).toContain("'ws:tools-effective'");
    expect(handlers).toContain('gw.getEffectiveTools(payload.sessionKey, payload.agentId)');
    expect(preload).toContain('getEffectiveTools: (gatewayId: string, sessionKey: string, agentId?: string)');
    expect(preload).toContain("ipcRenderer.invoke('ws:tools-effective', { gatewayId, sessionKey, agentId })");
    expect(declarations).toContain('getEffectiveTools: (gatewayId: string, sessionKey: string, agentId?: string)');
    expect(adapter).toContain('getEffectiveTools: api.getEffectiveTools');
  });

  it('refreshes the effective inventory when the active connected session changes on desktop and PWA', () => {
    const desktopBootstrap = source(desktopSrc, 'renderer/hooks/useGatewayBootstrap.ts');
    const pwaBootstrap = source(repoRoot, 'packages/pwa/src/hooks/useGatewayBootstrap.ts');

    for (const bootstrap of [desktopBootstrap, pwaBootstrap]) {
      expect(bootstrap).toContain('dispatcher.fetchEffectiveTools(activeTask.gatewayId, activeTask.sessionKey)');
      expect(bootstrap).toContain("gatewayStatus !== 'connected'");
    }
  });
});
