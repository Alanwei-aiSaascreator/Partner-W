/**
 * 盘符自愈的**判定顺序**（T-U1 核心）。
 *
 * 用户的原话是「换机器/换盘符也不许打不开」。四种情形必须都测到：
 * 唯一命中（静默自愈）、多命中（让用户选，**不许猜**）、零命中（问）、盘符改变。
 *
 * ⚠️ 本机插不了 U 盘、也没法在单测里改盘符 ⇒ 盘列表与文件系统全部注入。
 * ⚠️ 判定顺序是本模块的**契约**：`configured → healed → ask-user → recreated →
 *    auto-portable → default`。改动顺序 = 改这份测试。
 */

import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceHealCandidates,
  decideWorkspaceStartup,
  resolveWorkspaceRelative,
  workspaceLocationPatch,
  type WorkspaceHealCandidate,
} from '../src/main/workspace/portable.js';

const WIN = path.win32;
const MANIFEST = 'openclaw-runtime-manifest.json';
const WS_NAME = '荣盈魔方工作区';
const WORKSPACE_MARKER = '.clawwork-workspace.json';

const PORTABLE_WS = WIN.join('E:\\', WS_NAME);

const paths = (...items: string[]): Set<string> => new Set(items.map((p) => WIN.normalize(p).toLowerCase()));
function vfs(...items: string[]): (p: string) => boolean {
  const set = paths(...items);
  return (p) => set.has(WIN.normalize(p).toLowerCase());
}
const candidatePaths = (list: readonly WorkspaceHealCandidate[]): string[] => list.map((c) => c.path);

