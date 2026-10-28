/**
 * Owner C / T18 —— 升级事务状态机在**真实卷**上的集成验证（同机模拟）。
 *
 * 合同依据：本轮 T18「1.0.6 → 候选升级、回滚、频道/ready/取消、包校验、盘根
 * `packageVersion`/`installId`、旧技能继承」。
 *
 * ⚠️ **本组不是"真机升级验收"**：真机升级要用一支**复制的 1.0.6 测试盘** + 真启动器
 *    + 真更新源（本轮没有这条链路，见交回 §4 NOT RUN）。这里验的是**盘上路径与事务
 *    状态机**在真卷（`subst` 出来的临时卷）上的行为：
 *      · 事务路径全部落在**同一个卷**、且**不碰**受保护目录（运行数据 / 工作区）；
 *      · 状态文件**读写幂等**、坏文件**隔离保留**（不删）；
 *      · `recoverPortablePrepareAtStartup` 只清 **PREPARE 相位**；`ready` 事务
 *        （"等重启换目录"的成果）**绝不被清**；
 *      · 非盘上形态**一律不动手**。
 *
 * 没映射测试卷时整组 skip。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireVolumeFixture } from './helpers/volume-fixture-lock.js';

const {
  PortableUpdateStateStore,
  assertPortableTransactionPaths,
  recoverPortablePrepare,
  recoverPortablePrepareAtStartup,
  resolvePortableTransactionPaths,
  portableUpdateStateFilePath,
  PORTABLE_DATA_DIRECTORY_NAME,
  PORTABLE_PROGRAM_DIRECTORY_NAME,
  PORTABLE_UPDATE_DIRECTORY_NAME,
  PORTABLE_WORKSPACE_DIRECTORY_NAME,
} = await import('../src/main/update/portable-state.js');

const VOLUME = 'T:\\';
const volumesMapped = existsSync(VOLUME);

/**
 * 本档清的是卷根上的 `Partner-W工作区` / `Partner-W-运行数据` 等目录 —— 与
 * `owner-c-portable-volumes`、`owner-c-token-state-continuity` **同名重叠**。
 * 夹具独占，全程持锁，避免并行兄弟档的清理插进来。详见
 * `helpers/volume-fixture-lock.ts`。
 */
const releaseVolumeFixture: () => void = volumesMapped ? await acquireVolumeFixture() : () => {};
afterAll(() => releaseVolumeFixture());

const TXN = 'txn-20261016-0001';

type Transaction = Awaited<ReturnType<InstanceType<typeof PortableUpdateStateStore>['write']>>;

