import { BETA_MODULES, type BetaModule } from './beta-store';

const MODULE_IDS = new Set(BETA_MODULES.map((item) => item.id));

export function betaRoute(module: BetaModule): string {
  return `#/beta/${module}`;
}

export function parseBetaRoute(hash: string): BetaModule | null {
  const match = /^#\/beta\/([a-z]+)$/.exec(hash);
  if (!match || !MODULE_IDS.has(match[1] as BetaModule)) return null;
  return match[1] as BetaModule;
}
