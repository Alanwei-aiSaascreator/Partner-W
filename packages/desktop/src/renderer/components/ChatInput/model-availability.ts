import type { GatewayConnectionStatus } from '@clawwork/core';
import type { ModelCatalogEntry } from '@clawwork/shared';

export type ModelAvailability = 'service-starting' | 'models-loading' | 'catalog-failed' | 'empty' | 'ready';

interface ModelAvailabilityInput {
  gatewayId: string | null | undefined;
  gatewayStatus: GatewayConnectionStatus | undefined;
  rawCatalog: ModelCatalogEntry[] | undefined;
  catalogFailed: boolean;
  modelCount: number;
}

export function deriveModelAvailability({
  gatewayId,
  gatewayStatus,
  rawCatalog,
  catalogFailed,
  modelCount,
}: ModelAvailabilityInput): ModelAvailability {
  if (!gatewayId || gatewayStatus !== 'connected') return 'service-starting';
  // ⚠️ `undefined` 曾经是**二义**的："还在取"与"取不到"长得一模一样，
  //    而取失败那条路以前不进重试 ⇒ 界面**永远**停在"正在准备模型…"。
  //    现在由 `catalogFailed` 把两者分开（它由退避用尽时落下的显式失败态驱动）。
  if (rawCatalog === undefined) return catalogFailed ? 'catalog-failed' : 'models-loading';
  // 目录为空**且**取不到 ⇒ 说"取不到"，别替网关下"确实没有"的结论。
  if (modelCount === 0) return catalogFailed ? 'catalog-failed' : 'empty';
  // 手上有能用的目录就说能干活：一次失败的重取不该把已经能用的界面说成坏的。
  return 'ready';
}

export interface ModelStatusCopy {
  label: string;
  detail: string;
  preparing: boolean;
}

/** 输入框上模型那一格的状态文案（分档）。`null` = 不给状态文案，显示模型名。 */
export function modelStatusCopy(availability: ModelAvailability, t: (key: string) => string): ModelStatusCopy | null {
  if (availability === 'service-starting') {
    return { label: t('chatInput.aiServiceStarting'), detail: t('chatInput.aiServiceStartingDetail'), preparing: true };
  }
  if (availability === 'models-loading') {
    return { label: t('chatInput.modelsLoading'), detail: t('chatInput.modelsLoadingDetail'), preparing: true };
  }
  // ⚠️ 这一档**不许**说「准备完成后会自动显示，无需重复操作」—— 那是让用户永远等下去。
  //    取不到就说取不到，并且告诉他还有下一步（重连/重试会自己再取一次）。
  if (availability === 'catalog-failed') {
    return {
      label: t('chatInput.modelsUnavailable'),
      detail: t('chatInput.modelsUnavailableDetail'),
      preparing: false,
    };
  }
  if (availability === 'empty') {
    return {
      label: t('chatInput.noModelsAvailable'),
      detail: t('chatInput.noModelsAvailableDetail'),
      preparing: false,
    };
  }
  return null;
}
