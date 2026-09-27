import type { GatewayClientConfig } from '@clawwork/shared';
import { GatewayClient } from './gateway-client.js';
import { readConfig, buildGatewayAuth, clearGatewayPairingCode } from '../workspace/config.js';

const gatewayClients = new Map<string, GatewayClient>();

/**
 * 每个网关的**审批专用连接** —— 与主连接分开的第二条 WS。
 *
 * ## 为什么非得是第二条（根因与源码证据见 `gateway-client.ts` 的 `APPROVAL_CHANNEL_CAPS`）
 *
 * 网关决定"这条 exec 审批能不能送出去"时用的是
 * `hasExecApprovalClients(params.clientConnId)`，而它**跳过发起请求的那条连接**
 * （刻意不问"提问者本人"）。主连接正是发起 exec 的那条 ⇒ 给它补 cap 也永远查不到自己。
 * 少开这一条，exec 审批就会在 **17 毫秒**内被判 `no-route`，用户连弹窗都看不见，
 * 读成"工具调用失败"。
 *
 * ⚠️ 刻意**不放进** `gatewayClients`（`getAllGatewayClients` 的返回值）：那张表是
 *    "往哪个网关发请求"的注册表，调用方会遍历它。把审批连接混进去，每条请求都会
 *    发两遍。两张表分开维护，生命周期成对。
 *
 * ⚠️ **这条连接失败不影响主连接**：它连不上时主连接照常工作，只是 exec 审批退回
 *    原来的"秒死"行为。所以这里一律不抛、不阻断启动。
 */
const approvalClients = new Map<string, GatewayClient>();

function createGatewayClient(config: GatewayClientConfig, opts?: { noReconnect?: boolean }): GatewayClient {
  return new GatewayClient(config, {
    ...opts,
    onPairingSuccess: (gatewayId) => {
      clearGatewayPairingCode(gatewayId);
    },
  });
}

/** 起（或重起）某个网关的审批连接。主连接失败与它无关，反之亦然。 */
function startApprovalChannel(config: GatewayClientConfig): void {
  approvalClients.get(config.id)?.destroy();
  const client = new GatewayClient(config, { approvalChannel: true });
  approvalClients.set(config.id, client);
  client.connect();
}

export function initAllGateways(): void {
  const config = readConfig();
  const gateways = config?.gateways ?? [];
  for (const gw of gateways) {
    const gatewayConfig: GatewayClientConfig = {
      id: gw.id,
      name: gw.name,
      url: gw.url,
      auth: buildGatewayAuth(gw),
      tlsVerify: gw.tlsVerify,
    };
    const client = createGatewayClient(gatewayConfig);
    client.connect();
    gatewayClients.set(gw.id, client);
    startApprovalChannel(gatewayConfig);
  }
}

export function getGatewayClient(gatewayId: string): GatewayClient | null {
  return gatewayClients.get(gatewayId) ?? null;
}

export function getAllGatewayClients(): Map<string, GatewayClient> {
  return gatewayClients;
}

export function addGateway(config: GatewayClientConfig): GatewayClient {
  const client = createGatewayClient(config);
  client.connect();
  gatewayClients.set(config.id, client);
  startApprovalChannel(config);
  return client;
}

export function removeGateway(gatewayId: string): void {
  const client = gatewayClients.get(gatewayId);
  if (client) {
    client.destroy();
    gatewayClients.delete(gatewayId);
  }
  const approval = approvalClients.get(gatewayId);
  if (approval) {
    approval.destroy();
    approvalClients.delete(gatewayId);
  }
}

export function reconnectGateway(gatewayId: string): void {
  gatewayClients.get(gatewayId)?.reconnect();
  // 两条一起重连：审批连接单独断线时不会有人喊，漏了它就会静默回到"秒死"。
  approvalClients.get(gatewayId)?.reconnect();
}

export function destroyAllGateways(): void {
  for (const client of gatewayClients.values()) {
    client.destroy();
  }
  gatewayClients.clear();
  for (const client of approvalClients.values()) {
    client.destroy();
  }
  approvalClients.clear();
}
