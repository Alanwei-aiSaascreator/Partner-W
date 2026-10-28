/**
 * 启动时把工作区准备好（T-U1）。
 *
 * 三件事，全部**不许**把用户甩掉（旧行为是 `showErrorBox('Database Error')` + `app.quit()`）：
 *   1. 盘上首启（配置里没有 `workspacePath` 且从 U 盘运行）⇒ 自动用 `<盘根>\Partner-W工作区\`
 *   2. 盘符变了 / 换机器（记录的位置不存在）⇒ 自愈：唯一命中静默改配置，多命中/零命中弹中文对话框
 *   3. 数据库打不开 ⇒ 「选择其它目录 / 重建工作区 / 退出」三选一
 *
 * ⚠️ 判定逻辑全在 `portable.ts`（纯函数、有单测）；本模块只负责**执行**它 ——
 *    副作用全从参数注入（对话框、数据库、`exists`、盘列表、`quit`），
 *    这样"失败路径到底会不会退出"才测得出来。
 */

import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DB_FILE_NAME } from '@clawwork/shared';
import { closeDatabase, initDatabase } from '../db/index.js';
import { initWorkspace, readWorkspaceId } from './init.js';
import { removableDrives, setRemovableDrives } from './removable-drives.js';
import {
  bindingForPickedDirectory,
  decideWorkspaceStartup,
  detectPortableRun,
  sameVolumeRoot,
  volumeRootOf,
  workspaceLocationPatch,
  type WorkspaceStartupDecision,
} from './portable.js';
import { recordWorkspaceStartupDecision } from './startup-notice.js';
import {
  getDefaultWorkspacePath,
  getHomedirWorkspacePath,
  getPortableWorkspaceRoot,
  readConfig,
  setPortableWorkspaceRoot,
  updateConfig,
} from './config.js';

type EventLog = (event: string, data?: Record<string, unknown>) => void;

/** 「找不到工作区」对话框里用户的选择。 */
export type MissingWorkspaceChoice =
  /** 用户从列出的候选里挑了一个（多命中）。 */
  | { kind: 'use'; path: string }
  /** 去选目录。 */
  | { kind: 'browse' }
  /** 新建一份空工作区。 */
  | { kind: 'create' }
  | { kind: 'quit' };

/** 「数据库打不开」对话框里用户的选择。 */
export type UnusableWorkspaceChoice = 'browse' | 'rebuild' | 'quit';

export interface WorkspaceStartupDialogs {
  askForMissingWorkspace(input: {
    recordedPath: string;
    candidates: readonly string[];
  }): Promise<MissingWorkspaceChoice>;
  browseForDirectory(defaultPath: string): Promise<string | null>;
  askForUnusableWorkspace(input: { workspacePath: string; message: string }): Promise<UnusableWorkspaceChoice>;
  /** 最后一招（重试次数用尽）：只说一句中文，用户点掉就退出。 */
  notifyFatal?(input: { title: string; message: string; detail: string }): Promise<void>;
}

export interface WorkspaceDatabasePort {
  init(workspacePath: string): void;
  /**
   * 放掉当前句柄（idempotent）。**「重建工作区」必须在改名之前调它**：
   * 还开着句柄时 Windows 上的 `rename` 必定 EBUSY（共享模式不含 FILE_SHARE_DELETE）。
   */
  close(): void;
}

export type WorkspaceStartupResult =
  | { kind: 'ready'; path: string; portable: boolean; decision: WorkspaceStartupDecision }
  /** 用户在对话框里明确选了「退出」。**只有这一条路会退出。** */
  | { kind: 'quit'; reason: 'user-chose-quit' };

