import type { BetaData } from './beta-store';

/**
 * 内测数据的**存储接缝** —— 换后端时只用换这一个实现。
 *
 * ## ⚠️ 现在没有任何地方 import 它（这是**决定过的**，不是漏接）
 *
 * 2026-09-19 用户拍板：**保留、标注为扩展点、不暴露 UI**。
 * 所以 `check:dead-code`（knip）会一直报这条 **Unused file** ——
 * 那是**刻意的**，别当成待修项删掉（要删得先推翻这个决定）。
 *
 * 为什么留：`beta-store` 现在是直接读写本机快照的。将来若把内测数据挪到
 * Supabase / 国内服务器，改动面就落在这一层 —— 有了接缝，store 与界面都不用动。
 *
 * ## 接上去要做什么（给将来的自己）
 *
 * 1. 在某处（很可能是 `beta-store` 的初始化）`new LocalBetaService(load, save)`，
 *    或换成远端实现；
 * 2. 让 `beta-store` 的读写走 `BetaService` 而不是直接碰快照。
 *
 * ⚠️ 在那之前**别把它接到界面上**：它现在是个纯转发壳，暴露出去只会多一个
 *    "看起来能用、其实没有后端"的入口。
 */
export interface BetaService {
  load(): Promise<BetaData>;
  save(snapshot: BetaData): Promise<void>;
}

export class LocalBetaService implements BetaService {
  constructor(
    private readonly loadSnapshot: () => BetaData,
    private readonly saveSnapshot: (snapshot: BetaData) => void,
  ) {}

  async load(): Promise<BetaData> {
    return this.loadSnapshot();
  }

  async save(snapshot: BetaData): Promise<void> {
    this.saveSnapshot(snapshot);
  }
}
