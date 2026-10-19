/**
 * `saveArtifact*` 的**真索引**探针（2026-10-07 体检 P2-2 / P2-4）。
 *
 * 为什么必须这一档：唯一约束的语义只有在**真的唯一索引 + 真的磁盘**上才成立 ——
 * 单测把 drizzle 和 fs 都 mock 了，"uniqueFileNameIn 只看磁盘不看库"这条致命细节
 * 正好落在 mock 的缝里（`artifact-save.test.ts` 用的是 mock DB_ERROR，验不了它）。
 *
 * 跑法同 reconcile 探针：vite 打包 → `ELECTRON_RUN_AS_NODE` 的 electron 跑真主进程模块
 * （`better-sqlite3` 是按 Electron ABI 重建的），结果走 stdout 一行 JSON。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import JSZip from 'jszip';
import { closeDatabase, getSqlite, initDatabase } from '../../src/main/db/index.js';
import { findReplayArtifact, saveArtifact, saveArtifactFromBuffer } from '../../src/main/artifact/save.js';

const [, , workspacePath, scenario] = process.argv;

function seedTaskAndMessage(taskId = 'task-1', messageId = 'msg-1'): void {
  const now = new Date().toISOString();
  getSqlite()!
    .prepare(
      `INSERT INTO tasks
       (id, session_key, session_id, title, status, created_at, updated_at, tags, artifact_dir, gateway_id)
       VALUES (?, ?, '', '', 'active', ?, ?, '[]', '', '')`,
    )
    .run(taskId, `session-${taskId}`, now, now);
  seedMessage(taskId, messageId);
}

/** 只补一条 assistant 消息（跨消息续写场景：同一 task 里第二条 assistant 消息）。 */
let messageSeq = 0;
function seedMessage(taskId: string, messageId: string): void {
  // messages_dedup 是 (task_id, session_key, role, timestamp) —— 同一毫秒会撞，故逐条递增。
  const stamp = new Date(Date.now() + messageSeq++).toISOString();
  getSqlite()!
    .prepare(
      `INSERT INTO messages (id, task_id, role, content, timestamp, session_key)
       VALUES (?, ?, 'assistant', 'done', ?, ?)`,
    )
    .run(messageId, taskId, stamp, `session-${taskId}`);
}

/** 最小但**真实有效**的 pptx（过 `verifyArtifactBuffer` 的 pptx 判据）。 */
async function validPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>');
  zip.file('ppt/presentation.xml', '<?xml version="1.0"?><p:presentation/>');
  zip.file('ppt/slides/slide1.xml', '<?xml version="1.0"?><p:sld/>');
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