describe('buildWorkspaceHealCandidates —— 候选顺序即优先级', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('盘符没变、只是同一盘上按相对路径还能找到 ⇒ same-letter（排在扫盘之前）', () => {
    // ⚠️ 记录里的两个字段是**独立**的配置项（`workspacePath` / `workspaceRelPath`），
    //    可能不同步（手动改过配置、或上一次记的是另一个盘符）。这条 pin 的是**优先级**：
    //    同盘符候选必须排在扫盘前面；⚠️ #6 之后**同盘符也要 marker 佐证**（见 portable.ts
    //    的注释：盘符是插拔时随手分配的，"同盘符"不等于"同一块盘"）。这里的 vfs 给了盘根
    //    marker，所以证据是 `volume-marker`。
    const candidates = buildWorkspaceHealCandidates({
      recordedPath: WIN.join('F:\\', '旧位置', WS_NAME),
      relPath: WIN.join('新位置', WS_NAME),
      removableDrives: ['F:'],
      exists: vfs(WIN.join('F:\\', '新位置', WS_NAME), WIN.join('F:\\', MANIFEST)),
    });

    expect(candidates).toEqual([
      { path: WIN.join('F:\\', '新位置', WS_NAME), origin: 'same-letter', evidence: 'volume-marker' },
    ]);
  });

  it('⭐ 盘符改变：同一个盘换了盘符，扫可移动盘按相对路径找回来', () => {
    const candidates = buildWorkspaceHealCandidates({
      recordedPath: PORTABLE_WS, // 记录的是 E:\荣盈魔方工作区
      relPath: WS_NAME,
      removableDrives: ['F:'], // 现在盘符是 F:
      exists: vfs(WIN.join('F:\\', WS_NAME), WIN.join('F:\\', MANIFEST)),
    });

    expect(candidates).toEqual([
      { path: WIN.join('F:\\', WS_NAME), origin: 'removable-scan', evidence: 'volume-marker' },
    ]);
  });

  it('扫盘必须有佐证：目录同名但没有盘根 marker / 工作区 marker ⇒ 不算命中', () => {
    // 别人的 U 盘里正好有个同名目录 —— 认了就是把用户带到别人的数据上。
    expect(
      buildWorkspaceHealCandidates({
        recordedPath: PORTABLE_WS,
        relPath: WS_NAME,
        removableDrives: ['F:'],
        exists: vfs(WIN.join('F:\\', WS_NAME)),
      }),
    ).toEqual([]);
  });

  it('工作区自身标记也能作数（盘根没放运行时的普通 U 盘）', () => {
    const candidates = buildWorkspaceHealCandidates({
      recordedPath: PORTABLE_WS,
      relPath: WS_NAME,
      removableDrives: ['F:'],
      exists: vfs(WIN.join('F:\\', WS_NAME), WIN.join('F:\\', WS_NAME, WORKSPACE_MARKER)),
    });

    expect(candidates).toEqual([
      { path: WIN.join('F:\\', WS_NAME), origin: 'removable-scan', evidence: 'workspace-marker' },
    ]);
  });

  it('⚠️ 同一条路径只算一次（否则"唯一命中"会被数成"多命中"，静默自愈变成弹框）', () => {
    // relPath 指向的路径与"同盘符 + relPath"是同一个 ⇒ 去重后必须只剩一个候选。
    const candidates = buildWorkspaceHealCandidates({
      recordedPath: WIN.join('E:\\', '旧位置', WS_NAME),
      relPath: WIN.join('新位置', WS_NAME),
      removableDrives: ['E:', 'F:'],
      exists: vfs(WIN.join('E:\\', '新位置', WS_NAME), WIN.join('E:\\', MANIFEST)),
    });

    expect(candidatePaths(candidates)).toEqual([WIN.join('E:\\', '新位置', WS_NAME)]);
  });

  it('⭐ 跑在盘上、但盘列表为空（报成固定盘的 U 盘 / 枚举失败）：按"自己在的那块盘"找回', () => {
    // 现场复现（2026-09-18 实测）：Windows 把盘报成固定盘 ⇒ removableDrives 为空；
    // 记录里的 Z: 又不存在 ⇒ 两条老判据全落空，只能弹「找不到工作区」。
    // 而应用**正跑在 F: 盘上**，盘根有 marker、工作区也在那儿 —— 这条必须命中。
    const candidates = buildWorkspaceHealCandidates({
      recordedPath: WIN.join('Z:\\', WS_NAME),
      relPath: WS_NAME,
      removableDrives: [], // 关键：枚举不出可移动盘
      runVolumeRoot: 'F:\\', // 应用自己所在的卷
      exists: vfs(WIN.join('F:\\', WS_NAME), WIN.join('F:\\', MANIFEST)),
    });

    expect(candidates).toEqual([{ path: WIN.join('F:\\', WS_NAME), origin: 'run-volume', evidence: 'volume-marker' }]);
  });

  it('"自己在的盘"同样要证据：目录同名但没有 marker ⇒ 不认', () => {
    expect(
      buildWorkspaceHealCandidates({
        recordedPath: WIN.join('Z:\\', WS_NAME),
        relPath: WS_NAME,
        removableDrives: [],
        runVolumeRoot: 'F:\\',
        exists: vfs(WIN.join('F:\\', WS_NAME)),
      }),
    ).toEqual([]);
  });

  it('同一条路径只算一次：它在的盘 == 记录里那个盘时，不会数成"多命中"', () => {
    const candidates = buildWorkspaceHealCandidates({
      recordedPath: WIN.join('F:\\', '旧位置', WS_NAME),
      relPath: WS_NAME,
      removableDrives: [],
      runVolumeRoot: 'F:\\',
      exists: vfs(WIN.join('F:\\', WS_NAME), WIN.join('F:\\', MANIFEST)),
    });

    expect(candidates).toEqual([{ path: WIN.join('F:\\', WS_NAME), origin: 'same-letter', evidence: 'volume-marker' }]);
  });

  it('⭐⭐ 判定层：固定盘 + 盘符变了 ⇒ 静默自愈（不弹框，正是实机那次该有的行为）', () => {
    const decision = decideWorkspaceStartup({
      recordedPath: WIN.join('Z:\\', WS_NAME),
      recordedRelPath: WS_NAME,
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\', // 应用跑在 F:（盘上运行判定给的卷根）
      defaultPath: WIN.join('C:\\', 'Users', 'u', 'ClawWork-Workspace'),
      removableDrives: [],
      exists: vfs(WIN.join('F:\\', WS_NAME), WIN.join('F:\\', MANIFEST)),
    });

    expect(decision).toEqual({
      kind: 'healed',
      path: WIN.join('F:\\', WS_NAME),
      from: WIN.join('Z:\\', WS_NAME),
      via: { path: WIN.join('F:\\', WS_NAME), origin: 'run-volume', evidence: 'volume-marker' },
    });
  });

  /**
   * ⭐ 老配置没记 `workspaceRelPath` 时的退路（2026-09-20 外部审计实机撞到的那条）。
   *
   * 现场：机器上留着**更老版本**写的配置（`workspacePath` 指向一块已经不存在的盘、
   * **没有** `workspaceRelPath`），U 盘插上去盘符也变了。盘上明明躺着
   * `E:\荣盈魔方工作区\.clawwork-workspace.json`（我们自己写的标记），
   * 但 `!rel ⇒ return []` 让自愈一个候选都给不出来 ⇒ 弹框让用户手选 ——
   * 用户随手建个空目录，看到的就是"历史数据没了"。
   *
   * 退路**必须窄**：只找**我们自己的默认目录名**（`荣盈魔方工作区`，是个常量，
   * 不是从 `C:\Users\…` 反推出来的结构），且**必须有工作区标记**作证。
   * 这仍然是"找"，不是"猜"（下面那条测试守的就是"别反推路径"）。
   */
  it('⭐ 没记相对路径（老配置）+ 盘根默认目录带工作区标记 ⇒ 仍然命中', () => {
    const list = buildWorkspaceHealCandidates({
      recordedPath: WIN.join('G:\\', 'runtime', 'workspace'),
      relPath: null,
      runVolumeRoot: 'E:\\',
      removableDrives: ['E:'],
      // ⚠️ 目录**本身**也要放进 vfs —— 真实文件系统里"标记文件在"蕴含"目录在"，
      //    但这里的 `exists` 是个集合查询，不蕴含任何东西（第一版就栽在这）。
      exists: vfs(PORTABLE_WS, WIN.join(PORTABLE_WS, WORKSPACE_MARKER)),
    });

    expect(candidatePaths(list)).toEqual([PORTABLE_WS]);
    expect(list[0]).toEqual({ path: PORTABLE_WS, origin: 'run-volume', evidence: 'workspace-marker' });
  });

  it('⚠️ 退路同样要证据：默认目录名对了、但没有工作区标记 ⇒ 不认', () => {
    expect(
      buildWorkspaceHealCandidates({
        recordedPath: WIN.join('G:\\', 'runtime', 'workspace'),
        relPath: null,
        runVolumeRoot: 'E:\\',
        removableDrives: ['E:'],
        // 目录在（`exists` 对它是 true）但没有 `.clawwork-workspace.json` ⇒ 不算
        exists: vfs(PORTABLE_WS, WIN.join('E:\\', MANIFEST)),
      }),
    ).toEqual([]);
  });

  it('没记相对路径 ⇒ 一个候选都不给（拿 C:\\Users\\… 反推出来的路径去扫盘是"猜"）', () => {
    expect(
      buildWorkspaceHealCandidates({
        recordedPath: WIN.join('C:\\', 'Users', 'u', 'ClawWork-Workspace'),
        relPath: null,
        removableDrives: ['E:'],
        exists: vfs(WIN.join('E:\\', 'Users', 'u', 'ClawWork-Workspace'), WIN.join('E:\\', MANIFEST)),
      }),
    ).toEqual([]);
  });
});

