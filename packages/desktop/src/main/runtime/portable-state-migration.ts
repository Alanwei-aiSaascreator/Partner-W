import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/json-file.js';
import { rebaseConfigPaths, rebasePathValue } from './config-rebase.js';
import {
  probePidLiveness,
  processStartTimeMatches,
  readProcessStartTime,
  type PidLiveness,
} from './process-liveness.js';
import { acquireStateReadLease, type StateReadLease } from './state-read-lease.js';

export const PORTABLE_STATE_MIGRATION_BLOCKED = 'runtime.portable-state-migration-blocked';
const MARKER = '.clawwork-portable-state.json';
const GATEWAY_LOCK_NAME = /^gateway\..*\.lock$/u;

/**
 * 锁所有者核验的可注入面（BUG-039；默认实现在 `process-liveness.ts`）。
 *
 * ⚠️ 语义（改动必须同时改测试）：**"pid 活着"不等于"写锁的那个网关还在跑"**。
 *    判据链（BUG-059 附③ 定序）：
 *    ①锁里若带 `startTime`，与真实进程启动时间比对（**最决定性**：相符⇒一律不隔离；
 *      对不上⇒pid 被复用，按 stale 隔离）
 *    ②拿不到 startTime 时退回锁声明的 state/config 位置比对（先 realpath 归一——
 *      subst/junction 下内核写 realpath、应用传别名，"拼写不同"不等于"不是同一份"）
 *    ③都核验不了 ⇒ **有界等待**（窗口内退场即放行），仍在 ⇒ 阻断但给出可执行指引。
 */
