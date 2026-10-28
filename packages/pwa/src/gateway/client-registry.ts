import type { BrowserGatewayClient } from './client.js';

/**
 * 主连接注册表。审批副连接单独存放（同 gatewayId 两条连接不能互相覆盖）。
 *
 * ⚠️ 副连接（caps=['exec-approvals']）与主连接共用 `client.id`（网关按 connId 排除
 * 请求者、不按 client.id 判四选一），但它是独立实例，不能进 `clients` Map——
 * 否则 `getClient(id)` 会把主连接顶掉，消息/会话链路全断。
 */
const clients = new Map<string, BrowserGatewayClient>();
const approvalClients = new Map<string, BrowserGatewayClient>();

export function registerClient(client: BrowserGatewayClient): void {
  clients.set(client.id, client);
}

/** 审批副连接：主/副分开注册，互不覆盖。 */
export function registerApprovalClient(client: BrowserGatewayClient): void {
  approvalClients.set(client.id, client);
}

export function getClient(id: string): BrowserGatewayClient | undefined {
  return clients.get(id);
}

/** 审批副连接（不存在时为 undefined；调用方自行判断网关是否支持审批投递）。 */
export function getApprovalClient(id: string): BrowserGatewayClient | undefined {
  return approvalClients.get(id);
}

/** 只返回主连接：网关状态、会话同步等按主连接口径（副连接不订阅会话、不参与消息链路）。 */
export function getAllClients(): BrowserGatewayClient[] {
  return Array.from(clients.values());
}

export function reconnectAllClients(): void {
  for (const client of clients.values()) {
    if (!client.isConnected) {
      client.reconnect();
    }
  }
  for (const client of approvalClients.values()) {
    if (!client.isConnected) {
      client.reconnect();
    }
  }
}

export function destroyAllClients(): void {
  for (const client of clients.values()) {
    client.destroy();
  }
  for (const client of approvalClients.values()) {
    client.destroy();
  }
  clients.clear();
  approvalClients.clear();
}