describe('decideWorkspaceStartup —— 启动时用哪个工作区', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const DEFAULT_PATH = WIN.join('C:\\', 'Users', 'u', 'ClawWork-Workspace');
  const base = { defaultPath: DEFAULT_PATH };

  it('① 记录的位置还在 ⇒ configured（什么都不做）', () => {
    expect(
      decideWorkspaceStartup({
        ...base,
        recordedPath: PORTABLE_WS,
        recordedRelPath: WS_NAME,
        removableDrives: ['E:'],
        exists: vfs(PORTABLE_WS),
      }),
    ).toEqual({ kind: 'configured', path: PORTABLE_WS });
  });

  it('② 唯一命中 ⇒ healed（静默改配置，不弹框）', () => {
    const decision = decideWorkspaceStartup({
      ...base,
      recordedPath: PORTABLE_WS,
      recordedRelPath: WS_NAME,
      removableDrives: ['F:'],
      exists: vfs(WIN.join('F:\\', WS_NAME), WIN.join('F:\\', MANIFEST)),
    });

    expect(decision.kind).toBe('healed');
    if (decision.kind !== 'healed') throw new Error('unreachable');
    expect(decision.path).toBe(WIN.join('F:\\', WS_NAME));
    expect(decision.from).toBe(PORTABLE_WS);
    expect(decision.via.evidence).toBe('volume-marker');
  });

  it('③ 多命中 ⇒ ask-user，且把候选**全部**列出来（绝不替用户选）', () => {
    // 原盘（E:）不在，但另外两个盘里都有同一份工作区（用户复制过盘 / 有备份盘）
    // ⇒ 谁也不敢替用户决定用哪份，必须把两个候选都摆出来。
    const decision = decideWorkspaceStartup({
      ...base,
      recordedPath: PORTABLE_WS,
      recordedRelPath: WS_NAME,
      removableDrives: ['F:', 'G:'],
      exists: vfs(
        WIN.join('F:\\', MANIFEST),
        WIN.join('G:\\', MANIFEST),
        WIN.join('F:\\', WS_NAME),
        WIN.join('G:\\', WS_NAME),
      ),
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates).sort()).toEqual(
      [WIN.join('F:\\', WS_NAME), WIN.join('G:\\', WS_NAME)].sort(),
    );
    expect(decision.recordedPath).toBe(PORTABLE_WS);
  });

  it('④ 零命中 + 记过相对路径（盘没插）⇒ ask-user（不许在本机随便造一份空工作区）', () => {
    const decision = decideWorkspaceStartup({
      ...base,
      recordedPath: PORTABLE_WS,
      recordedRelPath: WS_NAME,
      removableDrives: [],
      exists: vfs(), // 盘不在，E:\ 本身也不在
    });

    expect(decision).toEqual({ kind: 'ask-user', recordedPath: PORTABLE_WS, candidates: [] });
  });

  it('⑤ 零命中 + 本机目录被删（卷还在）⇒ recreated（就地重建，与旧行为一致）', () => {
    expect(
      decideWorkspaceStartup({
        ...base,
        recordedPath: DEFAULT_PATH,
        recordedRelPath: null,
        removableDrives: ['E:'],
        exists: vfs('C:\\', WIN.join('C:\\', 'Windows')), // C: 在，工作区目录没了
      }),
    ).toEqual({ kind: 'recreated', path: DEFAULT_PATH });
  });

  it('⑥ 零命中 + 卷整个不见了（没有相对路径线索）⇒ ask-user，不是 recreated', () => {
    expect(
      decideWorkspaceStartup({
        ...base,
        recordedPath: WIN.join('E:\\', 'ClawWork-Workspace'),
        recordedRelPath: null,
        removableDrives: [],
        exists: vfs(WIN.join('C:\\', 'Windows')), // E: 不在
      }).kind,
    ).toBe('ask-user');
  });

  it('⭐ 首启 + 盘上运行 ⇒ auto-portable（`<盘根>\\荣盈魔方工作区`，不弹选择框）', () => {
    expect(
      decideWorkspaceStartup({
        ...base,
        recordedPath: null,
        portableRoot: 'E:\\',
        removableDrives: ['E:'],
        exists: vfs(WIN.join('E:\\', MANIFEST)),
      }),
    ).toEqual({ kind: 'auto-portable', path: PORTABLE_WS, volumeRoot: 'E:\\' });
  });

  it('首启 + 非盘上 ⇒ default（Setup 里仍可改）', () => {
    expect(
      decideWorkspaceStartup({
        ...base,
        recordedPath: null,
        portableRoot: null,
        removableDrives: [],
        exists: vfs(),
      }),
    ).toEqual({ kind: 'default', path: DEFAULT_PATH });
  });

  it('盘上运行但**已经有记录**时，不能被 auto-portable 抢走（记录优先）', () => {
    const decision = decideWorkspaceStartup({
      ...base,
      recordedPath: WIN.join('C:\\', 'my-ws'),
      portableRoot: 'E:\\',
      removableDrives: ['E:'],
      exists: vfs(WIN.join('C:\\', 'my-ws')),
    });

    expect(decision).toEqual({ kind: 'configured', path: WIN.join('C:\\', 'my-ws') });
  });

  // ——— B1（2026-10 基线审查 P1）：旧盘符上存在同名目录时，不许静默开旧工作区 ———
  // 记录是盘上自动工作区（app-volume 语义），程序已经跑在 F 盘上。旧 E 上的同名
  // 目录**还在**——`exists(recorded)` 只能证明"那个路径有东西"，不能证明"它属于
  // 当前这块盘"。旧行为直接 configured(E)：启动成功但显示别处历史、往错误工作区写。

  it('⭐ B1: 程序在 F 盘运行、旧 E 同名目录仍在且无证据 ⇒ 不静默开 E，自愈到 F', () => {
    const decision = decideWorkspaceStartup({
      ...base,
      recordedPath: PORTABLE_WS, // E:\荣盈魔方工作区（旧盘符）
      recordedRelPath: WS_NAME,
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\', // 程序这次跑在 F:
      removableDrives: ['F:'],
      exists: vfs(
        PORTABLE_WS, // 旧 E 的同名目录"仍然存在"（无 marker、无工作区标记）
        WIN.join('F:\\', WS_NAME),
        WIN.join('F:\\', MANIFEST),
      ),
    });

    expect(decision.kind).toBe('healed');
    if (decision.kind !== 'healed') throw new Error('unreachable');
    expect(decision.path).toBe(WIN.join('F:\\', WS_NAME));
    expect(decision.from).toBe(PORTABLE_WS);
  });

  it('⭐ B1: 旧 E 的同名目录带工作区标记（两卷都命中）⇒ ask-user，绝不猜', () => {
    const decision = decideWorkspaceStartup({
      ...base,
      recordedPath: PORTABLE_WS,
      recordedRelPath: WS_NAME,
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(
        PORTABLE_WS,
        WIN.join(PORTABLE_WS, WORKSPACE_MARKER), // E 那份有我们自己的工作区标记
        WIN.join('F:\\', WS_NAME),
        WIN.join('F:\\', MANIFEST),
      ),
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    // 两个候选都要摆给用户，不许替用户选
    expect(candidatePaths(decision.candidates).sort()).toEqual([PORTABLE_WS, WIN.join('F:\\', WS_NAME)].sort());
  });

  it('⭐ B1: binding=explicit-path 的外部工作区仍在 ⇒ 遵从用户选择（configured）', () => {
    expect(
      decideWorkspaceStartup({
        ...base,
        recordedPath: WIN.join('D:\\', 'someone', 'ws'),
        recordedRelPath: null,
        workspaceBinding: 'explicit-path',
        portableRoot: 'F:\\',
        removableDrives: ['F:'],
        exists: vfs(WIN.join('D:\\', 'someone', 'ws')),
      }),
    ).toEqual({ kind: 'configured', path: WIN.join('D:\\', 'someone', 'ws') });
  });

  it('⭐ B1: app-volume 记录仍属当前运行卷 ⇒ configured（正常盘上重启不误伤）', () => {
    expect(
      decideWorkspaceStartup({
        ...base,
        recordedPath: WIN.join('F:\\', WS_NAME),
        recordedRelPath: WS_NAME,
        workspaceBinding: 'app-volume',
        portableRoot: 'F:\\',
        removableDrives: ['F:'],
        exists: vfs(WIN.join('F:\\', WS_NAME)),
      }),
    ).toEqual({ kind: 'configured', path: WIN.join('F:\\', WS_NAME) });
  });
});

describe('workspaceLocationPatch —— B1 归属记账', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('盘上自动工作区（记线索）⇒ 一并记 app-volume', () => {
    expect(
      workspaceLocationPatch({
        workspacePath: WIN.join('E:\\', WS_NAME),
        removableDrives: ['E:'],
        exists: vfs(WIN.join('E:\\', MANIFEST)),
        binding: 'app-volume',
      }),
    ).toEqual({ workspaceRelPath: WS_NAME, volumeMarker: MANIFEST, workspaceBinding: 'app-volume' });
  });

  it('用户显式选在可移动盘上 ⇒ 迁移线索照记、归属记为 explicit-path', () => {
    const patch = workspaceLocationPatch({
      workspacePath: WIN.join('E:\\', '我的资料'),
      removableDrives: ['E:'],
      exists: vfs(WIN.join('E:\\', MANIFEST)),
      binding: 'explicit-path',
    });
    expect(patch.workspaceRelPath).toBe('我的资料');
    expect(patch.workspaceBinding).toBe('explicit-path');
  });

  it('非盘上工作区 ⇒ 全部线索（含归属）显式清掉，老行为不变', () => {
    expect(
      workspaceLocationPatch({
        workspacePath: WIN.join('C:\\', 'Users', 'u', 'ClawWork-Workspace'),
        removableDrives: [],
        exists: vfs(),
        binding: 'app-volume',
      }),
    ).toEqual({ workspaceRelPath: undefined, volumeMarker: undefined, workspaceBinding: undefined });
  });
});

