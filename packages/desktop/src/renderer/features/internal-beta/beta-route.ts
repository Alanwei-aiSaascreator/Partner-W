import { BETA_MODULES, type BetaModule } from './beta-store';

const MODULE_IDS = new Set(BETA_MODULES.map((item) => item.id));

/**
 * 客户发行包默认不暴露公司内测/运营入口。只有专门的内部构建显式写入
 * `VITE_INTERNAL_BETA_ENABLED=true` 才能打开；不能靠“入口不明显”当权限边界。
 */
export function isInternalBetaEnabled(value = import.meta.env.VITE_INTERNAL_BETA_ENABLED): boolean {
  return value === 'true';
}

export function betaRoute(module: BetaModule): string {
  return `#/beta/${module}`;
}

export function parseBetaRoute(hash: string): BetaModule | null {
  const match = /^#\/beta\/([a-z]+)$/.exec(hash);
  if (!match || !MODULE_IDS.has(match[1] as BetaModule)) return null;
  return match[1] as BetaModule;
}
