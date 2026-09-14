import type { GatewayConnectionStatus } from '@clawwork/core';
import type { ModelCatalogEntry } from '@clawwork/shared';

export type ModelAvailability = 'service-starting' | 'models-loading' | 'empty' | 'ready';

interface ModelAvailabilityInput {
  gatewayId: string | null | undefined;
  gatewayStatus: GatewayConnectionStatus | undefined;
  rawCatalog: ModelCatalogEntry[] | undefined;
  modelCount: number;
}

export function deriveModelAvailability({
  gatewayId,
  gatewayStatus,
  rawCatalog,
  modelCount,
}: ModelAvailabilityInput): ModelAvailability {
  if (!gatewayId || gatewayStatus !== 'connected') return 'service-starting';
  if (rawCatalog === undefined) return 'models-loading';
  if (modelCount === 0) return 'empty';
  return 'ready';
}