/**
 * R1（2026-10-10 集中终审 §3）：归属与路径线索的边界 —— 与主审裁判同构的正式回归。
 *
 * 三条反例走真实判定入口（decideWorkspaceStartup / buildWorkspaceHealCandidates / resolveWorkspaceRelative），
 * 三条控制保持既有合同（运行卷唯一候选仍静默自愈、双命中仍询问、同卷有效路径不被坏线索改指）。
 */
describe('R1 —— 归属与路径线索边界（集中终审）', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const R1_BASE = { defaultPath: WIN.join('C:\\', 'Users', 'u', 'ClawWork-Workspace') };
  const F_WS = WIN.join('F:\\', WS_NAME);

  it('⭐ R1-① app-volume：旧卷唯一候选（带工作区标记）不得静默胜出 ⇒ ask-user 摆给用户', () => {
    const decision = decideWorkspaceStartup({
      ...R1_BASE,
      recordedPath: PORTABLE_WS,
      recordedRelPath: WS_NAME,
      workspaceBinding: 'app-volume',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(PORTABLE_WS, WIN.join(PORTABLE_WS, WORKSPACE_MARKER), 'F:\\', WIN.join('F:\\', MANIFEST)),
    });
    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates)).toEqual([PORTABLE_WS]);
    expect(decision.recordedPath).toBe(PORTABLE_WS);
  });

  it('⭐ R1-② explicit-path：记录缺失 ⇒ ask-user（不许静默自愈到同相对路径的 F、不许改归属）', () => {
    const decision = decideWorkspaceStartup({
      ...R1_BASE,
      recordedPath: WIN.join('E:\\', 'external-chosen'),
      recordedRelPath: 'external-chosen',
      workspaceBinding: 'explicit-path',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(WIN.join('F:\\', 'external-chosen'), WIN.join('F:\\', MANIFEST)),
    });
    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    // 候选照摆（供用户确认），但绝不静默落过去
    expect(candidatePaths(decision.candidates)).toEqual([WIN.join('F:\\', 'external-chosen')]);
  });

  it('⭐ R1-③ 上级路径线索（..\\private）必须拒绝 ⇒ 零候选 ⇒ ask-user，绝不开 F:\\private', () => {
    const decision = decideWorkspaceStartup({
      ...R1_BASE,
      recordedPath: PORTABLE_WS,
      recordedRelPath: '..\\private',
      workspaceBinding: 'app-volume',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(WIN.join('F:\\', 'private'), WIN.join('F:\\', MANIFEST)),
    });
    expect(decision).toEqual({ kind: 'ask-user', recordedPath: PORTABLE_WS, candidates: [] });
  });

  it('R1 线索校验（窄函数）：绝对/盘符/UNC/上级/无效段/尾分隔一律拒绝', () => {
    const root = 'F:\\';
    expect(resolveWorkspaceRelative(root, WS_NAME)).toBe(WIN.join('F:\\', WS_NAME));
    expect(resolveWorkspaceRelative(root, WIN.join('a', 'b'))).toBe(WIN.join('F:\\', 'a', 'b'));
    expect(resolveWorkspaceRelative(root, 'a/b')).toBe(WIN.join('F:\\', 'a', 'b'));
    const bad = [
      '',
      '\\rooted',
      'C:\\abs',
      'C:drive',
      '\\\\server\\share',
      '..\\private',
      'a\\..\\b',
      'a\\\\b',
      'a\\',
      '.\\a',
      'a\\b:stream',
      'a\u0000b',
    ];
    for (const raw of bad) {
      expect(resolveWorkspaceRelative(root, raw), raw).toBeNull();
    }
  });

  it('⭐ R1 控制①：唯一候选在运行卷上 ⇒ 仍然静默 healed（原控制不破）', () => {
    const decision = decideWorkspaceStartup({
      ...R1_BASE,
      recordedPath: WIN.join('Z:\\', WS_NAME),
      recordedRelPath: WS_NAME,
      workspaceBinding: 'app-volume',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_WS, WIN.join('F:\\', MANIFEST)),
    });
    expect(decision).toEqual({
      kind: 'healed',
      path: F_WS,
      from: WIN.join('Z:\\', WS_NAME),
      via: { path: F_WS, origin: 'run-volume', evidence: 'volume-marker' },
    });
  });

  it('⭐ R1 控制②：两卷都命中 ⇒ 仍 ask-user（禁止"一律选当前卷"的改法）', () => {
    const decision = decideWorkspaceStartup({
      ...R1_BASE,
      recordedPath: PORTABLE_WS,
      recordedRelPath: WS_NAME,
      workspaceBinding: 'app-volume',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(PORTABLE_WS, WIN.join(PORTABLE_WS, WORKSPACE_MARKER), F_WS, WIN.join('F:\\', MANIFEST)),
    });
    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates).sort()).toEqual([PORTABLE_WS, F_WS].sort());
  });

  it('⭐ R1 控制③：同卷有效原路径不被未使用的坏 relPath 改指（configured）', () => {
    expect(
      decideWorkspaceStartup({
        ...R1_BASE,
        recordedPath: F_WS,
        recordedRelPath: '..\\private',
        workspaceBinding: 'app-volume',
        portableRoot: 'F:\\',
        removableDrives: ['F:'],
        exists: vfs(F_WS),
      }),
    ).toEqual({ kind: 'configured', path: F_WS });
  });
});