/** 把一次调用收成可断言的结论（成功给 id；失败给错误名+消息）。 */
async function capture(
  run: () => Promise<unknown>,
): Promise<{ ok: true; id: string } | { ok: false; name: string; message: string }> {
  try {
    const artifact = (await run()) as { id?: unknown };
    return { ok: true, id: String(artifact.id) };
  } catch (error) {
    return {
      ok: false,
      name: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

const artifactRows = (): Array<Record<string, unknown>> =>
  getSqlite()!.prepare('SELECT id, name, local_path, source_key FROM artifacts ORDER BY created_at, id').all() as Array<
    Record<string, unknown>
  >;

/**
 * ⭐ BUG-058②（2026-10-13 计划 P2，真 SQLite + 真文件系统）：
 * `saveArtifact`（**源文件那条路**）的同键重放 —— 源被清理后必须仍然返回既有行；
 * 目标缺/坏、异键、坏新源三种形状都必须"不伪成功、不误删"。
 *
 * 红例序列（计划表逐条）：
 *  ① 首次保存 → 删源 → 同键重放：同 id、单行、无复制；
 *  ② 异键（同 message 不同 sourceKey，源已删）⇒ 不豁免；
 *  ③ 坏新源 ⇒ 不落盘、不删原有效行；
 *  ④ 目标也缺 / 目标被改坏（源仍缺）⇒ 如实失败，不重登记。
 */
async function saveSourceReplayScenario(): Promise<Record<string, unknown>> {
  initDatabase(workspacePath);
  seedTaskAndMessage();
  const taskDir = join(workspacePath, 'task-1');
  const sourceDir = join(workspacePath, 'sources');
  mkdirSync(sourceDir, { recursive: true });
  const pptx = await validPptx();
  const source = join(sourceDir, 'deck.pptx');
  writeFileSync(source, pptx);
  const params = {
    workspacePath,
    taskId: 'task-1',
    messageId: 'msg-1',
    sourcePath: source,
    sourceKey: 'docgen:pptx:hash-1',
  };

  const first = await saveArtifact(params);
  rmSync(source, { force: true }); // 源被清理（slidegen-cli 落位路现场）
  const replay = await saveArtifact(params); // ← 旧实现：先读源做完整性门 ⇒ 整轮 failed
  const filesAfterReplay = readdirSync(taskDir).sort();
  const replaySameBytes = readFileSync(join(taskDir, replay.name)).equals(pptx);
  const rowsAfterReplay = artifactRows();

  // ② 异键：同 message、不同 sourceKey（没有对应行）⇒ 必须照走完整性门（源已删 ⇒ 失败）。
  const foreignKey = await capture(() => saveArtifact({ ...params, sourceKey: 'docgen:pptx:hash-2' }));

  // ③ 坏新源（另一条 key）：不落盘、不删原有效行。
  const badSource = join(sourceDir, 'bad.pptx');
  writeFileSync(badSource, 'PK broken, not a zip');
  const badNewSource = await capture(() =>
    saveArtifact({ ...params, sourcePath: badSource, sourceKey: 'docgen:pptx:hash-3' }),
  );
  const afterBadNewSource = {
    rows: artifactRows(),
    files: readdirSync(taskDir).sort(),
    firstFileStillValid: readFileSync(join(taskDir, first.name)).equals(pptx),
  };

  // ④ 目标也缺：源仍缺 ⇒ 如实失败（不伪成功、不重登记）。
  const targetFile = join(taskDir, first.name);
  rmSync(targetFile, { force: true });
  const targetMissing = await capture(() => saveArtifact(params));

  // ⑤ 目标被改坏（源仍缺）⇒ 不当重放返回，如实失败。
  writeFileSync(targetFile, 'PK broken, not a zip');
  const targetDamaged = await capture(() => saveArtifact(params));

  // ⑥ 只读探测出口本身（`findReplayArtifact`，视频/付费路径在**花钱之前**用它）：
  //    目标坏 ⇒ null（不许拿坏文件冒充"已交付"）；目标恢复有效 ⇒ 返回既有行；异键 ⇒ null。
  const findReplay = (messageId: string, sourceKey: string) => {
    const found = findReplayArtifact(messageId, sourceKey);
    return found ? { id: found.id, name: found.name } : null;
  };
  const replayProbeDamaged = findReplay('msg-1', 'docgen:pptx:hash-1');
  writeFileSync(targetFile, pptx);
  const replayProbeIntact = findReplay('msg-1', 'docgen:pptx:hash-1');
  const replayProbeForeign = findReplay('msg-1', 'docgen:pptx:hash-2');

  return {
    first,
    replay,
    filesAfterReplay,
    replaySameBytes,
    rowsAfterReplay,
    foreignKey,
    badNewSource,
    afterBadNewSource,
    targetMissing,
    targetDamaged,
    replayProbeDamaged,
    replayProbeIntact,
    replayProbeForeign,
    rowsAfterAll: artifactRows(),
    filesFinal: readdirSync(taskDir).sort(),
  };
}

/**
 * ⭐ T20（2026-10-16 本地全量执行 · Owner D）：**跨 assistant 消息的同源去重**。
 *
 * 现场线索：`finish_reason` 续写会创建**新的 assistant 消息（新 messageId）**；若同一套
 * 牌在两条消息里各出现一次（续写把同一份 deck 再吐一遍 / 同一任务内重放），则登记层的
 * 两条唯一约束**都不触发**：
 *   · `artifacts_source_dedup(message_id, source_key)` —— message_id 不同 ⇒ 不撞；
 *   · `artifacts_task_local_path(task_id, root, local_path)` —— `uniqueFileNameIn`
 *     **只看磁盘库不看库**，第一份文件还在 ⇒ 第二份退到 `<名>-<rand>.pptx` ⇒ local_path 不同 ⇒ 不撞。
 * ⇒ 同一套牌被登记两次、落两份文件。这是本任务必须证明的**反例**。
 *
 * 期望（修好后）：同 task 同 sourceKey 内容 == 同一份产物 ⇒ 只登记一次、只落一份文件。
 */
async function saveCrossMessageReplayScenario(): Promise<Record<string, unknown>> {
  initDatabase(workspacePath);
  seedTaskAndMessage('task-1', 'msg-1');
  seedMessage('task-1', 'msg-2'); // 续写产生的第二条 assistant 消息
  seedMessage('task-1', 'msg-3'); // 改稿（新内容）所在的第三条消息
  const taskDir = join(workspacePath, 'task-1');
  const deck = await validPptx();
  const base = {
    workspacePath,
    taskId: 'task-1',
    fileName: '季度汇报.pptx',
    artifactType: 'file' as const,
    buffer: deck,
    sourceKey: 'slidegen:abcdef0123456789',
  };

  const first = await saveArtifactFromBuffer({ ...base, messageId: 'msg-1' });
  const continuation = await saveArtifactFromBuffer({ ...base, messageId: 'msg-2' });

  const rows = getSqlite()!
    .prepare('SELECT id, name, local_path, message_id, source_key FROM artifacts ORDER BY created_at, id')
    .all() as Array<Record<string, unknown>>;
  const files = readdirSync(taskDir).sort();

  // 再验一条：新消息里**不同内容**（新版 deck，改稿）必须照常产新版（不能被跨消息去重误伤）。
  const revised = await saveArtifactFromBuffer({
    ...base,
    messageId: 'msg-3',
    buffer: Buffer.concat([deck, Buffer.from('<!--revised-->')]),
    sourceKey: 'slidegen:9999999999999999',
  });

  return {
    first,
    continuation,
    rows,
    files,
    rowCount: rows.length,
    fileCount: files.length,
    revised: { id: revised.id, name: revised.name },
    filesAfterRevised: readdirSync(taskDir).sort(),
  };
}

async function main(): Promise<Record<string, unknown>> {
  if (scenario === 'save-source-replay') return saveSourceReplayScenario();
  if (scenario === 'save-cross-message-replay') return saveCrossMessageReplayScenario();

  if (scenario !== 'save-index-semantics') throw new Error(`unknown scenario: ${scenario}`);

  initDatabase(workspacePath);
  seedTaskAndMessage();
  const taskDir = join(workspacePath, 'task-1');
  const base = {
    workspacePath,
    taskId: 'task-1',
    messageId: 'msg-1',
    fileName: 'report.md',
    artifactType: 'file' as const,
  };

  // ① 重放：同一条消息 + 同一份内容（同 sourceKey）被处理两次（docgen/slidegen/htmlgen 的
  //    "同 message 重放"就是这条；auto-extract 同源）。
  const first = await saveArtifactFromBuffer({ ...base, buffer: Buffer.from('first'), sourceKey: 'docgen:md:hash1' });
  const replay = await saveArtifactFromBuffer({ ...base, buffer: Buffer.from('first'), sourceKey: 'docgen:md:hash1' });
  const afterReplay = {
    fileCount: readdirSync(taskDir).filter((name) => name.startsWith('report')).length,
    rows: getSqlite()!.prepare('SELECT id, local_path FROM artifacts ORDER BY created_at').all(),
  };

  // ② 名字被"有行无文件"的旧行占着（P2-2 原始场景）：外部删掉文件，再存一份同名的新文件。
  //    旧实现在这里必定：uniqueFileNameIn 复用同名 → INSERT 撞 artifacts_task_local_path
  //    → catch 里 unlink 掉**刚写的那份好文件** → 抛错（重试同败，名字被永久毒化）。
  rmSync(join(taskDir, first.name), { force: true });
  const fileGoneBeforeSecondSave = existsSync(join(taskDir, first.name));
  const revived = await saveArtifactFromBuffer({ ...base, buffer: Buffer.from('second-pass') });

  const rows = getSqlite()!.prepare('SELECT id, name, local_path, size FROM artifacts ORDER BY created_at, id').all();
  return {
    first,
    replay,
    afterReplay,
    fileGoneBeforeSecondSave,
    revived,
    rows,
    files: readdirSync(taskDir).sort(),
    revivedContent: readFileSync(join(taskDir, 'report.md'), 'utf8'),
  };
}

void main().then(
  (result) => {
    closeDatabase();
    process.stdout.write(`ARTIFACT_PROBE_RESULT=${JSON.stringify(result)}\n`);
  },
  (error: unknown) => {
    closeDatabase();
    console.error(error);
    process.exitCode = 1;
  },
);
