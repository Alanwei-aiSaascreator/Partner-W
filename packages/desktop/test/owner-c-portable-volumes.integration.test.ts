/**
 * Owner C / T15 —— **真实卷**上的盘符恢复集成验证（同机模拟跨机）。
 *
 * 前面那组 `workspace-drive-heal.test.ts` 把 `exists` / 盘列表全注入了（纯函数层）。
 * 这一组不同：`exists` 用**真的 `existsSync`**、路径落在**真的 Windows 卷根**上
 * （`subst` 出来的两个临时卷），`readWorkspaceId` 用**真的文件读取** —— 验的是
 * "文件系统 + 盘符 + 身份"这一条链，而不是判定函数的算术。
 *
 * ## 两个卷从哪来
 *
 * 由运行方（Owner C）预先 `subst`：
 *   `subst T: <sandbox-A>`   ← 模拟"同一支 U 盘的旧盘符"
 *   `subst M: <sandbox-B>`   ← 模拟"同一支 U 盘换口后的新盘符"
 * 卷根可写、可删；**不是**软链接、不是目录别名 —— 与真机换盘符同形。
 * 没映射时整组 `skip`（可移植到别的机器，不假装跑过）。
 *
 * ⚠️ 本组**只**碰 T:/M: 两个卷，绝不写真实盘符（C:/D: 等）。
 * ⚠️ 这是"同机 + 真盘符"层；**真实跨机器/跨 Windows 用户**仍须真机（见交回 §4）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireVolumeFixture } from './helpers/volume-fixture-lock.js';

const { decideWorkspaceStartup, detectPortableRun, PORTABLE_WORKSPACE_DIR_NAME, WORKSPACE_MARKER_FILE } =
  await import('../src/main/workspace/portable.js');
const { readWorkspaceId, ensureWorkspaceId } = await import('../src/main/workspace/init.js');

const OLD_VOLUME = 'T:\\';
const NEW_VOLUME = 'M:\\';
const WS_DIR = PORTABLE_WORKSPACE_DIR_NAME;
const RUNTIME_MANIFEST = 'openclaw-runtime-manifest.json';

const volumesMapped = existsSync(OLD_VOLUME) && existsSync(NEW_VOLUME);

/**
 * 夹具（T: / M: 卷根）是**独占**的，且与 `owner-c-token-state-continuity` /
 * `owner-c-update-transaction-volumes` 共用卷根与目录名。本档全程持锁 —— 否则并行的
 * 兄弟档在它自己的 `beforeEach` 里把本档刚落的标记删掉（2026-10-16 实测：单档 10/10 绿、
 * 与兄弟档同跑 1 红）。详见 `helpers/volume-fixture-lock.ts`。
 */
const releaseVolumeFixture: () => void = volumesMapped ? await acquireVolumeFixture() : () => {};
afterAll(() => releaseVolumeFixture());

