import { ipcMain } from 'electron';
import { readConfig, updateConfig, writeConfig, buildGatewayAuth } from '../workspace/config.js';
import type { AppConfig, GatewayServerConfig } from '../workspace/config.js';
import { getGatewayClient, addGateway, removeGateway } from '../ws/index.js';
import { GatewayClient } from '../ws/gateway-client.js';
import { SUPPORTED_LANGUAGE_CODES } from '@clawwork/shared';
import type { GatewayAuth } from '@clawwork/shared';

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:get', (): AppConfig | null => {
    const config = readConfig();
    if (config && process.env.NODE_ENV === 'development') config.devMode = true;
    return config;
  });

  ipcMain.handle(
    'settings:update',
    (_event, partial: Partial<AppConfig>): { ok: boolean; config?: AppConfig; error?: string } => {
      if ('gateways' in partial || 'defaultGatewayId' in partial) {
        return { ok: false, error: 'use dedicated gateway handlers' };
      }
      if (
        partial.language !== undefined &&
        !(SUPPORTED_LANGUAGE_CODES as readonly string[]).includes(partial.language)
      ) {
        return { ok: false, error: 'unsupported language code' };
      }
      // 「电脑操控权限」两档：只收这两个字面量。写进别的东西 ⇒ 读取侧会把它当安全档，
      // 但**这里就拒掉**更好 —— 悄悄存下一个永远不会生效的值，等于让用户以为他开了。
      if (
        partial.computerAccess !== undefined &&
        partial.computerAccess !== 'safe' &&
        partial.computerAccess !== 'full'
      ) {
        return { ok: false, error: 'unsupported computer access tier' };
      }
      const config = updateConfig(partial);
      return { ok: true, config };
    },
  );

  ipcMain.handle('settings:add-gateway', async (_event, gateway: GatewayServerConfig) => {
    const config = readConfig();
    if (!config) return { ok: false, error: 'no config' };
    config.gateways.push(gateway);
    if (gateway.isDefault || config.gateways.length === 1) {
      config.defaultGatewayId = gateway.id;
    }
    writeConfig(config);
    addGateway({
      id: gateway.id,
      name: gateway.name,
      url: gateway.url,
      auth: buildGatewayAuth(gateway),
      tlsVerify: gateway.tlsVerify,
    });
    return { ok: true };
  });

  ipcMain.handle('settings:remove-gateway', async (_event, gatewayId: string) => {
    const config = readConfig();
    if (!config) return { ok: false, error: 'no config' };
    config.gateways = config.gateways.filter((g) => g.id !== gatewayId);
    if (config.defaultGatewayId === gatewayId) {
      const nextDefault = config.gateways[0]?.id;
      config.defaultGatewayId = nextDefault;
      for (const gw of config.gateways) {
        gw.isDefault = gw.id === nextDefault;
      }
    }
    writeConfig(config);
    removeGateway(gatewayId);
    return { ok: true };
  });

  ipcMain.handle(
    'settings:update-gateway',
    async (_event, gatewayId: string, partial: Partial<GatewayServerConfig>) => {
      const config = readConfig();
      if (!config) return { ok: false, error: 'no config' };
      const idx = config.gateways.findIndex((g) => g.id === gatewayId);
      if (idx === -1) return { ok: false, error: 'gateway not found' };
      config.gateways[idx] = { ...config.gateways[idx], ...partial };
      writeConfig(config);
      const client = getGatewayClient(gatewayId);
      if (client) {
        const gw = config.gateways[idx];
        client.updateConfig({ url: gw.url, auth: buildGatewayAuth(gw), tlsVerify: gw.tlsVerify });
      }
      return { ok: true, gateway: config.gateways[idx] };
    },
  );

  ipcMain.handle('settings:set-default-gateway', async (_event, gatewayId: string) => {
    const config = readConfig();
    if (!config) return { ok: false, error: 'no config' };
    for (const gw of config.gateways) {
      gw.isDefault = gw.id === gatewayId;
    }
    config.defaultGatewayId = gatewayId;
    writeConfig(config);
    return { ok: true };
  });

  ipcMain.handle(
    'settings:test-gateway',
    async (
      _event,
      url: string,
      auth: { token?: string; password?: string; pairingCode?: string; tlsVerify?: boolean },
    ) => {
      if (auth.pairingCode) {
        return { ok: false, error: 'pairing-code test is not supported' };
      }
      const testAuth: GatewayAuth = auth.token
        ? { token: auth.token.trim() }
        : auth.password
          ? { password: auth.password.trim() }
          : { token: '' };
      const testClient = new GatewayClient(
        { id: `test-${Date.now()}`, name: 'test', url: url.trim(), auth: testAuth, tlsVerify: auth.tlsVerify },
        { noReconnect: true },
      );
      try {
        testClient.connect();
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          if (testClient.isConnected) return { ok: true };
          if (testClient.lastConnectionError) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const errorCode = testClient.lastConnectionErrorCode;
        const msg = testClient.lastConnectionError ?? 'timeout';
        if (errorCode === 'PAIRING_REQUIRED') {
          return { ok: false, error: msg, pairingRequired: true };
        }
        return { ok: false, error: msg };
      } finally {
        testClient.destroy();
      }
    },
  );
}
