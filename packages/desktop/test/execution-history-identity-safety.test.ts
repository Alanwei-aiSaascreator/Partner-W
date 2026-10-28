import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecutionEvent } from '@clawwork/core';
import { createExecutionHistory, type ExecutionHistoryStore } from '../src/main/execution/history';

/**
 * 2026-10-14 五小时收口·第二轮（V owner）· **身份映射安全**（Codex 第二轮确定反例）。
 *
 * - V-ID-1：旧实现用 UTF-8 base64url 直接做物理路径组件。可打印 ASCII 反例
 *   `agent:aaa:clawwork:task:<uuid>` → `YWFh…` 与 `agent:aaG:…` → `YWFH…` **仅差大小写**；
 *   Windows 默认大小写不敏感文件系统把两者折叠成同一目录 ⇒ 同 runId 时 readRun
 *   无法区分、listRuns 会串列另一 session 的 run。
 * - V-ID-2：`isValidIdentity` 只数 JS 字符串长度（180）。`'中'.repeat(180)` 长度 180、
 *   UTF-8 540 字节、旧编码 720 字符 ⇒ 物理组件超限，写盘失败被 recordDiskError 闩锁，
 *   该 writer 之后**全部**停写。
 *
 * 修复口径（审查建议 1–4）：物理组件 = Node 内置 sha256 小写 hex（定长 64、单大小写）；
 * 文件首行 = 版本化身份包络（原 workspaceKey/sessionKey/runId）；读取与列举**先验包络**
 * 再解析事件，不凭路径或正文 runId 推定 session；不匹配 ⇒ 拒收 + 显式诊断。
 * 旧实现是未发布特性 ⇒ **不做旧文件兼容读取**（诚实边界见交付报告）。
 */

function makeRecord(over: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return {
    schemaVersion: 1,
    eventId: over.eventId ?? 'f1#0',
    seq: over.seq ?? 0,
    runId: 'run-a',
    taskId: 'task-1',
    source: {
      gatewayId: 'gw-1',
      channel: 'main',
      nativeSessionKey: 'agent:main:clawwork:task:task-1',
      nativeRunId: 'run-native-a',
      event: 'agent',
      stream: 'tool',
      derivedIndex: 0,
    },
    evidence: 'observed',
    receivedAt: 1_000,
    type: 'step.dispatched',
    payload: { toolCallId: 'tc-1', name: 'read', phase: 'update' },
    ...over,
  } as ExecutionEvent;
}

type InstrumentedStore = ExecutionHistoryStore & {
  diagnostics: Array<Record<string, unknown>>;
};

const WORKSPACE_KEY = 'ws-1';

function makeStore(rootDir: string, over: Record<string, unknown> = {}): InstrumentedStore {
  const diagnostics: Array<Record<string, unknown>> = [];
  const store = createExecutionHistory({
    rootDir,
    workspaceKey: WORKSPACE_KEY,
    maxQueueEntries: 8,
    maxQueueBytes: 16 * 1024,
    maxEntryBytes: 4096,
    maxRunBytes: 8 * 1024,
    maxDirBytes: 1024 * 1024,
    retentionDays: 0,
    flushIntervalMs: 3_600_000,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic as unknown as Record<string, unknown>),
    ...over,
  });
  return Object.assign(store, { diagnostics });
}

function listAllFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out;
}

function ndjsonFiles(root: string): string[] {
  return listAllFiles(root).filter((f) => f.endsWith('.ndjson'));
}