export interface PrepareWorkspaceOptions {
  /** 打包态传 `process.execPath`。 */
  exePath: string;
  /** 打包态传 `process.resourcesPath` —— 交付形态判据要用（不给就只能靠盘列表/marker 认盘）。 */
  resourcesPath?: string | null;
  /** 默认取 `workspace/startup-dialogs.ts` 里的真实 Electron 对话框。 */
  dialogs: WorkspaceStartupDialogs;
  /** 默认真数据库（`db/index.js`）。 */
  database?: WorkspaceDatabasePort;
  /** 默认 `listRemovableDrives()`（PowerShell 枚举，进程内记忆一次）。 */
  removableDrives?: readonly string[];
  exists?: (p: string) => boolean;
  /**
   * 默认读工作区标记里的身份（`init.ts` 的 `readWorkspaceId`）。
   *
   * 留这个注入口是为了让**编排层测试**跟 `exists` 一样不碰真文件系统：身份判定
   * 一旦绕过注入直接读真盘，本机恰好存在的盘符（例如真有 E: 盘）就会污染用例，
   * 让"虚拟盘"上的自愈时灵时不灵。
   */
  readWorkspaceId?: (workspacePath: string) => string | null;
  /** 默认 `initWorkspace()`（建目录 + 放工作区标记）。 */
  workspaceInit?: (workspacePath: string) => void | Promise<void>;
  /** 默认什么都不做。**唯一的真实调用方是 `app.quit()`** —— 只有用户选了「退出」才会走到。 */
  quit?: () => void;
  onEvent?: EventLog;
}

/** 对话框里最多来回几轮（用户一直不选就退出，不空转）。 */
const MAX_RECOVERY_ROUNDS = 5;

interface StartupContext {
  dialogs: WorkspaceStartupDialogs;
  database: WorkspaceDatabasePort;
  exists: (p: string) => boolean;
  readId: (workspacePath: string) => string | null;
  /** 惰性：常规启动（记录的位置还在）一次 PowerShell 都不跑。 */
  drives: () => readonly string[];
  prepare: (workspacePath: string) => void | Promise<void>;
  log: EventLog;
  /**
   * 判定出来的盘上运行卷根（非盘上形态为 null）。**判定之后**才赋值：那之前
   * 没有任何 `locationOf()` 会跑到（补记线索一律发生在"决定用哪个工作区"之后）。
   *
   * 用途只有一个：工作区落在**程序自己运行的那块盘**上时也要记盘符自愈线索
   * （`DriveType=3` 的盘不在可移动盘列表里，光靠列表一条都记不上）。
   */
  portableRoot: string | null;
}

/**
 * 把工作区准备好并打开数据库。**永不抛**（内部全部兜住），也不会因为
 * 工作区有问题就自己退出 —— 退出只能由用户在对话框里选。
 *
 * ⚠️ 这里的 try/catch 不是装饰：调用方是 `app.whenReady().then(async () => …)`，
 *    里面 `await` 它的下一条语句是 `createWindow()`。**一次拒绝 = 窗口永不创建**，
 *    进程却还活着（没有全局 unhandledRejection 兜底）—— 用户看到的是"双击了没反应"，
 *    比旧的「英文错误框 + 退出」更糟：至少那个会说句话。所以任何意外都得在这里
 *    转成一份"能继续"的结果（默认位置 + 尽力打开数据库），把话说给用户听。
 */
export async function prepareWorkspaceAtStartup(options: PrepareWorkspaceOptions): Promise<WorkspaceStartupResult> {
  try {
    return await runWorkspaceStartup(options);
  } catch (err) {
    const log = options.onEvent ?? ((): void => {});
    const message = err instanceof Error ? err.message : String(err);
    log('workspace.startup.unhandled', { message });

    // 退到默认位置（盘上形态就是盘根那份）并尽力把库打开；开不了也照样返回
    // —— 界面自己会表达"连不上/没就绪"，总好过一个字都没有的空屏幕。
    const fallbackPath = getDefaultWorkspacePath();
    const database = options.database ?? { init: initDatabase, close: closeDatabase };
    try {
      database.init(fallbackPath);
    } catch (dbErr) {
      log('workspace.startup.unhandled.db', {
        path: fallbackPath,
        message: dbErr instanceof Error ? dbErr.message : String(dbErr),
      });
    }
    return {
      kind: 'ready',
      path: fallbackPath,
      portable: Boolean(getPortableWorkspaceRoot()),
      // 判定没跑完 ⇒ 报最接近实情的那个 kind（调用方只用它写日志）
      decision: { kind: 'default', path: fallbackPath },
    };
  }
}

