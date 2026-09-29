import { useEffect } from 'react';
import type { DebugEvent } from '@clawwork/shared';
import { listGateways, getIdentity, updateGatewayToken } from '../persistence/db.js';
import { importDeviceIdentity } from '../gateway/device-identity.js';
import { BrowserGatewayClient } from '../gateway/client.js';
import { registerClient, destroyAllClients } from '../gateway/client-registry.js';
import { getGatewayBroadcasters } from '../platform/index.js';
import { dispatcher, uiStoreApi } from '../stores/index.js';
import { useTaskStore, useUiStore } from '../stores/hooks.js';
import { reportDebugEvent } from '../lib/debug.js';
import type { GatewayAuth } from '@clawwork/shared';
import { toast } from 'sonner';
import i18next from 'i18next';

export function useGatewayBootstrap(): void {
  const activeTask = useTaskStore((state) => state.tasks.find((task) => task.id === state.activeTaskId));
  const gatewayStatus = useUiStore((state) => (activeTask ? state.gatewayStatusMap[activeTask.gatewayId] : undefined));

  useEffect(() => {
    if (!activeTask || gatewayStatus !== 'connected') return;
    void dispatcher.fetchEffectiveTools(activeTask.gatewayId, activeTask.sessionKey);
  }, [activeTask, gatewayStatus]);

  useEffect(() => {
    let cancelled = false;
    const cleanupFns: Array<() => void> = [];

    (async () => {
      const configs = await listGateways();
      if (cancelled) return;

      const identityRecord = await getIdentity();
      if (cancelled || !identityRecord) return;

      const identity = await importDeviceIdentity(identityRecord);
      if (cancelled) return;

      const infoMap: Record<string, { id: string; name: string }> = {};
      for (const cfg of configs) {
        infoMap[cfg.id] = { id: cfg.id, name: cfg.name };
      }
      uiStoreApi.getState().setGatewayInfoMap(infoMap);

      if (configs.length > 0) {
        uiStoreApi.getState().setDefaultGatewayId(configs[0].id);
      }

      uiStoreApi.getState().setGatewaysLoaded(true);

      const { broadcastEvent, broadcastStatus } = getGatewayBroadcasters();

      for (const cfg of configs) {
        if (cancelled) return;

        const auth: GatewayAuth | undefined =
          cfg.authMode === 'password'
            ? cfg.password
              ? { password: cfg.password, deviceToken: cfg.deviceToken }
              : undefined
            : cfg.authMode === 'pairingCode'
              ? cfg.pairingCode
                ? { bootstrapToken: cfg.pairingCode, deviceToken: cfg.deviceToken }
                : undefined
              : cfg.token
                ? { token: cfg.token, deviceToken: cfg.deviceToken }
                : cfg.deviceToken
                  ? { token: '', deviceToken: cfg.deviceToken }
                  : undefined;

        const client = new BrowserGatewayClient({
          id: cfg.id,
          name: cfg.name,
          url: cfg.url,
          auth,
          identity,
          onEvent: (data) => broadcastEvent(data),
          onStatus: (data) => broadcastStatus(data),
          reportDebugEvent: (event) => reportDebugEvent(event as Partial<DebugEvent>),
          onTokenUpdate: async (gatewayId, token) => {
            await updateGatewayToken(gatewayId, token);
          },
          onPairingSuccess: () => {
            toast.success(i18next.t('app.paired'));
          },
        });

        registerClient(client);
        client.connect();
      }

      const removeEvents = dispatcher.start();
      const removeStatus = dispatcher.startGatewayStatus();
      dispatcher.initialize();

      cleanupFns.push(removeEvents, removeStatus);
    })().catch((err: unknown) => {
      reportDebugEvent({
        level: 'error',
        domain: 'app',
        event: 'bootstrap.failed',
        error: { message: err instanceof Error ? err.message : 'Bootstrap failed' },
      });
    });

    return () => {
      cancelled = true;
      for (const fn of cleanupFns) fn();
      destroyAllClients();
      dispatcher.reset();
    };
  }, []);
}