describe('explicit external bindings require confirmation before relocation', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const BASE = { defaultPath: WIN.join('C:\\', 'Users', 'u', 'ClawWork-Workspace') };
  const PICKED = '我的工作区';
  const F_PICKED = WIN.join('F:\\', PICKED);
  const E_PICKED = WIN.join('E:\\', PICKED);
  const markerIn = (dir: string): string => WIN.join(dir, WORKSPACE_MARKER);

  it('⚠️ R8-01：老记录（无 id）+ 唯一运行卷候选 + 目录标记 ⇒ 仍 ask-user（技能账本路径不构成运行盘身份）', () => {
    // 独立终审反例形状：任何"别的盘路径集合"（技能账本/历史键）都不许把同相对路径的
    // 另一份工作区静默认成记录的那一份。判定层已不再接收此类输入（只认 workspaceId）。
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: E_PICKED,
      recordedRelPath: PICKED,
      workspaceBinding: 'explicit-path',
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_PICKED, markerIn(F_PICKED), WIN.join('E:\\', MANIFEST)),
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates)).toEqual([F_PICKED]);
  });

  it('explicit external binding does not relocate even when the current-volume copy has the same id', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: E_PICKED,
      recordedRelPath: PICKED,
      workspaceBinding: 'explicit-path',
      workspaceId: 'ws-identity-1',
      readWorkspaceId: () => 'ws-identity-1',
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_PICKED, markerIn(F_PICKED)),
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates)).toEqual([F_PICKED]);
  });

  it('⚠️ 独立反例：无身份、无运行盘关联 ⇒ ask-user（不许冒名收养同相对路径的另一份工作区）', () => {
    // 外部 E 工作区 A 失联；当前 F 运行盘上同相对路径有一份**另一份**带标记的工作区 B。
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: E_PICKED,
      recordedRelPath: PICKED,
      workspaceBinding: 'explicit-path',
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_PICKED, markerIn(F_PICKED)),
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates)).toEqual([F_PICKED]);
  });

  it('⚠️ R8-02：配置有 id 而候选标记 id 读不出（缺 id / 坏 JSON）⇒ ask-user（不许补铸覆盖 A）', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: E_PICKED,
      recordedRelPath: PICKED,
      workspaceBinding: 'explicit-path',
      workspaceId: 'ws-identity-1',
      readWorkspaceId: () => null,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_PICKED, markerIn(F_PICKED)),
    });

    expect(decision.kind).toBe('ask-user');
  });

  it('⚠️ 身份**不匹配**（配置 id ≠ 候选标记 id）⇒ ask-user', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: E_PICKED,
      recordedRelPath: PICKED,
      workspaceBinding: 'explicit-path',
      workspaceId: 'ws-identity-1',
      readWorkspaceId: () => 'ws-identity-2',
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_PICKED, markerIn(F_PICKED)),
    });

    expect(decision.kind).toBe('ask-user');
  });

  it('⚠️ 只记了 volumeMarker（盘根 marker）而没有运行盘关联/身份 ⇒ 仍 ask-user（真机盘根无 manifest，不能当身份）', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: E_PICKED,
      recordedRelPath: PICKED,
      workspaceBinding: 'explicit-path',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_PICKED, WIN.join('F:\\', MANIFEST)),
    });

    expect(decision.kind).toBe('ask-user');
  });

  it('⚠️ 控制：同名目录 + 盘根 marker、**没有**目录级标记 ⇒ 仍 ask-user（缺目录标记仍问人）', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: E_PICKED,
      recordedRelPath: PICKED,
      workspaceBinding: 'explicit-path',
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_PICKED, WIN.join('F:\\', MANIFEST)),
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates)).toEqual([F_PICKED]);
    expect(decision.recordedPath).toBe(E_PICKED);
  });

  it('⚠️ 控制：唯一可信候选在**别的卷**上 ⇒ 仍 ask-user（绝不跨卷静默）', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: WIN.join('Z:\\', PICKED),
      recordedRelPath: PICKED,
      workspaceBinding: 'explicit-path',
      portableRoot: 'F:\\',
      removableDrives: ['E:'],
      exists: vfs(WIN.join('E:\\', PICKED), markerIn(WIN.join('E:\\', PICKED)), WIN.join('F:\\', MANIFEST)),
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates)).toEqual([WIN.join('E:\\', PICKED)]);
  });

  it('⚠️ 控制：app-volume 分支上配置 id 与候选 id **可读且不等** ⇒ ask-user（不收养别的身份）', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: E_PICKED,
      recordedRelPath: PICKED,
      workspaceId: 'ws-identity-1',
      readWorkspaceId: () => 'ws-identity-2',
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_PICKED, markerIn(F_PICKED)),
    });

    expect(decision.kind).toBe('ask-user');
  });

  it('⚠️ 控制：app-volume 与无归属记录的既有行为不变（运行卷候选仍静默 healed）', () => {
    // 老记录（没有 binding 字段、记过盘上相对路径）按 app-volume 保守处理 —— 不变。
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: E_PICKED,
      recordedRelPath: PICKED,
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(F_PICKED, WIN.join('F:\\', MANIFEST)),
    });
    expect(decision.kind).toBe('healed');
  });

  it('⚠️ R8-03：configured 而 marker 身份冲突 ⇒ ask-user（保留两侧证据，候选=原路径，绝不静默开库/覆写）', () => {
    const recordedPath = WIN.join('F:\\', PICKED);
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath,
      recordedRelPath: PICKED,
      workspaceBinding: 'app-volume',
      workspaceId: 'ws-identity-1',
      readWorkspaceId: () => 'ws-identity-2',
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(recordedPath, markerIn(recordedPath)),
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates)).toEqual([recordedPath]);
  });

  it('⚠️ R8-03：configured 而 marker 缺 id/读不出 ⇒ ask-user（目录存在不是身份证明）', () => {
    const recordedPath = WIN.join('F:\\', PICKED);
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath,
      recordedRelPath: PICKED,
      workspaceBinding: 'app-volume',
      workspaceId: 'ws-identity-1',
      readWorkspaceId: () => null,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(recordedPath, markerIn(recordedPath)),
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind !== 'ask-user') throw new Error('unreachable');
    expect(candidatePaths(decision.candidates)).toEqual([recordedPath]);
  });

  it('⭐ R8-03 控制：configured 身份严格相等 ⇒ configured（稳态不变）', () => {
    const recordedPath = WIN.join('F:\\', PICKED);
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath,
      recordedRelPath: PICKED,
      workspaceBinding: 'app-volume',
      workspaceId: 'ws-identity-1',
      readWorkspaceId: () => 'ws-identity-1',
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(recordedPath, markerIn(recordedPath)),
    });

    expect(decision).toEqual({ kind: 'configured', path: recordedPath });
  });

  it('⭐ R8-03 控制：配置无 id 的老记录（目录存在）⇒ configured（补铸在 startup 层，decide 不拦）', () => {
    const recordedPath = WIN.join('F:\\', PICKED);
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath,
      recordedRelPath: PICKED,
      workspaceBinding: 'app-volume',
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(recordedPath, markerIn(recordedPath)),
    });

    expect(decision).toEqual({ kind: 'configured', path: recordedPath });
  });
});