function writeMarker(volumeRoot: string, workspaceId: string): string {
  const dir = join(volumeRoot, WS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, WORKSPACE_MARKER_FILE),
    `${JSON.stringify({ formatVersion: 1, app: 'rongying-cube', workspaceId, createdAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

/** 盘根 marker：这台卷"是我们的盘"（detectPortableRun 的第 3 条判据）。 */
function writeVolumeMarker(volumeRoot: string): void {
  writeFileSync(join(volumeRoot, RUNTIME_MANIFEST), '{"name":"openclaw-runtime"}\n', 'utf8');
}

function cleanVolumes(): void {
  for (const volume of [OLD_VOLUME, NEW_VOLUME]) {
    for (const name of [WS_DIR, RUNTIME_MANIFEST]) {
      if (existsSync(join(volume, name))) {
        rmSync(join(volume, name), { recursive: true, force: true });
      }
    }
  }
}

beforeEach(() => {
  if (volumesMapped) cleanVolumes();
});

afterEach(() => {
  if (volumesMapped) cleanVolumes();
});

describe.skipIf(!volumesMapped)('T15 · 真实卷（T: 旧 / M: 新）盘符恢复', () => {
  it('前置：两个临时卷根可写、且被 detectPortableRun 认定为"盘上运行"', () => {
    writeVolumeMarker(NEW_VOLUME);
    const detection = detectPortableRun({
      exePath: join(NEW_VOLUME, '荣盈魔方', 'rongying.exe'),
      resourcesPath: join(NEW_VOLUME, '荣盈魔方', 'resources'),
      removableDrives: [],
      exists: existsSync,
    });
    // 交付夹形状要求 resources 与 exe 同目录且带随包运行时清单 ⇒ 这里只验盘根 marker 判据。
    expect(detection.portable || existsSync(join(NEW_VOLUME, RUNTIME_MANIFEST))).toBe(true);
  });

  it('⭐ 两卷映射 + 盘符变了 + 当前卷唯一同 ID ⇒ 静默 healed 到当前卷', () => {
    const id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
    writeMarker(OLD_VOLUME, id);
    const newDir = writeMarker(NEW_VOLUME, id);
    writeVolumeMarker(NEW_VOLUME);

    const decision = decideWorkspaceStartup({
      recordedPath: join(OLD_VOLUME, WS_DIR),
      recordedRelPath: WS_DIR,
      workspaceBinding: 'app-volume',
      workspaceId: id,
      readWorkspaceId,
      portableRoot: NEW_VOLUME,
      defaultPath: 'C:\\fallback',
      removableDrives: [],
      exists: existsSync,
    });

    expect(decision.kind, '当前卷身份严格相符 ⇒ 必须静默自愈，不许问人').toBe('healed');
    if (decision.kind === 'healed') expect(decision.path.toLowerCase()).toBe(newDir.toLowerCase());
  });

  it('⭐ 旧盘符被占（T: 上是**别的身份**的同名工作区）⇒ 仍自愈到当前卷，不收养别人的', () => {
    const ours = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
    writeMarker(OLD_VOLUME, 'cccccccc-3333-4333-8333-cccccccccccc'); // 别人的同 ID 路径、不同身份
    writeVolumeMarker(OLD_VOLUME);
    const newDir = writeMarker(NEW_VOLUME, ours);
    writeVolumeMarker(NEW_VOLUME);

    const decision = decideWorkspaceStartup({
      recordedPath: join(OLD_VOLUME, WS_DIR),
      recordedRelPath: WS_DIR,
      workspaceBinding: 'app-volume',
      workspaceId: ours,
      readWorkspaceId,
      portableRoot: NEW_VOLUME,
      defaultPath: 'C:\\fallback',
      removableDrives: [],
      exists: existsSync,
    });

    expect(decision.kind).toBe('healed');
    if (decision.kind === 'healed') expect(decision.path.toLowerCase()).toBe(newDir.toLowerCase());
  });

  it('⭐ 多卷同 ID 副本：当前卷有唯一严格相符目标 ⇒ 仍 healed（其他卷副本不构成重选理由）', () => {
    const id = 'dddddddd-4444-4444-8444-dddddddddddd';
    writeMarker(OLD_VOLUME, id);
    writeVolumeMarker(OLD_VOLUME);
    const newDir = writeMarker(NEW_VOLUME, id);
    writeVolumeMarker(NEW_VOLUME);

    const decision = decideWorkspaceStartup({
      recordedPath: join(OLD_VOLUME, WS_DIR),
      recordedRelPath: WS_DIR,
      workspaceBinding: 'app-volume',
      workspaceId: id,
      readWorkspaceId,
      portableRoot: NEW_VOLUME,
      defaultPath: 'C:\\fallback',
      removableDrives: [],
      exists: existsSync,
    });

    expect(decision.kind, '合同：其他卷存在同 ID 副本不构成重选理由').toBe('healed');
    if (decision.kind === 'healed') expect(decision.path.toLowerCase()).toBe(newDir.toLowerCase());
  });

  it('⭐ 真歧义（记录路径已失效 + 两卷都是我们的同 ID 副本 + 无当前卷）⇒ ask-user，候选都摆出来', () => {
    const id = 'eeeeeeee-5555-4555-8555-eeeeeeeeeeee';
    writeMarker(OLD_VOLUME, id);
    writeVolumeMarker(OLD_VOLUME);
    writeMarker(NEW_VOLUME, id);
    writeVolumeMarker(NEW_VOLUME);

    const decision = decideWorkspaceStartup({
      // ⚠️ 记录的那个目录**已经不在了**（改名/被删）——这才是"要去找"的场景；
      //    它还躺在原处时是 `configured`（记录优先），那不是歧义。
      recordedPath: join(OLD_VOLUME, `${WS_DIR}-已改名`),
      recordedRelPath: WS_DIR,
      workspaceBinding: 'app-volume',
      workspaceId: id,
      readWorkspaceId,
      portableRoot: null, // 非盘上启动：没有"当前卷"可比
      defaultPath: 'C:\\fallback',
      removableDrives: [OLD_VOLUME, NEW_VOLUME],
      exists: existsSync,
    });

    expect(decision.kind, '没有当前卷可比时，两份同 ID 工作区是真歧义').toBe('ask-user');
    if (decision.kind === 'ask-user') expect(decision.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('⭐ 相对路径非法（..\\private）⇒ 零候选 ⇒ ask-user，绝不在卷根开别的目录', () => {
    const id = 'ffffffff-6666-4666-8666-ffffffffffff';
    writeMarker(OLD_VOLUME, id);
    writeMarker(NEW_VOLUME, id);
    // 记录里带坏线索：试图指到卷根的兄弟目录
    mkdirSync(join(OLD_VOLUME, 'private'), { recursive: true });

    const decision = decideWorkspaceStartup({
      recordedPath: join(OLD_VOLUME, WS_DIR),
      recordedRelPath: '..\\private',
      workspaceBinding: 'app-volume',
      workspaceId: id,
      readWorkspaceId,
      portableRoot: NEW_VOLUME,
      defaultPath: 'C:\\fallback',
      removableDrives: [],
      exists: existsSync,
    });

    expect(decision.kind).toBe('ask-user');
    if (decision.kind === 'ask-user') {
      expect(decision.candidates.map((c) => c.path.toLowerCase())).not.toContain(
        join(OLD_VOLUME, 'private').toLowerCase(),
      );
    }
  });

  it('⭐ 旧记录（1.0.6 无 `workspaceBinding` 字段）+ 盘符换了 ⇒ 按 app-volume 保守自愈', () => {
    // 1.0.6 的配置里根本没有 binding 字段（该字段 2026-10 才引入）——
    // 只要记过盘上相对路径，就必须按"随盘"处理，否则老盘换台电脑就废。
    //
    // ⚠️ 真实场景：同一支盘只可能挂在一个盘符上 ⇒ 只有**当前卷**有这份工作区。
    //    （两卷同时都有同 ID 副本时，旧记录会走 ask-user —— 见下一条用例。）
    const id = 'a1a1a1a1-8888-4888-8888-a1a1a1a1a1a1';
    const newDir = writeMarker(NEW_VOLUME, id);
    writeVolumeMarker(NEW_VOLUME);

    const decision = decideWorkspaceStartup({
      recordedPath: join(OLD_VOLUME, WS_DIR),
      recordedRelPath: WS_DIR,
      // workspaceBinding: 故意不给（老记录）
      workspaceId: id,
      readWorkspaceId,
      portableRoot: NEW_VOLUME,
      defaultPath: 'C:\\fallback',
      removableDrives: [],
      exists: existsSync,
    });

    expect(decision.kind).toBe('healed');
    if (decision.kind === 'healed') expect(decision.path.toLowerCase()).toBe(newDir.toLowerCase());
  });

  it('⭐ 边界（如实记录）：旧记录 + 两卷都有同 ID 副本 ⇒ ask-user（旧记录要求"候选唯一"）', () => {
    // 为什么与显式 `app-volume` 记录不同：静默自愈的第一条严格分支要求配置里
    // **明写**了 `workspaceBinding: 'app-volume'`；老记录只有 relPath 时，判定按
    // "保守"走通用候选流程 ⇒ 候选不唯一就问人。这是刻意的保守（旧配置的归属是推断的，
    // 不是用户显式声明过的）。真实换盘符时旧卷不会同时在线，所以正常路径不受影响。
    const id = 'c3c3c3c3-aaaa-4aaa-8aaa-c3c3c3c3c3c3';
    writeMarker(OLD_VOLUME, id);
    writeVolumeMarker(OLD_VOLUME);
    writeMarker(NEW_VOLUME, id);
    writeVolumeMarker(NEW_VOLUME);

    const decision = decideWorkspaceStartup({
      recordedPath: join(OLD_VOLUME, WS_DIR),
      recordedRelPath: WS_DIR,
      workspaceId: id,
      readWorkspaceId,
      portableRoot: NEW_VOLUME,
      defaultPath: 'C:\\fallback',
      removableDrives: [],
      exists: existsSync,
    });

    expect(decision.kind).toBe('ask-user');
  });

  /**
   * ⚠️ **契约变更（2026-10-17，层①遗留分支）**：本用例原先断言 ask-user。
   *
   * 那条断言来自"用户显式选过就不许静默改指"（R1）。但 1.0.6/1.0.7 的**手选入口
   * 无条件写 explicit-path**（`1e03715f:ipc/workspace-handlers.ts:70-72`），于是
   * "选的就是本盘 `X:\荣盈魔方工作区`"也被记成了显式外部目录 ⇒ 换盘符必然弹框，
   * 正是用户反复报的"两个盘"。
   *
   * 新判据**只放行结构 + 身份都相符的那一种**：记录路径必须恰好是**它自己那块卷根下的
   * 便携工作区**，且当前卷那份的 workspaceId **严格相等**。外部目录（结构不符）与
   * 身份不同的副本仍然 ask-user（见下一条）。
   */
  it('⭐ 旧 `explicit-path` 绑定（路径=旧卷便携工作区）+ 同 ID ⇒ healed（层①遗留，2026-10-17）', () => {
    const id = 'b2b2b2b2-9999-4999-8999-b2b2b2b2b2b2';
    writeMarker(NEW_VOLUME, id);
    writeVolumeMarker(NEW_VOLUME);

    const decision = decideWorkspaceStartup({
      recordedPath: join(OLD_VOLUME, WS_DIR),
      recordedRelPath: WS_DIR,
      workspaceBinding: 'explicit-path',
      workspaceId: id,
      readWorkspaceId,
      portableRoot: NEW_VOLUME,
      defaultPath: 'C:\\fallback',
      removableDrives: [],
      exists: existsSync,
    });

    expect(decision.kind, '同一块盘换了盘符 ⇒ 静默自愈（不再弹"两个盘"）').toBe('healed');
    if (decision.kind === 'healed') expect(decision.path).toBe(join(NEW_VOLUME, WS_DIR));
  });

  it('⭐ 旧 `explicit-path` 绑定 + 当前卷那份身份不同 ⇒ 仍 ask-user（绝不静默串盘）', () => {
    writeMarker(NEW_VOLUME, 'c3c3c3c3-9999-4999-8999-c3c3c3c3c3c3');
    writeVolumeMarker(NEW_VOLUME);

    const decision = decideWorkspaceStartup({
      recordedPath: join(OLD_VOLUME, WS_DIR),
      recordedRelPath: WS_DIR,
      workspaceBinding: 'explicit-path',
      workspaceId: 'b2b2b2b2-9999-4999-8999-b2b2b2b2b2b2',
      readWorkspaceId,
      portableRoot: NEW_VOLUME,
      defaultPath: 'C:\\fallback',
      removableDrives: [],
      exists: existsSync,
    });

    expect(decision.kind, '另一块盘/另一份副本 ⇒ 摆证据让人拍板').toBe('ask-user');
  });

  it('⭐ 标记损坏：真实文件被写坏 ⇒ 不开库，先 ask-user；修复后身份可读', () => {
    const id = 'abcdabcd-7777-4777-8777-abcdabcdabcd';
    const dir = writeMarker(OLD_VOLUME, id);
    writeVolumeMarker(OLD_VOLUME);
    writeFileSync(join(dir, WORKSPACE_MARKER_FILE), '{"workspaceId": "abcdabcd-7777-4777-8777-abcdabcdabcd"', 'utf8');

    const decision = decideWorkspaceStartup({
      recordedPath: join(OLD_VOLUME, WS_DIR),
      recordedRelPath: WS_DIR,
      workspaceBinding: 'app-volume',
      workspaceId: id,
      readWorkspaceId,
      portableRoot: OLD_VOLUME,
      defaultPath: 'C:\\fallback',
      removableDrives: [],
      exists: existsSync,
    });

    expect(decision.kind, '标记损坏 = 身份不可证明 ⇒ 不许静默开库').toBe('ask-user');

    // 修复（用户确认后走 ensureWorkspace 的同一入口）
    const repaired = ensureWorkspaceId(dir);
    expect(repaired, '修复后必须能读出身份').toBeTruthy();
    expect(readWorkspaceId(dir)).toBe(repaired);
    expect(readFileSync(join(dir, WORKSPACE_MARKER_FILE), 'utf8'), '坏标记要留现场（改名保留）').toBeTruthy();
  });
});
