import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/json-file.js';
import { acquireStateReadLease, type StateReadLease } from './state-read-lease.js';

export const PORTABLE_STATE_MIGRATION_BLOCKED = 'runtime.portable-state-migration-blocked';
const MARKER = '.clawwork-portable-state.json';

export class PortableStateMigrationError extends Error {
  readonly code = PORTABLE_STATE_MIGRATION_BLOCKED;
}

interface Entry {
  relative: string;
  kind: 'file' | 'directory' | 'link';
  digest: string;
}
interface Location {
  stateDir: string;
  workspacePath: string;
}
interface MigrationOptions extends Location {
  sourceDir?: string;
  token: string;
  acquireLease?: (files: string[]) => Promise<StateReadLease>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!record(value)) throw new Error('Invalid portable state metadata');
  return value;
}

function inventory(root: string): Entry[] {
  const result: Entry[] = [];
  const visit = (relative: string): void => {
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const normalized = relative.replaceAll('\\', '/');
      if (
        !/^plugin-skills\/[^/]+$/u.test(normalized) &&
        !/^npm\/projects\/[^/]+\/node_modules\/openclaw$/u.test(normalized)
      ) {
        throw new Error('State contains an unsupported link; migration requires review');
      }
      result.push({ relative, kind: 'link', digest: fs.readlinkSync(absolute) });
    } else if (stat.isDirectory()) {
      result.push({ relative, kind: 'directory', digest: '' });
      for (const name of fs.readdirSync(absolute).sort()) visit(path.join(relative, name));
    } else if (stat.isFile()) {
      result.push({
        relative,
        kind: 'file',
        digest: createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
      });
    } else throw new Error('State contains an unsupported filesystem entry');
  };
  visit('');
  return result;
}

function assertStopped(root: string, entries: Entry[]): void {
  for (const entry of entries) {
    if (entry.kind !== 'file' || !/^gateway\..*\.lock$/u.test(path.basename(entry.relative))) continue;
    const lock = readJson(path.join(root, entry.relative));
    if (typeof lock.pid !== 'number' || !Number.isInteger(lock.pid) || lock.pid <= 0)
      throw new Error('Gateway lock owner cannot be verified');
    try {
      process.kill(lock.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue;
      throw new Error('Gateway lock owner cannot be verified');
    }
    throw new Error('Previous gateway is still running; close it before migrating portable state');
  }
}

function rebasePath(value: unknown, previous: Location, next: Location): unknown {
  if (typeof value !== 'string') return value;
  const flavor = /^[A-Za-z]:[\\/]/u.test(value) ? path.win32 : path;
  if (!flavor.isAbsolute(value)) return value;
  for (const key of ['workspacePath', 'stateDir'] as const) {
    if (!previous[key]) continue;
    if (
      key === 'workspacePath' &&
      path.win32.normalize(previous[key]).slice(2).toLowerCase() !==
        path.win32.normalize(next[key]).slice(2).toLowerCase()
    )
      continue;
    const relative = flavor.relative(previous[key], value);
    if (
      relative === '' ||
      (!relative.startsWith(`..${flavor.sep}`) && relative !== '..' && !flavor.isAbsolute(relative))
    ) {
      return flavor.join(next[key], relative);
    }
  }
  return value;
}

export function rebasePortableConfig(
  config: Record<string, unknown>,
  previous: Location,
  next: Location,
): Record<string, unknown> {
  const result = structuredClone(config);
  const agents = record(result.agents) ? result.agents : null;
  if (agents) {
    const configs = [
      agents.defaults,
      ...(record(agents.entries) ? Object.values(agents.entries) : []),
      ...(Array.isArray(agents.list) ? agents.list : []),
    ];
    for (const agent of configs) {
      if (!record(agent)) continue;
      for (const key of ['workspace', 'agentDir'])
        if (key in agent) agent[key] = rebasePath(agent[key], previous, next);
    }
  }
  if (record(result.session) && 'store' in result.session)
    result.session.store = rebasePath(result.session.store, previous, next);
  if (record(result.cron) && 'store' in result.cron) result.cron.store = rebasePath(result.cron.store, previous, next);
  if (record(result.skills) && record(result.skills.load) && Array.isArray(result.skills.load.extraDirs)) {
    result.skills.load.extraDirs = result.skills.load.extraDirs.map((value) => rebasePath(value, previous, next));
  }
  return result;
}

function sourceLocation(root: string, fallbackWorkspace: string): Location {
  const marker = path.join(root, MARKER);
  if (fs.existsSync(marker)) {
    const stored = readJson(marker);
    if (stored.version !== 1 || typeof stored.stateDir !== 'string' || typeof stored.workspacePath !== 'string')
      throw new Error('Unknown portable state marker');
    return { stateDir: stored.stateDir, workspacePath: stored.workspacePath };
  }
  const config = path.join(root, 'openclaw.json');
  const value = fs.existsSync(config) ? readJson(config) : {};
  const agents = record(value.agents) ? value.agents : {};
  const entries = record(agents.entries) ? agents.entries : {};
  const main = record(entries.main) ? entries.main : {};
  return { stateDir: root, workspacePath: typeof main.workspace === 'string' ? main.workspace : fallbackWorkspace };
}

function assertIdentity(root: string, token: string): void {
  const config = readJson(path.join(root, 'openclaw.json'));
  const gateway = record(config.gateway) ? config.gateway : {};
  const auth = record(gateway.auth) ? gateway.auth : {};
  if (auth.token !== token) throw new Error('Legacy state does not match this portable identity');
}

function writeLocation(root: string, next: Location): void {
  writeJsonAtomic(path.join(root, MARKER), { version: 1, ...next });
}

function rebaseFiles(root: string, entries: Entry[], previous: Location, next: Location): Map<string, Buffer> {
  const changes = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.kind !== 'file') continue;
    const relative = entry.relative.replaceAll('\\', '/');
    const configFile = /^openclaw\.json(?:\.last-good|\.bak(?:\.\d+)?)?$/u.test(relative);
    const sessionIndex = /^agents\/[^/]+\/sessions\/sessions\.json$/u.test(relative);
    if (!configFile && !sessionIndex) continue;
    const file = path.join(root, entry.relative);
    const original = readJson(file);
    const value = configFile ? rebasePortableConfig(original, previous, next) : structuredClone(original);
    if (sessionIndex)
      for (const entryValue of Object.values(value)) {
        if (record(entryValue) && 'sessionFile' in entryValue)
          entryValue.sessionFile = rebasePath(entryValue.sessionFile, previous, next);
      }
    if (JSON.stringify(value) !== JSON.stringify(original))
      changes.set(file, Buffer.from(JSON.stringify(value, null, 2)));
  }
  return changes;
}

