import type { BetaData } from './beta-store';

/** Replacement seam for the future Supabase/domestic-server implementation. */
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