export interface LockOwnerProbeOptions {
  /** 锁所有者的存活判定。 */
  liveness?: (pid: number) => PidLiveness;
  /** 真实进程启动时间（epoch ms）；读不到 `null`。 */
  startTime?: (pid: number) => number | null;
  /** 无法核验时的有界等待：总窗口（默认 2000ms）。 */
  waitMs?: number;
  /** 轮询间隔（默认 250ms）。 */
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface ResolvedLockOwnerProbe {
  liveness: (pid: number) => PidLiveness;
  startTime: (pid: number) => number | null;
  waitMs: number;
  pollMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const DEFAULT_LOCK_OWNER_WAIT_MS = 2_000;
const DEFAULT_LOCK_OWNER_POLL_MS = 250;

function resolveLockOwnerProbe(options: LockOwnerProbeOptions | undefined): ResolvedLockOwnerProbe {
  return {
    liveness: options?.liveness ?? probePidLiveness,
    startTime: options?.startTime ?? ((pid) => readProcessStartTime(pid)),
    waitMs: options?.waitMs ?? DEFAULT_LOCK_OWNER_WAIT_MS,
    pollMs: options?.pollMs ?? DEFAULT_LOCK_OWNER_POLL_MS,
    sleep: options?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    now: options?.now ?? (() => Date.now()),
  };
}

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
  /** BUG-039：锁所有者核验（可注入；默认见 `process-liveness.ts`）。 */
  lockOwner?: LockOwnerProbeOptions;
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
        !/^npm\/projects\/[^/]+\/node_modules\/openclaw$/u.test(normalized) &&
        // ⭐ 2026-10-19（用户实测「登不进去」）：官方 install 生成的 npm 项目里，
        //    **包自己**的 node_modules 下还有一条 peer 链（npm 为满足
        //    `peerDependencies.openclaw` 建的），形状：
        //    `npm/projects/<项目>/node_modules/@openclaw/feishu/node_modules/openclaw`
        //    旧白名单只认项目顶层那条 ⇒ 迁移判 blocked ⇒ 网关永远起不来。
        //    仍然收得很窄：只允许"一个包目录（可带 scope）+ node_modules/openclaw"。
        !/^npm\/projects\/[^/]+\/node_modules\/(?:@[^/]+\/)?[^/]+\/node_modules\/openclaw$/u.test(normalized) &&
        // ⭐ 2026-10-19（现场盘）：`openclaw plugins install` 装出来的插件会在
        //    `<state>\extensions\<插件>\node_modules\openclaw` 建一条指向随包运行时的
        //    junction。它和上面那条 npm 链是同一类东西（插件拿宿主内核），只是落点不同。
        //    不认识它 ⇒ 换盘符后整个迁移被判 blocked，网关直接不启动（表现就是准备页卡住）。
        //    仍然收得很窄：只认"插件目录下一层 + node_modules/openclaw"。
        !/^extensions\/[^/]+\/node_modules\/openclaw$/u.test(normalized)
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

/** 锁里声明的"我是哪一份 state"（`stateDir` 优先，退回 `configPath` 的目录）。 */
function declaredLocationOf(lock: Record<string, unknown>): string | null {
  if (typeof lock.stateDir === 'string' && lock.stateDir.trim()) return lock.stateDir;
  if (typeof lock.configPath === 'string' && lock.configPath.trim()) return path.dirname(lock.configPath);
  return null;
}

/** 词法归一（盘符路径按 win32 + 大小写不敏感；末尾分隔符无关）。 */
function normalizeDirectory(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const win = /^[A-Za-z]:[\\/]/u.test(trimmed);
  const flavor = win ? path.win32 : path;
  if (!flavor.isAbsolute(trimmed)) return null;
  const normalized = flavor.normalize(trimmed).replace(/[\\/]+$/u, '');
  return win ? normalized.toLowerCase() : normalized;
}

/**
 * realpath 归一（BUG-059 附③）：**subst / junction / 8.3 短名下，同一个目录会有多种拼写**。
 *
 * ⚠️ 必须用 `realpathSync.native` —— 普通 `realpathSync` 在 subst 盘上原样返回别名
 *    （实测：`realpathSync('X:\\state') = 'X:\\state'`，`.native` 才解析到真路径）。
 *    读不到（路径不存在 / 无权限）⇒ `null`（判不出就別硬判）。
 */
function realDirectory(value: string): string | null {
  try {
    const real = fs.realpathSync.native(value);
    // Windows 扩展前缀（`\\?\` / `\\?\UNC\`）只是写法，归一后再比。
    const withoutPrefix = real.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '');
    return normalizeDirectory(withoutPrefix);
  } catch {
    return null;
  }
}

function sameDirectory(left: string, right: string): boolean {
  const a = normalizeDirectory(left);
  const b = normalizeDirectory(right);
  if (a !== null && b !== null && a === b) return true;
  // 词法对不上 ≠ 不是同一份（内核写 realpath、应用传别名是现场形态）——再看真路径。
  const realLeft = realDirectory(left);
  const realRight = realDirectory(right);
  return realLeft !== null && realRight !== null && realLeft === realRight;
}

function declaredOwnerStartTime(lock: Record<string, unknown>): number | null {
  return typeof lock.startTime === 'number' && Number.isFinite(lock.startTime) ? lock.startTime : null;
}

/** 锁的 pid 是否"值得当一会儿真"（活着，或探不动 —— 探不动不算死）。 */
function pidMightBeAlive(pid: number, probe: ResolvedLockOwnerProbe): boolean {
  return probe.liveness(pid) !== 'gone';
}

/**
 * 隔离**不可用**的网关锁 —— 两类，各自留痕：
 *
 * ① `corrupt-`：不可解析 / 无有效 pid（BUG-035 现场：不安全拔盘让"JSON + padding
 *    原位覆写"的锁半写完，实测 493 字节全 NUL；旧行为是 readJson 直接炸 → 整盘永久
 *    卡在"启动准备"）。真在运行的网关锁必然可解析且带有效 pid ⇒ 这类只能是陈旧残留。
 *
 * ② `stale-`：**身份对不上**（BUG-039 现场：`Previous gateway is still running` 让整盘
 *    阻断）。两种形态都决定性：锁声明的 `stateDir`/`configPath` 不是这一份 state
 *    （别的机器 / 旧盘符搬来的残留）；或锁里的 `startTime` 与 pid 现在的真实进程
 *    启动时间对不上（**pid 被系统复用了** —— 那个进程还活着，但根本不是那个网关）。
 *
 * 一律**改名保留现场**（不是删除）："是否真有活动网关"仍由 `assertStopped` 与随后的
 * 只读租约负责。判不出来的一律不动（宁可阻断也不误放）。
 */
function quarantineUnusableLocks(root: string, entries: Entry[], probe: ResolvedLockOwnerProbe): number {
  let quarantined = 0;
  const quarantine = (file: string, relative: string, reason: 'corrupt' | 'stale', detail: string): void => {
    const target = `${file}.${reason}-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
    try {
      fs.renameSync(file, target);
    } catch (error) {
      // BUG-059 附②：隔离失败（锁被占用 / 介质只读）**不许抛裸错误** —— 那会绕过
      // "阻断 + 可执行指引"的既定路径（现场 2026-10-04 的教训：用户与排查者都无从下手）。
      // fail-closed：不删、不改，原样保留现场，把下一步写进消息里。
      throw new Error(
        `无法隔离不可用的网关锁（${relative}）：文件被占用或所在介质不可写（${
          error instanceof Error ? error.message : String(error)
        }）。` +
          '请先完全退出荣盈魔方、等本机服务结束后重试；' +
          `若确认没有网关在运行，可手动把该锁文件改名备份后重试：${file}`,
      );
    }
    quarantined += 1;
    console.warn(
      `[portable-state-migration] quarantined ${reason} gateway lock: ${relative} -> ${path.basename(target)}（${detail}）`,
    );
  };

  for (const entry of entries) {
    if (entry.kind !== 'file' || !GATEWAY_LOCK_NAME.test(path.basename(entry.relative))) continue;
    const file = path.join(root, entry.relative);

    let lock: Record<string, unknown>;
    try {
      lock = readJson(file);
    } catch {
      quarantine(file, entry.relative, 'corrupt', '锁内容读不出来');
      continue;
    }
    const pid = lock.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
      quarantine(file, entry.relative, 'corrupt', '锁里没有有效 pid');
      continue;
    }

    // ⚠️ 判据顺序（BUG-059 附③）：**startTime 相符是所有判据里最决定性的** ——
    //    一致即确认"用的就是那个进程"，此后**一律不隔离**（位置拼写差异不算数：
    //    subst/junction 下内核写 realpath、应用传别名是现场形态，纯词法比对会把
    //    **活网关的锁**误判成"别处的残留"）。对不上（pid 复用）同样决定性 ⇒ 直接隔离。
    const declaredStart = declaredOwnerStartTime(lock);
    if (declaredStart !== null && pidMightBeAlive(pid, probe)) {
      const actualStart = probe.startTime(pid);
      if (actualStart !== null) {
        if (processStartTimeMatches(declaredStart, actualStart)) continue;
        quarantine(file, entry.relative, 'stale', `pid ${pid} 已被系统复用（启动时间对不上）`);
        continue;
      }
    }

    // 身份核验拿不到时，位置判据兜底（realpath 归一后仍对不上 ⇒ 别的机器/旧盘符残留）。
    const declaredLocation = declaredLocationOf(lock);
    if (declaredLocation && !sameDirectory(declaredLocation, root)) {
      quarantine(file, entry.relative, 'stale', `锁声明的位置不是这一份 state（${declaredLocation}）`);
    }
  }
  return quarantined;
}

/**
 * 有界等待锁所有者退场（无法核验时的唯一让步）。
 *
 * ⚠️ 绝不 kill：只轮询"它还在不在"。窗口走完仍未退 ⇒ 调用方继续阻断。
 */
async function waitForOwnerExit(pid: number, probe: ResolvedLockOwnerProbe): Promise<boolean> {
  const deadline = probe.now() + probe.waitMs;
  while (probe.now() < deadline) {
    await probe.sleep(probe.pollMs);
    if (!pidMightBeAlive(pid, probe)) return true;
  }
  return !pidMightBeAlive(pid, probe);
}

/**
 * 「旧网关还在跑吗」——迁移前的硬闸。
 *
 * 判定（钉死，改动必须同时改测试）：
 * ```
 * 锁读不出来 / pid 无效            ⇒ 跳过（quarantine 阶段已处置）
 * 锁声明的位置不是这一份 state      ⇒ 跳过（不是这一份 state 的网关）
 * pid 已消失                       ⇒ 跳过（陈旧残留）
 * 锁带 startTime 且真实启动时间不符 ⇒ 跳过（pid 复用 —— 写锁的网关早没了）
 * 锁带 startTime 且真实启动时间相符 ⇒ 阻断（**确认**是我们的网关还在跑，一秒不等）
 * 其余（无法核验）                  ⇒ 有界等待；仍在 ⇒ 阻断 + 给出锁文件与 pid 的指引
 * ```
 */
async function assertStopped(root: string, entries: Entry[], probe: ResolvedLockOwnerProbe): Promise<void> {
  for (const entry of entries) {
    if (entry.kind !== 'file' || !GATEWAY_LOCK_NAME.test(path.basename(entry.relative))) continue;
    const file = path.join(root, entry.relative);

    let lock: Record<string, unknown>;
    try {
      lock = readJson(file);
    } catch {
      continue;
    }
    const pid = lock.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;

    const declaredLocation = declaredLocationOf(lock);
    if (declaredLocation && !sameDirectory(declaredLocation, root)) continue;

    if (!pidMightBeAlive(pid, probe)) continue;

    const declaredStart = declaredOwnerStartTime(lock);
    if (declaredStart !== null) {
      const actualStart = probe.startTime(pid);
      if (actualStart !== null) {
        if (!processStartTimeMatches(declaredStart, actualStart)) continue;
        throw previousGatewayRunning(file, entry.relative, pid);
      }
    }

    if (await waitForOwnerExit(pid, probe)) continue;
    throw previousGatewayRunning(file, entry.relative, pid);
  }
}

/**
 * 阻断信息必须**可执行**（2026-10-04 客户机现场：只有一句
 * `Gateway lock owner cannot be verified`，用户与排查者都无从下手）。
 */
function previousGatewayRunning(file: string, relative: string, pid: number): Error {
  return new Error(
    'Previous gateway is still running; close it before migrating portable state' +
      `（锁文件: ${relative}，PID ${pid}）。` +
      '请先完全退出荣盈魔方、等本机服务结束再重试；' +
      `若确认该进程不是网关（pid 被复用/旧机器残留），可把锁文件改名备份后重试：${file}`,
  );
}

/**
 * 换盘重写（C2 深度重写）：**按键名**重写配置树里的路径字段，而不是逐字段列举。
 *
 * 判据与遍历在 `config-rebase.ts`（只依赖 `node:path`，可脱离 Electron 单测）；
 * 这里只保留一个稳定出口。事故记录（`plugins.load.paths` 换盘后不重写 ⇒ 三个
 * 承重插件静默失效）与两层判据见该文件顶部注释 —— **改动必须同时改
 * `test/portable-config-rebase.test.ts`**。
 */
export function rebasePortableConfig(
  config: Record<string, unknown>,
  previous: Location,
  next: Location,
): Record<string, unknown> {
  return rebaseConfigPaths(config, previous, next).config;
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
          entryValue.sessionFile = rebasePathValue(entryValue.sessionFile, previous, next);
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
    const snapshot = inventory(input);
    // 不可用锁先隔离（损坏=BUG-035 / 身份对不上=BUG-039）；重命名后重新取快照，
    // 保证其后"迁移期间状态未变"的对比自洽。
    const lockOwner = resolveLockOwnerProbe(opts.lockOwner);
    const before = quarantineUnusableLocks(input, snapshot, lockOwner) > 0 ? inventory(input) : snapshot;
    await assertStopped(input, before, lockOwner);
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
    await assertStopped(input, locked, lockOwner);
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