function publishRebase(root: string, changes: Map<string, Buffer>, next: Location): void {
  const backup = new Map<string, Buffer>();
  try {
    for (const [file, value] of changes) {
      backup.set(file, fs.readFileSync(file));
      writeJsonAtomic(file, JSON.parse(value.toString()));
    }
    writeLocation(root, next);
  } catch (error) {
    for (const [file, value] of backup) writeJsonAtomic(file, JSON.parse(value.toString()));
    throw error;
  }
}

async function preparePortableStateImpl(opts: MigrationOptions): Promise<{ previousStateDir?: string }> {
  const target = path.resolve(opts.stateDir);
  const source = opts.sourceDir ? path.resolve(opts.sourceDir) : undefined;
  const existing = fs.existsSync(target);
  const input = existing ? target : source && fs.existsSync(source) ? source : undefined;
  const next: Location = { stateDir: target, workspacePath: opts.workspacePath };
  if (!input) {
    fs.mkdirSync(target, { recursive: true });
    writeLocation(target, next);
    return {};
  }
  let stage: string | undefined;
  let lease: StateReadLease | undefined;
  try {
    const previous = sourceLocation(input, opts.workspacePath);
    if (
      existing &&
      previous.stateDir === target &&
      previous.workspacePath === next.workspacePath &&
      fs.existsSync(path.join(target, MARKER))
    )
      return {};
    assertIdentity(input, opts.token);
    const before = inventory(input);
    assertStopped(input, before);
    const changes = existing ? rebaseFiles(input, before, previous, next) : new Map<string, Buffer>();
    lease = await (opts.acquireLease ?? acquireStateReadLease)(
      before
        .filter(
          (entry) =>
            entry.kind === 'file' &&
            (!existing || (entry.relative !== MARKER && !changes.has(path.join(input, entry.relative)))),
        )
        .map((entry) => path.join(input, entry.relative)),
    );
    const locked = inventory(input);
    if (JSON.stringify(before) !== JSON.stringify(locked))
      throw new Error('State changed before the read lease was acquired');
    assertStopped(input, locked);
    if (existing) {
      lease.assertHeld();
      publishRebase(target, changes, next);
      return { previousStateDir: previous.stateDir };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    stage = fs.mkdtempSync(`${target}.migrating-`);
    writeJsonAtomic(path.join(stage, '.migration-in-progress.json'), {
      version: 1,
      source: input,
      target,
      id: randomUUID(),
    });
    for (const entry of locked) {
      if (!entry.relative || /^(?:tmp|cache)(?:[\\/]|$)/u.test(entry.relative) || entry.relative === MARKER) continue;
      const destination = path.join(stage, entry.relative);
      if (entry.kind === 'directory') fs.mkdirSync(destination, { recursive: true });
      else if (entry.kind === 'link') fs.symlinkSync(entry.digest, destination, 'junction');
      else {
        fs.copyFileSync(path.join(input, entry.relative), destination, fs.constants.COPYFILE_EXCL);
        const descriptor = fs.openSync(destination, 'r+');
        try {
          fs.fsyncSync(descriptor);
        } finally {
          fs.closeSync(descriptor);
        }
        const digest = createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
        if (digest !== entry.digest) throw new Error('Copied state did not match the source snapshot');
      }
    }
    if (JSON.stringify(inventory(input)) !== JSON.stringify(locked)) throw new Error('State changed during migration');
    lease.assertHeld();
    publishRebase(stage, rebaseFiles(stage, inventory(stage), previous, next), next);
    fs.unlinkSync(path.join(stage, '.migration-in-progress.json'));
    if (fs.existsSync(target))
      throw new Error('Portable state target appeared during migration; it was not overwritten');
    fs.renameSync(stage, target);
    stage = undefined;
    return { previousStateDir: previous.stateDir };
  } finally {
    if (lease) await lease.release();
    if (
      stage &&
      path.dirname(stage) === path.dirname(target) &&
      path.basename(stage).startsWith(`${path.basename(target)}.migrating-`)
    )
      fs.rmSync(stage, { recursive: true, force: true });
  }
}

export async function preparePortableState(opts: MigrationOptions): Promise<{ previousStateDir?: string }> {
  try {
    return await preparePortableStateImpl(opts);
  } catch (error) {
    throw new PortableStateMigrationError(
      `Portable state migration blocked: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
