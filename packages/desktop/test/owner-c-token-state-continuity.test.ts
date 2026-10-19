/**
 * Owner C / T17 —— token / state 目录的**稳定继承**（真实卷 + 真实 store）。
 *
 * 合同依据：本轮 T17「保留既有 token 复用；轮换/恢复时不让历史任务、数据库、附件、
 * 会话指向'另一份空目录'。必验：旧 token **可读 / 不可读**两种」。
 *
 * ## 这一组钉的是什么
 *
 * `runtime/token-store.ts` 是"本机网关令牌的唯一真相源"，而盘上 state 目录
 * **按 token 定身份**（`portableStateDirFor = <stateRoot>/state/sha256(token)[:24]`）。
 * 所以"令牌稳不稳"直接决定"网关会话还在不在原地"。下面用**真文件系统**（卷根 =
 * `subst` 出来的两个临时卷）驱动真 store，把两条分支的**实际行为**钉住：
 *
 * 1. **token 可读**：跨"换盘符"复用同一 token ⇒ state 目录逐字不变（继承）；
 * 2. **token 不可读**：新铸 token ⇒ state 目录**确实换了**（不是同一个）。
 *    ⚠️ 这是**有意隔离**，不是缺陷 —— 同一盘符插另一支盘时"不继承上一支盘的
 *    密钥/会话"是既有硬要求（`runtime-state-config.test.ts` 的用例）。如实记录为
 *    T17 的**未闭合边界**，不擅自改成"复用旧身份目录"（那会破坏隔离保证）。
 * 3. 任务/数据库/附件的家是**工作区**（与 token 无关）⇒ 令牌轮换不动它们。
 *
 * 没映射测试卷时整组 skip（可移植到别的机器）。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { acquireVolumeFixture } from './helpers/volume-fixture-lock.js';

const { ensureLocalGatewayToken, authStorePath, readAuthStore } = await import('../src/main/runtime/token-store.js');
const { portableStateDirFor } = await import('../src/main/runtime/state-config.js');

const OLD_VOLUME = 'T:\\';
const NEW_VOLUME = 'M:\\';
const RUN_DATA = '荣盈魔方-运行数据';

const volumesMapped = existsSync(OLD_VOLUME) && existsSync(NEW_VOLUME);

/**
 * 与另两个 owner-c 档共用 T: / M: 卷根（本档清的是卷上的 `荣盈魔方-运行数据`，
 * `owner-c-update-transaction-volumes` 也清它）—— 夹具独占，全程持锁。
 * 详见 `helpers/volume-fixture-lock.ts`。
 */
const releaseVolumeFixture: () => void = volumesMapped ? await acquireVolumeFixture() : () => {};
afterAll(() => releaseVolumeFixture());

/** 盘上 userData = `<卷根>\荣盈魔方-运行数据`（见 `portable-app-data.ts`）。 */
function dataRootOf(volumeRoot: string): string {
  return join(volumeRoot, RUN_DATA);
}