function sessionDirs(root: string): string[] {
  try {
    return readdirSync(join(root, WORKSPACE_KEY), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** 定长 64、单大小写输出（修复后物理组件合同）。 */
function isFixedLengthSingleCaseComponent(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name) && (name === name.toLowerCase() || name === name.toUpperCase());
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const CASE_UUID = '11111111-1111-4111-8111-111111111111';
const MAIN_UUID = '22222222-2222-4222-8222-222222222222';

describe('V-ID-1 · 大小写折叠反例：aaa / aaG 两个 session 必须物理隔离', () => {
  it('⭐ 同 runId 互不可读；不同 runId 互不出现在 listRuns；物理目录折叠后仍不同名', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-casefold-'));
    const h = makeStore(root);
    // 反例身份：仅 agent 段大小写不同（`aaa` vs `aaG`），文件系统会把编码折叠
    const keyLower = `agent:aaa:clawwork:task:${CASE_UUID}`;
    const keyUpper = `agent:aaG:clawwork:task:${CASE_UUID}`;
    expect(keyLower.toLowerCase()).not.toBe(keyUpper.toLowerCase()); // 业务身份本身不同

    // ① 同 runId：两个 session 各写各的证据
    h.append(keyLower, [makeRecord({ runId: 'run-shared', eventId: 'lower#0' })]);
    h.append(keyUpper, [makeRecord({ runId: 'run-shared', eventId: 'upper#0' })]);
    // ② 不同 runId：若目录被折叠，listRuns 会串列对方
    h.append(keyLower, [makeRecord({ runId: 'run-only-lower', eventId: 'lower#1' })]);
    h.append(keyUpper, [makeRecord({ runId: 'run-only-upper', eventId: 'upper#1' })]);
    await h.flush();

    expect(
      (await h.readRun(keyLower, 'run-shared')).records.map((r) => r.eventId),
      'aaa 的 run 不得混入 aaG 的记录',
    ).toEqual(['lower#0']);
    expect(
      (await h.readRun(keyUpper, 'run-shared')).records.map((r) => r.eventId),
      'aaG 的 run 不得混入 aaa 的记录',
    ).toEqual(['upper#0']);

    const listedLower = (await h.listRuns(keyLower)).slice().sort();
    const listedUpper = (await h.listRuns(keyUpper)).slice().sort();
    expect(listedLower).toEqual(['run-only-lower', 'run-shared']);
    expect(listedUpper).toEqual(['run-only-upper', 'run-shared']);
    expect(listedLower, 'aaa 的列举不得出现 aaG 专有的 run').not.toContain('run-only-upper');
    expect(listedUpper, 'aaG 的列举不得出现 aaa 专有的 run').not.toContain('run-only-lower');

    // ③ 物理层：两个 session = 两个目录；组件定长 64 且大小写折叠后仍不同名
    const dirs = sessionDirs(root);
    expect(dirs, '两个 session 必须是两个物理目录').toHaveLength(2);
    expect(
      new Set(dirs.map((name) => name.toLowerCase())).size,
      '物理组件在大小写不敏感文件系统上不得折叠为同一名字',
    ).toBe(2);
    expect(
      dirs.every(isFixedLengthSingleCaseComponent),
      `物理组件必须是定长 64 的单大小写哈希（实际 ${JSON.stringify(dirs)}）`,
    ).toBe(true);
    h.close();
  });
});

describe('V-ID-2 · Unicode 长身份：写读 roundtrip 且 writer 不被闩锁', () => {
  it("⭐ '中'.repeat(180)：写+读成功、无 write-error、后续条目仍能落盘", async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-longid-'));
    const longKey = '中'.repeat(180);
    expect(longKey.length).toBe(180); // 旧判据（JS 字符数）会放过它
    expect(Buffer.byteLength(longKey, 'utf8')).toBe(540); // 真实字节远超字符数

    const h = makeStore(root);
    h.append(longKey, [makeRecord({ runId: 'run-long', eventId: 'long#0' })]);
    await h.flush();

    expect(
      (await h.readRun(longKey, 'run-long')).records.map((r) => r.eventId),
      '长 Unicode 身份必须能写能读（不 ENAMETOOLONG）',
    ).toEqual(['long#0']);
    expect(
      h.diagnostics.filter((d) => d.reason === 'write-error'),
      '不得出现写盘错误（旧实现此处闩锁）',
    ).toEqual([]);

    // writer 未被锁死：另一 session 的条目仍然落盘
    const mainKey = `agent:main:clawwork:task:${MAIN_UUID}`;
    h.append(mainKey, [makeRecord({ runId: MAIN_UUID, eventId: 'after#0' })]);
    await h.flush();
    expect(
      (await h.readRun(mainKey, MAIN_UUID)).records.map((r) => r.eventId),
      '闩锁后后续条目会整批消失；修复后必须照常落盘',
    ).toEqual(['after#0']);

    // 物理组件不随身份字节增长（定长 64）
    const dirs = sessionDirs(root);
    expect(dirs).toHaveLength(2);
    expect(dirs.every(isFixedLengthSingleCaseComponent)).toBe(true);

    // 显式超长（>4096 字节）仍被合理拒收：诊断 + 不落盘
    const oversize = 'x'.repeat(4097);
    h.append(oversize, [makeRecord({ runId: 'run-oversize', eventId: 'os#0' })]);
    expect(
      h.diagnostics.some((d) => d.reason === 'invalid-key'),
      '超长身份必须走 invalid-key 诊断（不静默）',
    ).toBe(true);
    await h.flush();
    expect((await h.readRun(oversize, 'run-oversize')).records).toEqual([]);
    h.close();
  });
});

describe('V-ID-2b · 身份包络：读取/列举先验原身份，不匹配一律拒收', () => {
  it('⭐ 包络身份被篡改（sessionKey 不符）⇒ readRun 拒收、listRuns 不列举、留诊断', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-envelope-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord({ runId: 'run-a', eventId: 'legit#0' })]);
    await h.flush();
    const [file] = ndjsonFiles(root);
    expect(file).toBeTruthy();

    // 篡改：首行身份包络里换成别人的 sessionKey，正文 runId 保持"匹配"
    const foreignEnvelope = {
      __executionHistoryEnvelope: 1,
      workspaceKey: WORKSPACE_KEY,
      sessionKey: 's2',
      runId: 'run-a',
      createdAt: 1_000,
    };
    writeFileSync(
      file,
      `${JSON.stringify(foreignEnvelope)}\n${JSON.stringify(makeRecord({ runId: 'run-a', eventId: 'alien#0' }))}\n`,
    );

    expect((await h.readRun('s1', 'run-a')).records, '包络身份不符 ⇒ 拒收全部正文（不能凭正文 runId 冒充）').toEqual(
      [],
    );
    expect(await h.listRuns('s1'), '身份无法核验的文件不得出现在 listRuns').toEqual([]);
    expect(
      h.diagnostics.some((d) => d.reason === 'identity-mismatch'),
      '拒收必须显式留诊断',
    ).toBe(true);
    h.close();
  });

  it('⭐ 无身份包络的裸事件文件（旧格式/外来文件）⇒ 拒收，不冒充 session 证据', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-bare-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord({ runId: 'run-a', eventId: 'legit#0' })]);
    await h.flush();
    const [file] = ndjsonFiles(root);

    // 覆盖为"只有事件、没有包络"的文件：runId 与请求完全一致，但身份不可核验
    writeFileSync(file, `${JSON.stringify(makeRecord({ runId: 'run-a', eventId: 'raw#0' }))}\n`);

    expect((await h.readRun('s1', 'run-a')).records).toEqual([]);
    expect(await h.listRuns('s1')).toEqual([]);
    h.close();
  });

  it('⭐ 包络 workspaceKey 不符 ⇒ 拒收（跨 workspace 伪证不成立）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-ws-envelope-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord({ runId: 'run-a', eventId: 'legit#0' })]);
    await h.flush();
    const [file] = ndjsonFiles(root);

    writeFileSync(
      file,
      `${JSON.stringify({
        __executionHistoryEnvelope: 1,
        workspaceKey: 'ws-other',
        sessionKey: 's1',
        runId: 'run-a',
        createdAt: 1_000,
      })}\n${JSON.stringify(makeRecord({ runId: 'run-a', eventId: 'alien#0' }))}\n`,
    );

    expect((await h.readRun('s1', 'run-a')).records).toEqual([]);
    expect(await h.listRuns('s1')).toEqual([]);
    h.close();
  });
});