describe('explicit app-volume binding disambiguates copies by the current execution volume', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => vi.restoreAllMocks());
  const old = WIN.join('Q:\\', 'Work'),
    current = WIN.join('W:\\', 'Work'),
    backup = WIN.join('U:\\', 'Work');
  const base = {
    recordedPath: old,
    recordedRelPath: 'Work',
    workspaceBinding: 'app-volume' as const,
    workspaceId: 'workspace-A',
    portableRoot: 'W:\\',
    defaultPath: 'C:\\Work',
    removableDrives: ['Q:', 'U:', 'W:'],
  };
  const marker = (dir: string) => WIN.join(dir, WORKSPACE_MARKER);
  it.each([true, false])(
    'prefers the saved relative path on the execution volume with matching identity (old exists=%s)',
    (oldExists) => {
      const exists = vfs(current, marker(current), backup, marker(backup), ...(oldExists ? [old, marker(old)] : []));
      const result = decideWorkspaceStartup({ ...base, exists, readWorkspaceId: () => 'workspace-A' });
      expect(result).toMatchObject({ kind: 'healed', path: current, from: old });
    },
  );
  it.each([null, 'workspace-B'])('asks when the current-volume identity is missing or different: %s', (id) => {
    const result = decideWorkspaceStartup({
      ...base,
      exists: vfs(old, marker(old), current, marker(current)),
      readWorkspaceId: (dir) => (dir === current ? id : 'workspace-A'),
    });
    expect(result.kind).toBe('ask-user');
  });
  it('does not use a root marker as a substitute for a workspace marker', () => {
    const result = decideWorkspaceStartup({
      ...base,
      exists: vfs(old, marker(old), current, WIN.join('W:\\', MANIFEST)),
      readWorkspaceId: () => 'workspace-A',
    });
    expect(result.kind).toBe('ask-user');
  });
  it.each([null, '', '..\\Work', 'W:\\Work'])('requires the saved valid relative path: %s', (recordedRelPath) => {
    const result = decideWorkspaceStartup({
      ...base,
      recordedRelPath,
      exists: vfs(
        old,
        marker(old),
        current,
        marker(current),
        WIN.join('Q:\\', WS_NAME),
        WIN.join('Q:\\', WS_NAME, WORKSPACE_MARKER),
        WIN.join('W:\\', WS_NAME),
        WIN.join('W:\\', WS_NAME, WORKSPACE_MARKER),
      ),
      readWorkspaceId: () => 'workspace-A',
    });
    expect(result.kind).toBe('ask-user');
  });
  it('does not infer an explicit app-volume binding from a legacy relative-path hint when multiple copies exist', () => {
    const result = decideWorkspaceStartup({
      ...base,
      workspaceBinding: null,
      exists: vfs(old, marker(old), current, marker(current)),
      readWorkspaceId: () => 'workspace-A',
    });
    expect(result.kind).toBe('ask-user');
  });
  it('does not interpret duplicate spellings of the same current-volume path as ambiguity', () => {
    const result = decideWorkspaceStartup({
      ...base,
      removableDrives: ['W:', 'w:\\', 'Q:'],
      exists: vfs(old, marker(old), current, marker(current)),
      readWorkspaceId: () => 'workspace-A',
    });
    expect(result).toMatchObject({ kind: 'healed', path: current });
  });
});

