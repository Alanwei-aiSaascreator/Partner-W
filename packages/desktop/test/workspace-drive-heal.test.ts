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
});