describe('V-ID 回归护栏 · 正常原生键与既有合同不退化', () => {
  it('⭐ main + UUID 键：写→读→重建实例→读 全部一致', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-main-uuid-'));
    const sessionKey = `agent:main:clawwork:task:${MAIN_UUID}`;
    const h = makeStore(root);
    h.append(sessionKey, [makeRecord({ runId: MAIN_UUID, eventId: 'm#0' })]);
    await h.flush();
    expect((await h.readRun(sessionKey, MAIN_UUID)).records.map((r) => r.eventId)).toEqual(['m#0']);
    expect(await h.listRuns(sessionKey)).toEqual([MAIN_UUID]);
    await h.close();

    // 重启（重建实例）后仍可读：身份包络在盘上可核验
    const h2 = makeStore(root);
    expect((await h2.readRun(sessionKey, MAIN_UUID)).records.map((r) => r.eventId)).toEqual(['m#0']);
    expect(await h2.listRuns(sessionKey)).toEqual([MAIN_UUID]);
    h2.close();
  });

  it('⭐ listRuns 最新在前保持（按 mtime 元数据，不依赖 readdir 顺序）', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-latest-guard-'));
    const h = makeStore(root);
    h.append('s1', [makeRecord({ runId: 'run-old', eventId: 'o#0' })]);
    await h.flush();
    await sleep(8);
    h.append('s1', [makeRecord({ runId: 'run-new', eventId: 'n#0' })]);
    await h.flush();
    expect(await h.listRuns('s1')).toEqual(['run-new', 'run-old']);
    h.close();
  });
});