async function runWorkspaceStartup(options: PrepareWorkspaceOptions): Promise<WorkspaceStartupResult> {
  const exists = options.exists ?? existsSync;
  const readId = options.readWorkspaceId ?? readWorkspaceId;
  const quit = options.quit ?? ((): void => {});
  const database = options.database ?? { init: initDatabase, close: closeDatabase };

  // 盘列表：注入了就用注入的那份（整个进程共用，见 removable-drives.ts 的记忆）
  if (options.removableDrives) setRemovableDrives(options.removableDrives);

  let driveCache: readonly string[] | null = null;
  const drives = (): readonly string[] => {
    if (driveCache === null) driveCache = removableDrives();
    return driveCache;
  };

  // 只有"用户在对话框里明确点了退出"才会走到这里 —— 这是**唯一**能退出的地方。
  const userChoseQuit = (): WorkspaceStartupResult => {
    quit();
    return { kind: 'quit', reason: 'user-chose-quit' };
  };

  const ctx: StartupContext = {
    dialogs: options.dialogs,
    database,
    exists,
    readId,
    drives,
    prepare: options.workspaceInit ?? initWorkspace,
    log: options.onEvent ?? ((): void => {}),
    portableRoot: null,
  };

  const config = readConfig();
  const recordedPath = config?.workspacePath?.trim() || null;
  const recordedExists = Boolean(recordedPath && exists(recordedPath));

  // 兼容 0.0.25 留下的首启标记：即使盘符变了也先清掉，避免自愈后又落回空 token 表单。
  if (config?.portableSetupPending) {
    updateConfig({ portableSetupPending: false });
  }

  let portableRoot: string | null = null;
  if (recordedExists) {
    // 记录的位置还在 ⇒ 判定必然停在第一分支（`configured`），盘列表用不上。
    // 先按**纯文件检查**认一下（交付夹形状 / 盘根 marker，都不枚举盘）—— 只为让 `portable`
    // 和"默认位置"在常态启动下也是对的（日志要说真话、设置页要显示盘上那份）。
    const detection = detectPortableRun({
      exePath: options.exePath,
      resourcesPath: options.resourcesPath,
      removableDrives: [],
      exists,
    });
    if (detection.portable) {
      portableRoot = detection.volumeRoot;
    } else {
      // 纯文件检查没认出来时**才**值得花一次枚举（PowerShell，秒级）：
      // 盘根没放运行时的盘（用户自己挑目录的普通 U 盘）只有 DriveType=2 这一条判据。
      // 少了这一步，"第二次启动竟然说 not portable"会让日志和 T-U2 的判据一起说谎。
      const withDrives = detectPortableRun({
        exePath: options.exePath,
        resourcesPath: options.resourcesPath,
        removableDrives: drives(),
        exists,
      });
      portableRoot = withDrives.portable ? withDrives.volumeRoot : null;
      ctx.log('workspace.portable.detected', {
        portable: withDrives.portable,
        reason: withDrives.reason,
      });
    }
  } else {
    const detection = detectPortableRun({
      exePath: options.exePath,
      resourcesPath: options.resourcesPath,
      removableDrives: drives(),
      exists,
    });
    portableRoot = detection.portable ? detection.volumeRoot : null;
    ctx.log('workspace.portable.detected', { portable: detection.portable, reason: detection.reason });
  }
  // 必须在任何 `getDefaultWorkspacePath()` / IPC 之前灌进去：渲染进程要靠它
  // 把"默认工作区"显示成盘上那份（用户不用选盘）。
  setPortableWorkspaceRoot(portableRoot);
  ctx.portableRoot = portableRoot;

  const decision = decideWorkspaceStartup({
    recordedPath,
    recordedRelPath: config?.workspaceRelPath,
    volumeMarker: config?.volumeMarker,
    workspaceBinding: config?.workspaceBinding,
    workspaceId: config?.workspaceId,
    readWorkspaceId: readId,
    portableRoot,
    defaultPath: getHomedirWorkspacePath(),
    // ⚠️ 记录的位置还在 ⇒ 判定必然停在第一分支（`configured`），压根不会读这个列表，
    //    传空数组是为了**不枚举** —— 枚举是一次 PowerShell 调用，在启动路径上。
    //    （上面那次「marker 没认出来才枚举」已经把结果记进 `drives()` 的惰性缓存，
    //    所以这里是"要么不枚举、要么用同一份"，不会重复开进程。）
    removableDrives: recordedExists ? [] : drives(),
    exists,
  });
  ctx.log('workspace.startup.decision', { kind: decision.kind });

  // 只记"重建过"这一条（渲染层做非阻断告知；其余 kind 见 startup-notice.ts 的边界）。
  recordWorkspaceStartupDecision(decision);

  let workspacePath: string;
  switch (decision.kind) {
    case 'configured': {
      workspacePath = decision.path;
      /**
       * 身份补铸（P-A v2 → R8-03 收窄）：**仅当配置本身没有 id** 才补铸 ——
       * 老记录（1.0.6 时代）正常启动一次即升级成"身份可核证"的记录，之后的
       * 换机/换盘符走身份路径。配置已有 id 时绝不补铸/覆盖（决定了 configured
       * 就意味着 marker id 已核到严格相等，R8-03 的冲突路径在判定层已转 ask-user，
       * 不允许"先写后报"把冲突证据抹掉）。尽力而为、绝不抛。
       */
      if (!config?.workspaceId) {
        try {
          // 走注入端口：`prepare` = 建目录 + 写/补铸标记（默认真 `initWorkspace`），
          // `readId` = 读回身份。与 `ensureWorkspaceId()` 等价，但不再绕过测试的虚拟盘。
          await ctx.prepare(decision.path);
          const id = ctx.readId(decision.path);
          if (id) updateConfig({ workspaceId: id });
        } catch (err) {
          ctx.log('workspace.identity.backfill.failed', {
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      break;
    }
    case 'default':
      workspacePath = decision.path;
      break;

    case 'recreated':
      await ensureWorkspace(ctx, decision.path);
      workspacePath = decision.path;
      break;

    case 'healed': {
      // ⚠️ 静默自愈：只有"唯一命中"才走这里（多命中/零命中在 portable.ts 里就被拦下了）
      if (await ensureWorkspace(ctx, decision.path)) {
        // 自愈=把盘上工作区找回来 ⇒ 归属记 app-volume（B1）
        updateConfig({ workspacePath: decision.path, ...locationOf(ctx, decision.path, 'app-volume') });
        ctx.log('workspace.healed', { from: decision.from, to: decision.path, evidence: decision.via.evidence });
      }
      workspacePath = decision.path;
      break;
    }

    case 'auto-portable': {
      if (await ensureWorkspace(ctx, decision.path)) {
        updateConfig({
          workspacePath: decision.path,
          ...locationOf(ctx, decision.path, 'app-volume'),
          portableSetupPending: false,
        });
        ctx.log('workspace.portable.auto', { path: decision.path });
      }
      workspacePath = decision.path;
      break;
    }

    case 'ask-user': {
      const resolved = await resolveMissingWorkspace(decision, ctx);
      if (resolved === 'quit') return userChoseQuit();
      workspacePath = resolved;
      break;
    }
  }

  const opened = await openWorkspaceDatabase(workspacePath, ctx);
  if (opened === 'quit') return userChoseQuit();

  return { kind: 'ready', path: opened, portable: Boolean(portableRoot), decision };
}

function locationOf(
  ctx: StartupContext,
  workspacePath: string,
  binding: 'app-volume' | 'explicit-path',
): {
  workspaceRelPath?: string;
  volumeMarker?: string;
  workspaceBinding?: 'app-volume' | 'explicit-path';
  workspaceId?: string;
} {
  return workspaceLocationPatch({
    workspacePath,
    removableDrives: ctx.drives(),
    exists: ctx.exists,
    runVolumeRoot: ctx.portableRoot,
    binding,
    // 身份（P-A v2）：所有"确认写入"的路径都先过 ensureWorkspace（标记已补铸），
    // 这里读出来随线索一起写进配置。
    workspaceId: ctx.readId(workspacePath),
  });
}

/**
 * 用户**手选**目录（browse / 最后一问）的归属（2026-10-15 首次启动硬合同 P-A）。
 *
 * 选在**当前运行卷**上的目录 ⇒ `app-volume` 同族（换盘符后同盘自愈、不再问人）；
 * 别的卷 / 本机安装形态 ⇒ `explicit-path`（真外部目录，保护不变）。
 * 判据在 `portable.ts` 的 `bindingForPickedDirectory`（单点，与 workspace:setup/change 共用）。
 */
function pickedBindingOf(ctx: StartupContext, pickedPath: string): 'app-volume' | 'explicit-path' {
  return bindingForPickedDirectory(pickedPath, ctx.portableRoot);
}

/**
 * 建目录 + 放工作区标记（失败不抛：让 `initDatabase` 的错误统一走三选一对话框）。
 *
 * 返回值 = "这个位置真的能写"。写不进去时**不要**把配置改到这儿来 ——
 * 那会把用户的下一次启动也带进沟里。
 */
async function ensureWorkspace(ctx: StartupContext, workspacePath: string): Promise<boolean> {
  try {
    await ctx.prepare(workspacePath);
    return true;
  } catch (err) {
    ctx.log('workspace.prepare.mkdir.failed', {
      workspacePath,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * 记录的位置找不回来：让用户选。**任何一条路都不退出**，除非他自己点了「退出」。
 */
async function resolveMissingWorkspace(
  decision: Extract<WorkspaceStartupDecision, { kind: 'ask-user' }>,
  ctx: StartupContext,
): Promise<string | 'quit'> {
  const fallbackPath = getHomedirWorkspacePath();
  let recorded = decision.recordedPath;

  for (let round = 0; round < MAX_RECOVERY_ROUNDS; round += 1) {
    const choice = await ctx.dialogs.askForMissingWorkspace({
      recordedPath: recorded,
      candidates: decision.candidates.map((candidate) => candidate.path),
    });

    if (choice.kind === 'quit') {
      ctx.log('workspace.missing.quit');
      return 'quit';
    }

    if (choice.kind === 'use') {
      if (await ensureWorkspace(ctx, choice.path)) {
        /**
         * 归属（R1，2026-10-10 集中终审 §3）：确认写入必须与「实际选中的位置」一致 ——
         * 只有**当前运行卷上**的候选才算"跟着盘走"（app-volume）；用户确认的是别的卷
         * 上的精确位置 ⇒ explicit-path。旧行为把任何选中的候选都记成 app-volume：
         * 选完旧卷上的目录，下次启动又会因"记录卷 ≠ 运行卷"再问一遍，且归属是假话。
         * （2026-10-15 P-A 起与手选目录共用同一条判据 `bindingForPickedDirectory`。）
         */
        const binding = pickedBindingOf(ctx, choice.path);
        updateConfig({
          workspacePath: choice.path,
          ...locationOf(ctx, choice.path, binding),
        });
        ctx.log('workspace.missing.picked', { path: choice.path, binding });
        return choice.path;
      }
      recorded = choice.path;
      continue;
    }

    if (choice.kind === 'browse') {
      const picked = await ctx.dialogs.browseForDirectory(recorded);
      if (!picked) continue; // 取消了就再问一次（对话框里始终有「退出」）
      if (await ensureWorkspace(ctx, picked)) {
        /**
         * 用户手选目录（2026-10-15 首次启动硬合同 P-A）：选在**当前运行卷**上 ⇒ 随盘
         * 语义（app-volume，换盘符后同盘自愈）；别的卷 ⇒ explicit-path（B1：显式选择
         * 遵从用户）。旧行为一律 explicit-path ⇒ 同一支盘换台电脑/换个盘符就被要求重选。
         */
        const binding = pickedBindingOf(ctx, picked);
        updateConfig({ workspacePath: picked, ...locationOf(ctx, picked, binding) });
        ctx.log('workspace.missing.browsed', { path: picked, binding });
        return picked;
      }
      recorded = picked;
      continue;
    }

    // 新建工作区：原位置那个盘还在就还在原位置（等价于旧行为），否则退到默认位置
    const volumeRoot = volumeRootOf(recorded);
    const onOriginalVolume = Boolean(volumeRoot && ctx.exists(volumeRoot));
    const target = onOriginalVolume ? recorded : fallbackPath;
    if (await ensureWorkspace(ctx, target)) {
      // 归属（B1/R1）：原位置重建保持记录里原有的 explicit 归属；没有旧归属时按
      // "目标位置在**当前运行卷**上 ⇒ app-volume / 其他 ⇒ explicit"推断。
      // ⚠️ R1：不再按"原卷还在"推 app-volume —— 程序跑在 F、目标落在旧 E 时，
      //    那条 app-volume 会与"记录卷 ≠ 运行卷"的判定打架，每次启动重复询问。
      const oldBinding = readConfig()?.workspaceBinding ?? null;
      const binding =
        oldBinding === 'explicit-path'
          ? 'explicit-path'
          : sameVolumeRoot(volumeRootOf(target), ctx.portableRoot)
            ? 'app-volume'
            : 'explicit-path';
      updateConfig({ workspacePath: target, ...locationOf(ctx, target, binding) });
      ctx.log('workspace.missing.created', { path: target, binding });
      return target;
    }
    recorded = target;
  }

  // ⚠️ 最后一问：重试上限是给"空转"设的，不是给"用户还想试"设的 ——
  //    最后一轮仍要留一个「选择其它目录」的出口，只有真的选不出来才退出。
  const rescued = await lastChanceDirectory(ctx, recorded);
  if (rescued) {
    // 最后一问同样是用户手选目录 ⇒ 同一条归属判据（P-A：同盘随盘、别卷显式）
    const binding = pickedBindingOf(ctx, rescued);
    updateConfig({ workspacePath: rescued, ...locationOf(ctx, rescued, binding) });
    ctx.log('workspace.missing.last-chance', { path: rescued, binding });
    return rescued;
  }

  ctx.log('workspace.missing.give-up');
  await ctx.dialogs.notifyFatal?.({
    title: '打不开工作区',
    message: '试了几次都没能建好工作区。',
    detail: '请检查磁盘是否可写、或换一个本地目录后重开。\n此窗口关闭后程序会退出。',
  });
  return 'quit';
}

/**
 * 打开数据库。失败 ⇒ 「选择其它目录 / 重建工作区 / 退出」三选一，**绝不静默退出**。
 */
async function openWorkspaceDatabase(initialPath: string, ctx: StartupContext): Promise<string | 'quit'> {
  let workspacePath = initialPath;

  for (let round = 0; round < MAX_RECOVERY_ROUNDS; round += 1) {
    const failure = tryOpen(workspacePath, ctx.database);
    if (!failure) {
      ctx.log('db.init.ok', { workspacePath });
      return workspacePath;
    }
    ctx.log('db.init.failed', { workspacePath, message: failure });

    const choice = await ctx.dialogs.askForUnusableWorkspace({ workspacePath, message: failure });

    if (choice === 'quit') {
      ctx.log('workspace.db.quit', { workspacePath });
      return 'quit';
    }

    if (choice === 'rebuild') {
      // ⚠️ 顺序是**硬要求**：先放句柄、再改名。
      //    还开着这个文件时 Windows 上的 rename 必 EBUSY（共享模式不含 FILE_SHARE_DELETE），
      //    改名失败 ⇒ 下一轮 init 还是同一个坏文件 ⇒ 转满 5 轮退出。
      //    （`init` 自己失败时也该把句柄放掉，见 `db/index.ts` 的 openDatabaseAt —— 两道都要有，
      //      因为"库为什么打不开"不止一种：坏文件、路径被占、权限。）
      ctx.database.close();
      const quarantined = quarantineDatabaseFiles(workspacePath, ctx.log);
      if (!(await ensureWorkspace(ctx, workspacePath))) continue;
      ctx.log('workspace.db.rebuild', { workspacePath, quarantined });
      continue; // 下一轮重试同一个位置
    }

    const picked = await ctx.dialogs.browseForDirectory(workspacePath);
    if (!picked) continue;
    if (await ensureWorkspace(ctx, picked)) {
      // 用户手选目录 ⇒ 同一条归属判据（P-A：同盘随盘、别卷显式）
      const binding = pickedBindingOf(ctx, picked);
      updateConfig({ workspacePath: picked, ...locationOf(ctx, picked, binding) });
    }
    workspacePath = picked;
  }

  // ⚠️ 最后一问：重试上限是给"空转"设的，不是给"用户还想试"设的。
  //    所以最后仍留一个「选择其它目录」的出口 —— 只有真的选不出来才退出。
  const rescued = await lastChanceDirectory(ctx, workspacePath);
  if (rescued) {
    const failure = tryOpen(rescued, ctx.database);
    if (!failure) {
      // 最后一问同样是用户手选目录 ⇒ 同一条归属判据（P-A：同盘随盘、别卷显式）
      const binding = pickedBindingOf(ctx, rescued);
      updateConfig({ workspacePath: rescued, ...locationOf(ctx, rescued, binding) });
      ctx.log('workspace.db.last-chance', { workspacePath: rescued, binding });
      return rescued;
    }
    ctx.log('workspace.db.last-chance.failed', { workspacePath: rescued, message: failure });
  }

  ctx.log('workspace.db.give-up', { workspacePath });
  await ctx.dialogs.notifyFatal?.({
    title: '打不开工作区',
    message: `工作区里的数据库打不开：\n${workspacePath}`,
    detail: '请检查磁盘是否可写、或换一个本地目录后重开。\n此窗口关闭后程序会退出。',
  });
  return 'quit';
}

/**
 * 「最后一次机会」：给用户一个**只选目录**的出口（不是"重建"、也不是"退出"）。
 *
 * 返回一个真的建好了的目录；用户取消或建不出来时返回 null（调用方接着走收尾）。
 */
async function lastChanceDirectory(ctx: StartupContext, defaultPath: string): Promise<string | null> {
  const picked = await ctx.dialogs.browseForDirectory(defaultPath);
  if (!picked || picked === defaultPath) return null;
  if (!(await ensureWorkspace(ctx, picked))) return null;
  return picked;
}

function tryOpen(workspacePath: string, database: WorkspaceDatabasePort): string | null {
  try {
    database.init(workspacePath);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * 「重建工作区」：把打不开的数据库文件**改名**挪到一边（`.corrupt-<时间戳>`），
 * 下次 init 会建一份新的。⚠️ 只动数据库文件，**不碰**工作区里的其它数据。
 */
export function quarantineDatabaseFiles(workspacePath: string, log: EventLog = (): void => {}): string[] {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const moved: string[] = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const source = join(workspacePath, `${DB_FILE_NAME}${suffix}`);
    if (!existsSync(source)) continue;
    const target = join(workspacePath, `${DB_FILE_NAME}${suffix}.corrupt-${stamp}`);
    try {
      renameSync(source, target);
      moved.push(target);
    } catch (err) {
      log('workspace.db.quarantine.failed', {
        source,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return moved;
}