/**
 * 层①遗留分支（2026-10-17 实机取证）：**1.0.6/1.0.7 的设置里手选工作区，一律写
 * `explicit-path`**（`1e03715f:ipc/workspace-handlers.ts:70-72` 无条件写），于是"用户选的
 * 就是本盘 `X:\荣盈魔方工作区`"也被记成显式外部目录 ⇒ 换盘符后必然弹「选择工作区」。
 *
 * 收窄例外**只认结构与身份，不认目录名**：
 *   ① 记录路径必须**恰好是它自己那块卷根下的便携工作区**（`<旧卷>\荣盈魔方工作区`）；
 *      `D:\客户资料\荣盈魔方工作区` 这种同名外部目录结构上就不满足 ⇒ 仍弹框（R1 不放松）。
 *   ② 当前运行卷上有同名工作区、且带 marker 证据；
 *   ③ 配置记过 id ⇒ marker 里的 id 必须**严格相等**（不同盘/不同副本 ⇒ 弹框，绝不静默串数据）。
 */
describe('层①遗留：explicit-path 记录的其实就是本盘便携工作区', () => {
  beforeEach(() => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const BASE = { defaultPath: WIN.join('C:\\', 'Users', 'u', 'ClawWork-Workspace') };
  const OLD = WIN.join('E:\\', WS_NAME);
  const NEW = WIN.join('F:\\', WS_NAME);
  const same = (a: string, b: string): boolean => WIN.normalize(a).toLowerCase() === WIN.normalize(b).toLowerCase();

  it('⭐ 记录路径 = 旧卷根下的便携工作区 + 新卷身份一致 ⇒ healed（不弹框）', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: OLD,
      recordedRelPath: WS_NAME,
      workspaceBinding: 'explicit-path',
      workspaceId: 'ws-1',
      readWorkspaceId: (dir) => (same(dir, NEW) ? 'ws-1' : null),
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(NEW, WIN.join('F:\\', MANIFEST)),
    });

    expect(decision.kind).toBe('healed');
    if (decision.kind !== 'healed') throw new Error('unreachable');
    expect(decision.path).toBe(NEW);
    expect(decision.from).toBe(OLD);
  });

  it('⭐ 旧盘符被另一块盘占用（旧卷同名目录仍在）⇒ 仍 healed 到当前卷', () => {
    // 用户真实场景：U 盘在 A 电脑是 E:，拿回家后那台电脑自带 E: 固态，
    // U 盘变成 F:。旧 E: 上甚至有一个同名目录 —— 它不属于这块盘，不能阻止自愈。
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: OLD,
      recordedRelPath: WS_NAME,
      workspaceBinding: 'explicit-path',
      workspaceId: 'ws-1',
      readWorkspaceId: (dir) => (same(dir, NEW) ? 'ws-1' : null),
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['E:', 'F:'],
      exists: vfs(
        OLD, // 旧字母现在插着另一块盘，恰好有同名目录
        NEW,
        WIN.join('F:\\', MANIFEST),
      ),
    });

    expect(decision.kind).toBe('healed');
    if (decision.kind !== 'healed') throw new Error('unreachable');
    expect(decision.path).toBe(NEW);
  });

  // 2026-10-19 自审：上面那条的反面。旧卷（E:）插着**另一台也装了本产品**的电脑，
  // 它的便携工作区带盘根 marker、id 恰好也等于记录里的 id；当前卷（F:）还没有工作区。
  // 旧行为会把用户静默切到别人那台电脑的工作区 —— R1 的红线（唯一候选不许从旧卷胜出）
  // 必须对 explicit 的 legacy 记录同样生效。
  it('⭐ explicit 便携记录 + 唯一候选在旧卷（带证据）+ 当前卷没有 ⇒ ask-user，绝不 healed 到旧卷', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: OLD,
      recordedRelPath: WS_NAME,
      workspaceBinding: 'explicit-path',
      workspaceId: 'ws-1',
      readWorkspaceId: (dir) => (same(dir, OLD) ? 'ws-1' : null),
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['E:', 'F:'],
      exists: vfs(OLD, WIN.join('E:\\', MANIFEST)),
    });

    expect(decision.kind).toBe('ask-user');
  });

  it('⭐ 配置没记 id（更老的记录）⇒ 结构相符即可自愈，不制造假询问', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: OLD,
      recordedRelPath: WS_NAME,
      workspaceBinding: 'explicit-path',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(NEW, WIN.join('F:\\', MANIFEST)),
    });
    expect(decision.kind).toBe('healed');
  });

  it('⭐ 新卷那份工作区身份不一致（另一块盘/另一份副本）⇒ ask-user，绝不静默串数据', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: OLD,
      recordedRelPath: WS_NAME,
      workspaceBinding: 'explicit-path',
      workspaceId: 'ws-1',
      readWorkspaceId: () => 'ws-other',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(NEW, WIN.join('F:\\', MANIFEST)),
    });
    expect(decision.kind).toBe('ask-user');
  });

  it('⭐ 同名外部目录（不在任何卷根下、且已不存在）⇒ 仍 ask-user（R1 不放松）', () => {
    const external = WIN.join('D:\\', '客户资料', WS_NAME);
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: external,
      recordedRelPath: null,
      workspaceBinding: 'explicit-path',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      // 外部目录**不在了**，而 F 盘上恰好有一份同名工作区 —— 这正是"名字骗过判据"的场景
      exists: vfs(NEW, WIN.join('F:\\', MANIFEST)),
    });
    expect(decision.kind).toBe('ask-user');
  });

  it('新卷上根本没有便携工作区 ⇒ ask-user（不许在错的地方造一份）', () => {
    const decision = decideWorkspaceStartup({
      ...BASE,
      recordedPath: OLD,
      recordedRelPath: WS_NAME,
      workspaceBinding: 'explicit-path',
      volumeMarker: MANIFEST,
      portableRoot: 'F:\\',
      removableDrives: ['F:'],
      exists: vfs(WIN.join('F:\\', MANIFEST)),
    });
    expect(decision.kind).toBe('ask-user');
  });
});