/**
 * 2026-10-14 第三轮 · V-final（Codex 第二轮残留合同边界）· **包络读头预算**。
 *
 * 残留边界（审查原文）：`isValidIdentity` 允许双引号，session/run 各允许 4096 UTF-8 字节；
 * `JSON.stringify` 把每个 `"` 转义成 `\"`。两者都是 4096 个双引号时，首行包络 16504B
 * 超过 `ENVELOPE_HEAD_BYTES = 16 KiB`：`readHeadLine` 截断 ⇒ `listRuns` 跳过该文件、
 * 重启后的 writer 也核验不了自己写出的文件；而 `readRun` 全文件读又能读到 —— list/read 分裂。
 *
 * 修复口径：**按实际序列化包络字节**（实际 workspaceKey/sessionKey/runId + 固定字段 +
 * createdAt 最大宽度余量）统一写入判据与读头预算，超预算 ⇒ 写入前明确拒绝该条 + 诊断
 * （专属 reason，非 I/O 错误、不闩锁 writer、不影响后续条目）；读侧同一预算判定一致。
 * 旧 base64/无包络文件维持原状（不做迁移）——身份无法核验即拒收，本档不改该边界。
 */
describe('V-final · 包络读头预算：超预算身份写入前拒收，listRuns/readRun 同一判据', () => {
  /** 审查反例身份：每字段 4096 个双引号（身份字节数在 IDENTITY_MAX_BYTES 上限内）。 */
  const QUOTE_BURST = '"'.repeat(4096);

  function componentOf(identity: string): string {
    return createHash('sha256').update(identity, 'utf8').digest('hex');
  }

  /**
   * 包络预算专用 store：把队列/单条/单 run/目录四档预算**放大**，避免它们先于包络预算
   * 生效（引号身份本身会把记录正文撑大，默认的 4096 单条预算会先拒收，掩盖被测判据）。
   */
  function makeEnvelopeStore(rootDir: string): InstrumentedStore {
    return makeStore(rootDir, {
      maxQueueBytes: 1024 * 1024,
      maxEntryBytes: 256 * 1024,
      maxRunBytes: 1024 * 1024,
      maxDirBytes: 16 * 1024 * 1024,
    });
  }

  it('⭐ 4096 个双引号（转义后包络 > 16 KiB 读头预算）⇒ 写入前拒绝该条：零文件、留诊断、writer 不闩锁', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-quote-burst-'));
    expect(Buffer.byteLength(QUOTE_BURST, 'utf8')).toBe(4096); // 身份本身在 4096 字节上限内
    // 事实基线（逐字节算出来的）：这种身份的真实序列化包络超过读头预算
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({
        __executionHistoryEnvelope: 1,
        workspaceKey: WORKSPACE_KEY,
        sessionKey: QUOTE_BURST,
        runId: QUOTE_BURST,
        createdAt: Date.now(),
      }),
      'utf8',
    );
    expect(envelopeBytes).toBeGreaterThan(16 * 1024);

    const h = makeEnvelopeStore(root);
    h.append(QUOTE_BURST, [makeRecord({ runId: QUOTE_BURST, eventId: 'q#0' })]);
    await h.flush();

    // ① 超预算身份不得落盘（写出自己 listRuns 无法识别的文件就是本缺陷）
    expect(ndjsonFiles(root), '超预算身份不得产生任何 ndjson 文件').toEqual([]);
    // ② 拒绝必须显式（专属诊断），不是静默丢弃
    expect(
      h.diagnostics.some((d) => d.reason === 'identity-envelope-budget'),
      '超预算身份必须走显式诊断（不静默）',
    ).toBe(true);
    // ③ 不是 I/O 错误：不得闩锁 writer（recordDiskError 语义不变）
    expect(h.diagnostics.filter((d) => d.reason === 'write-error')).toEqual([]);

    // ④ listRuns / readRun 对同一预算判定一致（都不返回它）
    expect(await h.listRuns(QUOTE_BURST)).toEqual([]);
    expect((await h.readRun(QUOTE_BURST, QUOTE_BURST)).records).toEqual([]);

    // ⑤ 不影响后续条目：正常身份照常写、读、列举
    const mainKey = `agent:main:clawwork:task:${MAIN_UUID}`;
    h.append(mainKey, [makeRecord({ runId: MAIN_UUID, eventId: 'after#0' })]);
    await h.flush();
    expect((await h.readRun(mainKey, MAIN_UUID)).records.map((r) => r.eventId)).toEqual(['after#0']);
    expect(await h.listRuns(mainKey)).toEqual([MAIN_UUID]);

    // ⑥ 重启后仍然一致：盘上不存在任何"写得出去、读不出来"的文件
    await h.close();
    const h2 = makeEnvelopeStore(root);
    expect(await h2.listRuns(QUOTE_BURST)).toEqual([]);
    expect((await h2.readRun(QUOTE_BURST, QUOTE_BURST)).records).toEqual([]);
    expect((await h2.readRun(mainKey, MAIN_UUID)).records.map((r) => r.eventId)).toEqual(['after#0']);
    h2.close();
  });

  it('⭐ 盘上既存的超预算包络文件（修复前构建写出）⇒ listRuns 与 readRun 同一判据：都拒收，不分裂', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-legacy-oversize-'));
    const h = makeEnvelopeStore(root);
    // 按 writer 的物理路径公式手工放一个"修复前写出的"文件：首行 = 超预算包络，正文 runId 一致
    const dir = join(root, WORKSPACE_KEY, componentOf(QUOTE_BURST));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${componentOf(QUOTE_BURST)}.ndjson`);
    writeFileSync(
      file,
      `${JSON.stringify({
        __executionHistoryEnvelope: 1,
        workspaceKey: WORKSPACE_KEY,
        sessionKey: QUOTE_BURST,
        runId: QUOTE_BURST,
        createdAt: 1_000,
      })}\n${JSON.stringify(makeRecord({ runId: QUOTE_BURST, eventId: 'x#0' }))}\n`,
    );
    expect(Buffer.byteLength(readFileSync(file, 'utf8').split('\n')[0], 'utf8')).toBeGreaterThan(16 * 1024);

    // listRuns 的有界读头截断 ⇒ 跳过；readRun 必须同一预算拒收（旧实现此处返回整份正文 = 分裂）
    expect(await h.listRuns(QUOTE_BURST), 'listRuns 不列举读不出来头的文件').toEqual([]);
    expect(
      (await h.readRun(QUOTE_BURST, QUOTE_BURST)).records,
      'readRun 不得在 listRuns 看不见的文件上返回证词（同一预算判据）',
    ).toEqual([]);
    expect(
      h.diagnostics.some((d) => d.reason === 'identity-mismatch'),
      '读侧拒收同走既有诊断出口',
    ).toBe(true);
    h.close();
  });

  it('⭐ 预算边界按实际序列化字节：接近预算（4000 引号/字段）可写可读可列举，超预算（4096）拒收', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-quote-edge-'));
    // 双字段各 4000 引号：转义后 8000B×2 + 固定字段 ≈ 16.1 KiB（仍严格小于 16 KiB 预算）
    const nearBudget = '"'.repeat(4000);
    const nearRun = '"'.repeat(4000);
    const h = makeEnvelopeStore(root);
    h.append(nearBudget, [makeRecord({ runId: nearRun, eventId: 'near#0' })]);
    await h.flush();

    const [file] = ndjsonFiles(root);
    expect(file, '接近预算的身份仍应落盘（不许一刀切拒收）').toBeTruthy();
    const headLine = readFileSync(file, 'utf8').split('\n')[0];
    expect(Buffer.byteLength(headLine, 'utf8'), '落盘首行必须在有界读头内完整可读').toBeLessThan(16 * 1024);

    expect((await h.readRun(nearBudget, nearRun)).records.map((r) => r.eventId)).toEqual(['near#0']);
    expect(await h.listRuns(nearBudget)).toEqual([nearRun]);
    await h.close();

    // 重启后：同一文件的 listRuns/readRun 一致（有界读头拿得到完整包络）
    const h2 = makeEnvelopeStore(root);
    expect((await h2.readRun(nearBudget, nearRun)).records.map((r) => r.eventId)).toEqual(['near#0']);
    expect(await h2.listRuns(nearBudget)).toEqual([nearRun]);

    // 同一实例内再写超预算身份（session/run 双字段都是 4096 引号）：拒收，且不影响上面这条 run
    h2.append(QUOTE_BURST, [makeRecord({ runId: QUOTE_BURST, eventId: 'burst#0' })]);
    await h2.flush();
    expect(ndjsonFiles(root), '超预算身份仍不得落盘（只有 near 那一个文件）').toHaveLength(1);
    expect((await h2.readRun(nearBudget, nearRun)).records.map((r) => r.eventId)).toEqual(['near#0']);

    // 判据是**逐字节**（实际序列化包络），不是"见到引号就拒"：只有 session 是 4096 引号、
    // runId 很短时包络仍在预算内 ⇒ 照常可写可读可列举。
    const singleFieldBurst = '"'.repeat(4096);
    h2.append(singleFieldBurst, [makeRecord({ runId: 'run-short', eventId: 'sf#0' })]);
    await h2.flush();
    expect(await h2.listRuns(singleFieldBurst)).toEqual(['run-short']);
    expect((await h2.readRun(singleFieldBurst, 'run-short')).records.map((r) => r.eventId)).toEqual(['sf#0']);
    h2.close();
  });

  it('⭐ 含少量引号的正常身份（引号本身不是非法字符）写→读→列举→重启一致', async () => {
    const root = mkdtempSync(join(tmpdir(), 'exec-history-quote-normal-'));
    const sessionKey = `agent:main:"quoted":clawwork:task:${MAIN_UUID}`;
    const runId = 'run-"q"-1';
    const h = makeEnvelopeStore(root);
    h.append(sessionKey, [makeRecord({ runId, eventId: 'q#1' })]);
    await h.flush();
    expect(h.diagnostics, '正常身份不得产生任何诊断').toEqual([]);
    expect((await h.readRun(sessionKey, runId)).records.map((r) => r.eventId)).toEqual(['q#1']);
    expect(await h.listRuns(sessionKey)).toEqual([runId]);
    await h.close();

    const h2 = makeEnvelopeStore(root);
    expect((await h2.readRun(sessionKey, runId)).records.map((r) => r.eventId)).toEqual(['q#1']);
    expect(await h2.listRuns(sessionKey)).toEqual([runId]);
    h2.close();
  });
});