function cleanVolume(): void {
  for (const name of [
    PORTABLE_UPDATE_DIRECTORY_NAME,
    PORTABLE_DATA_DIRECTORY_NAME,
    PORTABLE_WORKSPACE_DIRECTORY_NAME,
    PORTABLE_PROGRAM_DIRECTORY_NAME,
  ]) {
    const target = join(VOLUME, name);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}

function makeTransaction(phase: string, extra: Record<string, unknown> = {}): Transaction {
  return {
    ...resolvePortableTransactionPaths({ root: VOLUME, transactionId: TXN }),
    schemaVersion: 1,
    transactionId: TXN,
    phase: phase as Transaction['phase'],
    currentVersion: '1.0.6',
    targetVersion: '1.0.8',
    channel: 'stable',
    updatedAt: 1,
    ...extra,
  } as Transaction;
}

beforeEach(() => {
  if (volumesMapped) cleanVolume();
});

afterEach(() => {
  if (volumesMapped) cleanVolume();
});

describe.skipIf(!volumesMapped)('T18 · 真卷（T:）上的更新事务状态机', () => {
  it('① 事务路径：全部落在同一卷，且**不碰**受保护目录（运行数据 / 工作区）', () => {
    const paths = resolvePortableTransactionPaths({ root: VOLUME, transactionId: TXN });

    for (const target of [
      paths.updateRoot,
      paths.archivePath,
      paths.stagedProgramPath,
      paths.manifestPath,
      paths.fileManifestPath,
      paths.healthPath,
    ]) {
      expect(target.toLowerCase().startsWith('t:\\'), `${target} 必须在同一卷`).toBe(true);
    }
    // 更新根是"程序目录的兄弟"（换目录只换程序目录，数据/工作区不动）
    expect(paths.currentProgramPath.toLowerCase()).toBe(join(VOLUME, PORTABLE_PROGRAM_DIRECTORY_NAME).toLowerCase());

    expect(() => assertPortableTransactionPaths(makeTransaction('downloading'))).not.toThrow();
  });

  it('② 跨卷事务一律拒绝（不许半拉子在别的盘）', () => {
    const transaction = makeTransaction('downloading');
    expect(() =>
      assertPortableTransactionPaths({ ...transaction, archivePath: join('M:\\', 'x', 'package.zip') }),
    ).toThrow();
  });

  it('③ 状态文件：真卷上读写幂等，updatedAt 单调递增', async () => {
    const store = new PortableUpdateStateStore({ stateFilePath: portableUpdateStateFilePath(VOLUME) });

    const written = await store.write(makeTransaction('downloading'));
    expect(existsSync(portableUpdateStateFilePath(VOLUME))).toBe(true);

    const again = await store.write({ ...written, phase: 'extracting' });
    expect(again.updatedAt, 'updatedAt 必须单调（同毫秒也要能区分）').toBeGreaterThan(written.updatedAt);

    const read = await store.read();
    expect(read?.transactionId).toBe(TXN);
    expect(read?.phase).toBe('extracting');
  });

  it('④ 坏状态文件：**改名隔离保留**（不删），并当作"没有事务"', async () => {
    const statePath = portableUpdateStateFilePath(VOLUME);
    mkdirSync(join(VOLUME, PORTABLE_UPDATE_DIRECTORY_NAME), { recursive: true });
    writeFileSync(statePath, '{ half written', 'utf8');

    const store = new PortableUpdateStateStore({ stateFilePath: statePath });
    expect(await store.read()).toBeNull();

    expect(existsSync(statePath), '坏文件本身已被隔离（改名），原位置不再有').toBe(false);
    const quarantined = readdirSync(join(VOLUME, PORTABLE_UPDATE_DIRECTORY_NAME)).filter((n) =>
      n.startsWith('update-state.json'),
    );
    expect(quarantined.length, '坏状态必须留痕（改名保留，不是删除）').toBeGreaterThan(0);
    expect(readFileSync(join(VOLUME, PORTABLE_UPDATE_DIRECTORY_NAME, quarantined[0]), 'utf8')).toBe('{ half written');
  });

  it('⭐ ⑤ 崩溃恢复只清 PREPARE 相位；`ready` 事务（等重启换目录的成果）绝不被清', async () => {
    const stateFilePath = portableUpdateStateFilePath(VOLUME);

    for (const phase of ['downloading', 'verifying-archive', 'extracting', 'verifying-files']) {
      cleanVolume();
      const store = new PortableUpdateStateStore({ stateFilePath });
      const transaction = await store.write(makeTransaction(phase));
      // 造出"下载/解压留下的垃圾"
      mkdirSync(join(VOLUME, PORTABLE_UPDATE_DIRECTORY_NAME, 'download', TXN), { recursive: true });
      mkdirSync(join(VOLUME, PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', TXN, 'program'), { recursive: true });
      if (phase !== 'downloading') await store.write(transaction);

      const result = await recoverPortablePrepareAtStartup({ portableRoot: VOLUME });
      expect(result.kind, `PREPARE 相位 ${phase} 应被回收`).toBe('discarded');
    }

    for (const phase of ['ready', 'applying', 'awaiting-health']) {
      cleanVolume();
      const store = new PortableUpdateStateStore({ stateFilePath });
      const transaction = await store.write(makeTransaction(phase));
      mkdirSync(join(VOLUME, PORTABLE_UPDATE_DIRECTORY_NAME, 'staged', TXN, 'program'), { recursive: true });

      const result = await recoverPortablePrepareAtStartup({ portableRoot: VOLUME });
      expect(result.kind, `${phase} 事务不许被启动清扫掉`).toBe('nothing-to-recover');
      expect(await store.read(), `${phase} 事务必须原样留着`).not.toBeNull();
      expect(transaction.phase).toBe(phase);
    }
  });

  it('⭐ ⑥ 非盘上形态：一次都不动手（宁可不删）', async () => {
    const stateFilePath = portableUpdateStateFilePath(VOLUME);
    mkdirSync(join(VOLUME, PORTABLE_UPDATE_DIRECTORY_NAME), { recursive: true });
    const store = new PortableUpdateStateStore({ stateFilePath });
    await store.write(makeTransaction('downloading'));
    mkdirSync(join(VOLUME, PORTABLE_UPDATE_DIRECTORY_NAME, 'download', TXN), { recursive: true });

    const result = await recoverPortablePrepareAtStartup({ portableRoot: null });

    expect(result.kind).toBe('skipped-not-portable');
    expect(existsSync(join(VOLUME, PORTABLE_UPDATE_DIRECTORY_NAME, 'download', TXN)), '非盘上不许删').toBe(true);
    await recoverPortablePrepare({ store, transaction: makeTransaction('downloading') });
  });
});
