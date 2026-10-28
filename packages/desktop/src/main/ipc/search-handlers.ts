import { ipcMain } from 'electron';
import { getSqlite } from '../db/index.js';
import { globalSearch } from '../db/search.js';

export function registerSearchHandlers(): void {
  ipcMain.handle('search:global', (_event, query: string) => {
    const db = getSqlite();
    if (!db) return { ok: false, error: 'database not initialized' };
    try {
      const results = globalSearch(db, query);
      return { ok: true, results };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'search failed';
      return { ok: false, error: msg };
    }
  });
}
