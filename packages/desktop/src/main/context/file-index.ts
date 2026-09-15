import { lstatSync, opendirSync, realpathSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { extname, isAbsolute, join, relative, sep } from 'node:path';
import type { FileIndexEntry } from '@clawwork/shared';
import { classifyTier, getMimeType } from './file-types.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  '.next',
  '.venv',
  'venv',
  '.cache',
  'coverage',
  '.idea',
  '.vscode',
  '.turbo',
  '.output',
  '.nuxt',
  '.svelte-kit',
]);
const ALLOWED_DOT_FILES = new Set(['.env', '.gitignore', '.dockerfile']);
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const DEFAULT_MAX_VISITED_ENTRIES = 2_000;
const DEFAULT_MAX_RESULTS = 100;
const HARD_MAX_VISITED_ENTRIES = 50_000;
const HARD_MAX_RESULTS = 5_000;

interface ScanHooks {
  afterRootValidation?: () => void;
  afterEntryLstat?: (entryPath: string) => void;
}

interface IndexedFile {
  entry: FileIndexEntry;
  identity: Stats;
}

interface ScanOptions {
  maxDepth?: number;
  query?: string;
  maxVisitedEntries?: number;
  maxResults?: number;
}

interface ScanState {
  visitedEntries: number;
  maxVisitedEntries: number;
  maxResults: number;
  stopped: boolean;
}

function isHidden(name: string): boolean {
  return name.startsWith('.') && !ALLOWED_DOT_FILES.has(name.toLowerCase());
}

function boundedBudget(value: number | undefined, fallback: number, hardMaximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(hardMaximum, Math.max(0, Math.floor(value)));
}

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  const devAndIno =
    Number.isFinite(left.dev) &&
    Number.isFinite(left.ino) &&
    Number.isFinite(right.dev) &&
    Number.isFinite(right.ino) &&
    left.dev > 0 &&
    left.ino > 0 &&
    right.dev > 0 &&
    right.ino > 0;
  if (devAndIno) return left.dev === right.dev && left.ino === right.ino;
  const hasFallback =
    Number.isFinite(left.birthtimeMs) &&
    Number.isFinite(right.birthtimeMs) &&
    left.birthtimeMs > 0 &&
    right.birthtimeMs > 0 &&
    Number.isFinite(left.size) &&
    Number.isFinite(right.size) &&
    Number.isFinite(left.mtimeMs) &&
    Number.isFinite(right.mtimeMs);
  return (
    hasFallback && left.birthtimeMs === right.birthtimeMs && left.size === right.size && left.mtimeMs === right.mtimeMs
  );
}

function validateRoot(canonicalRoot: string, expected?: Stats): Stats {
  try {
    const linkStat = lstatSync(canonicalRoot);
    const currentRoot = realpathSync.native(canonicalRoot);
    const identity = statSync(currentRoot);
    if (
      linkStat.isSymbolicLink() ||
      relative(canonicalRoot, currentRoot) !== '' ||
      !identity.isDirectory() ||
      (expected && !sameIdentity(expected, identity))
    )
      throw new Error();
    return identity;
  } catch {
    throw new Error('context folder changed or unavailable');
  }
}

function validateEntry(canonicalRoot: string, entryPath: string, expected?: Stats): { realPath: string; stat: Stats } {
  try {
    const linkStat = lstatSync(entryPath);
    if (linkStat.isSymbolicLink()) throw new Error('skip symlink');
    const realPath = realpathSync.native(entryPath);
    const stat = statSync(realPath);
    if (!isContained(canonicalRoot, realPath) || (expected && !sameIdentity(expected, stat))) throw new Error();
    return { realPath, stat };
  } catch (error) {
    if (error instanceof Error && error.message === 'skip symlink') throw error;
    throw new Error('context entry changed or unavailable');
  }
}