function cleanVolumes(): void {
  for (const volume of [OLD_VOLUME, NEW_VOLUME]) {
    const root = dataRootOf(volume);
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
}

beforeEach(() => {
  if (volumesMapped) cleanVolumes();
});

afterEach(() => {
  if (volumesMapped) cleanVolumes();
});

describe.skipIf(!volumesMapped)('T17 · 真实卷上的 token / state 继承', () => {
  it('① 首跑：在盘上建 token store（真相源落盘）', () => {
    const dataRoot = dataRootOf(OLD_VOLUME);
    const result = ensureLocalGatewayToken({ userDataDir: dataRoot });

    expect(result.created).toBe(true);
    expect(existsSync(authStorePath(dataRoot)), 'store 必须建在盘上（随盘走）').toBe(true);
    expect(readAuthStore(dataRoot)?.token).toBe(result.token);
  });

  it('② token 可读（换盘符 = 同一支盘、新卷根）：复用同一 token，state 目录逐字不变', () => {
    const oldRoot = dataRootOf(OLD_VOLUME);
    const first = ensureLocalGatewayToken({ userDataDir: oldRoot });
    const oldStateDir = portableStateDirFor(oldRoot, first.token);

    // 换盘符：同一支盘的内容挪到新卷根（整棵运行数据目录随盘走）
    const newRoot = dataRootOf(NEW_VOLUME);
    mkdirSync(newRoot, { recursive: true });
    // 直接复制"盘上那份 store"的字节（模拟盘整体换口，内容是同一份）
    const storeSource = authStorePath(oldRoot);
    const storeTarget = authStorePath(newRoot);
    mkdirSync(join(newRoot, 'runtime'), { recursive: true });
    writeFileSync(storeTarget, readFileSync(storeSource, 'utf8'), 'utf8');

    const second = ensureLocalGatewayToken({ userDataDir: newRoot });

    expect(second.created, '盘上已有 store ⇒ 必须复用，不许重新生成').toBe(false);
    expect(second.token, '同一支盘 ⇒ 同一 token').toBe(first.token);
    expect(portableStateDirFor(newRoot, second.token), '同一 token ⇒ state 目录身份不变（会话/技能账本留在原地）').toBe(
      portableStateDirFor(oldRoot, first.token).replace(oldRoot, newRoot),
    );
    expect(oldStateDir.endsWith(portableStateDirFor(oldRoot, first.token).slice(oldRoot.length))).toBe(true);
  });

  it('③ token 不可读（store 半截 JSON）：新铸 token ⇒ state 目录身份**确实换**（有意隔离，如实记录）', () => {
    const dataRoot = dataRootOf(OLD_VOLUME);
    const first = ensureLocalGatewayToken({ userDataDir: dataRoot });
    const oldStateDir = portableStateDirFor(dataRoot, first.token);

    // 掉电把 store 写坏（半截 JSON）
    writeFileSync(authStorePath(dataRoot), '{"formatVersion":1,"token":"abc', 'utf8');

    const second = ensureLocalGatewayToken({ userDataDir: dataRoot });

    expect(second.created, 'store 读不出来 ⇒ 只能新铸').toBe(true);
    expect(second.token).not.toBe(first.token);
    expect(
      portableStateDirFor(dataRoot, second.token),
      '新 token ⇒ 新 state 身份目录（旧目录**不删**，只是不再指向）',
    ).not.toBe(oldStateDir);
  });

  it('④ 老 token 可被 adopt 接管（升级路径）：config/state 里那份仍然认得出', () => {
    const dataRoot = dataRootOf(OLD_VOLUME);
    // store 还不存在，但旧的 token 在别处（老安装的 state 文件 / 客户端 config）
    const result = ensureLocalGatewayToken({ userDataDir: dataRoot, adopt: () => 'legacy-token-abc' });

    expect(result.token).toBe('legacy-token-abc');
    expect(result.created).toBe(true);
    expect(readAuthStore(dataRoot)?.token, '接管后 store 就是真相源').toBe('legacy-token-abc');

    // 二跑：不再接管，稳定复用
    const again = ensureLocalGatewayToken({ userDataDir: dataRoot, adopt: () => 'should-not-be-used' });
    expect(again.token).toBe('legacy-token-abc');
    expect(again.created).toBe(false);
  });

  it('⑤ adopt 自己抛（config 读不了）不许把启动带走 —— 生成新的仍能起来', () => {
    const dataRoot = dataRootOf(NEW_VOLUME);

    const result = ensureLocalGatewayToken({
      userDataDir: dataRoot,
      adopt: () => {
        throw new Error('config unreadable');
      },
    });

    expect(result.token).toBeTruthy();
    expect(readAuthStore(dataRoot)?.token).toBe(result.token);
  });

  it('⑥ 任务/数据库/附件的家是**工作区**：token 轮换与它无关（路径里不含 token）', () => {
    const dataRoot = dataRootOf(OLD_VOLUME);
    const a = ensureLocalGatewayToken({ userDataDir: dataRoot });
    writeFileSync(authStorePath(dataRoot), 'broken', 'utf8');
    const b = ensureLocalGatewayToken({ userDataDir: dataRoot });
    expect(b.token).not.toBe(a.token);

    // 工作区 = `<卷根>\荣盈魔方工作区`（见 workspace/portable.ts），与 token 无关
    expect(join(OLD_VOLUME, '荣盈魔方工作区').includes(b.token), '工作区路径不许被 token 染色').toBe(false);
  });
});