function walkDir(
  dir: string,
  canonicalRoot: string,
  results: IndexedFile[],
  depth: number,
  maxDepth: number,
  state: ScanState,
  hooks?: ScanHooks,
): void {
  if (depth > maxDepth || state.stopped) return;
  if (!validateEntry(canonicalRoot, dir)) throw new Error('context folder changed or unavailable');

  let directory;
  try {
    directory = opendirSync(dir);
  } catch {
    throw new Error('context folder changed or unavailable');
  }

  try {
    let dirent;
    while (!state.stopped && (dirent = directory.readSync()) !== null) {
      if (state.visitedEntries >= state.maxVisitedEntries) {
        state.stopped = true;
        break;
      }
      state.visitedEntries++;
      const name = dirent.name;
      if (isHidden(name)) continue;
      const fullPath = join(dir, name);
      let before: Stats;
      try {
        before = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (before.isSymbolicLink()) continue;
      hooks?.afterEntryLstat?.(fullPath);

      let validated: { realPath: string; stat: Stats };
      try {
        validated = validateEntry(canonicalRoot, fullPath, before);
      } catch {
        throw new Error('context entry changed or unavailable');
      }
      if (validated.stat.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        walkDir(validated.realPath, canonicalRoot, results, depth + 1, maxDepth, state, hooks);
        continue;
      }
      if (!validated.stat.isFile() || validated.stat.size > MAX_FILE_SIZE) continue;
      const lowerName = name.toLowerCase();
      const ext = ALLOWED_DOT_FILES.has(lowerName) ? lowerName : extname(name).toLowerCase();
      const tier = classifyTier(ext);
      if (tier === 'unsupported') continue;
      results.push({
        entry: {
          relativePath: relative(canonicalRoot, validated.realPath),
          absolutePath: validated.realPath,
          fileName: name,
          size: validated.stat.size,
          mtime: validated.stat.mtimeMs,
          mimeType: getMimeType(ext),
          tier,
        },
        identity: validated.stat,
      });
      if (results.length >= state.maxResults) state.stopped = true;
    }
  } finally {
    directory.closeSync();
  }
}

function scanFolderInternal(folderPath: string, opts?: ScanOptions, hooks?: ScanHooks): FileIndexEntry[] {
  const maxDepth = opts?.maxDepth ?? 4;
  const state: ScanState = {
    visitedEntries: 0,
    maxVisitedEntries: boundedBudget(opts?.maxVisitedEntries, DEFAULT_MAX_VISITED_ENTRIES, HARD_MAX_VISITED_ENTRIES),
    maxResults: boundedBudget(opts?.maxResults, DEFAULT_MAX_RESULTS, HARD_MAX_RESULTS),
    stopped: false,
  };
  const rootIdentity = validateRoot(folderPath);
  hooks?.afterRootValidation?.();
  validateRoot(folderPath, rootIdentity);
  const indexed: IndexedFile[] = [];
  if (state.maxVisitedEntries > 0 && state.maxResults > 0) {
    walkDir(folderPath, folderPath, indexed, 0, maxDepth, state, hooks);
  }
  validateRoot(folderPath, rootIdentity);
  for (const file of indexed) validateEntry(folderPath, file.entry.absolutePath, file.identity);
  const results = indexed.map(({ entry }) => entry);
  if (opts?.query) {
    const q = opts.query.toLowerCase();
    const scored = results
      .map((entry) => ({ entry, score: fuzzyScore(entry.fileName.toLowerCase(), entry.relativePath.toLowerCase(), q) }))
      .filter(({ score }) => score > 0);
    scored.sort((a, b) => b.score - a.score || b.entry.mtime - a.entry.mtime);
    return scored.map(({ entry }) => entry);
  }
  results.sort((a, b) => b.mtime - a.mtime);
  return results;
}

export function scanFolder(folderPath: string, opts?: ScanOptions): FileIndexEntry[] {
  return scanFolderInternal(folderPath, opts);
}

export const __testing = Object.freeze({
  scanFolderWithHooks: (folderPath: string, opts: ScanOptions, hooks: ScanHooks): FileIndexEntry[] =>
    scanFolderInternal(folderPath, opts, hooks),
});

function fuzzyScore(fileName: string, relPath: string, query: string): number {
  if (fileName === query) return 100;
  if (fileName.startsWith(query)) return 80;
  if (fileName.includes(query)) return 60;
  if (relPath.includes(query)) return 40;
  let qi = 0;
  for (let i = 0; i < fileName.length && qi < query.length; i++) if (fileName[i] === query[qi]) qi++;
  return qi === query.length ? 20 : 0;
}
