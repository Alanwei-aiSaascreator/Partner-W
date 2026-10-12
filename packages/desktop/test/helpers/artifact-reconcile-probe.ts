import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDatabase, getSqlite, initDatabase } from '../../src/main/db/index.js';
import { captureTaskArtifactBaseline, reconcileTaskArtifacts } from '../../src/main/artifact/reconcile.js';
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { DB_FILE_NAME } from '@clawwork/shared';
import { makeMp4Buffer } from './make-mp4.js';
import type { ArtifactRootKind } from '@clawwork/shared';

const [, , workspacePath, scenario] = process.argv;

/**
 * 最小**合法** PPTX（M1 登记前置门的夹具，2026-10-06）。
 *
 * ⚠️ 为什么必须换成真包：`verify.ts` 的门现在要求 `.pptx` 是结构完整的 ZIP
 * （中央目录 + `[Content_Types].xml` + `ppt/presentation.xml` + ≥1 张 slide）。
 * 老夹具写的是 `'deck'` 这种占位字节 —— 那正是真机"半截文件被登记"的形态，
 * 门一上线它们必然被拒。夹具不换，坏的是测试的语义（"ppt 能被登记"这条不变式
 * 说的本来就是"**合法**的 ppt 能被登记"）。
 */
async function minimalPptx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  zip.file(
    'ppt/presentation.xml',
    '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  );
  zip.file(
    'ppt/slides/slide1.xml',
    '<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>',
  );
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

/**
 * 最小**合法** DOCX（docx 登记门的夹具，2026-10-06）。
 *
 * 与 `minimalPptx` 同构：判据要的是 OOXML 包的必要件 —— `[Content_Types].xml` +
 * `word/document.xml`。用户反馈 #9 的假 docx 是"纯文本改名"，在这个夹具面前必然被拒。
 */
async function minimalDocx(): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  zip.file(
    'word/document.xml',
    '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>',
  );
  return (await zip.generateAsync({ type: 'nodebuffer' })) as Buffer;
}

/**
 * 最小**合法** PDF（2026-10-07 体检 P2-6 补的夹具）。
 *
 * ⚠️ 与 `minimalPptx` 同一条教训：`.pdf` 现在也在登记前置门内（头 `%PDF-` + 尾 `%%EOF`），
 *    老夹具写的 `'pdf'` / `'own task'` 这种占位字节会被门拒掉 —— 那不是门错了，
 *    是夹具在冒充"合法的 PDF"（"pdf 能被登记"这条不变式说的本来就是**合法** pdf）。
 */
function minimalPdf(label = 'fixture'): Buffer {
  return Buffer.from(`%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${label}\nstartxref\n9\n%%EOF\n`);
}

function seedTaskAndMessage(taskId = 'task-1', messageId = 'msg-1'): void {
  const now = new Date().toISOString();
  getSqlite()!
    .prepare(
      `INSERT INTO tasks
       (id, session_key, session_id, title, status, created_at, updated_at, tags, artifact_dir, gateway_id)
       VALUES (?, ?, '', '', 'active', ?, ?, '[]', '', '')`,
    )
    .run(taskId, `session-${taskId}`, now, now);
  getSqlite()!
    .prepare(
      `INSERT INTO messages (id, task_id, role, content, timestamp, session_key)
       VALUES (?, ?, 'assistant', 'done', ?, ?)`,
    )
    .run(messageId, taskId, now, `session-${taskId}`);
}

async function main(): Promise<Record<string, unknown>> {
  if (scenario === 'legacy-artifact-upgrade') {
    const legacy = new Database(join(workspacePath, DB_FILE_NAME));
    legacy.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, session_key TEXT NOT NULL, session_id TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', artifact_dir TEXT NOT NULL DEFAULT '');
      CREATE TABLE messages (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
        timestamp TEXT NOT NULL);
      CREATE TABLE artifacts (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, message_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'file', name TEXT NOT NULL, file_path TEXT NOT NULL, local_path TEXT NOT NULL,
        mime_type TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, source_key TEXT NOT NULL DEFAULT '',
        content_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      INSERT INTO tasks VALUES ('task-1', 'session-task-1', '', '', 'active', '2026-01-01', '2026-01-01', '[]', '');
      INSERT INTO messages VALUES ('msg-old', 'task-1', 'assistant', 'old', '2026-01-01');
      INSERT INTO messages VALUES ('msg-new', 'task-1', 'assistant', 'new', '2026-01-02');
      INSERT INTO artifacts VALUES ('old-empty', 'task-1', 'msg-old', 'file', 'report.txt', '', 'task-1/report.txt',
        'text/plain', 0, '', '', '2026-01-01');
      INSERT INTO artifacts VALUES ('new-valid', 'task-1', 'msg-new', 'file', 'report.txt', '', 'task-1/report.txt',
        'text/plain', 42, 'workspace-file:report.txt:new', '', '2026-01-02');
    `);
    legacy.close();
    initDatabase(workspacePath);
    const rows = getSqlite()!.prepare('SELECT id, size, source_key FROM artifacts').all();
    return { rows };
  }

  initDatabase(workspacePath);
  seedTaskAndMessage();
  mkdirSync(join(workspacePath, 'task-1', 'inbox', '.import-staging'), { recursive: true });

  if (scenario.startsWith('reserved-intermediate-')) {
    const rootKind: ArtifactRootKind = scenario.includes('-agent-') ? 'agent' : 'workspace';
    if (scenario.endsWith('-controlled')) process.env.ROYIN_NATIVE_PPT_VALIDATION = '1';
    else delete process.env.ROYIN_NATIVE_PPT_VALIDATION;
    const outputRoot = join(workspacePath, rootKind === 'agent' ? 'agent-ws' : 'task-1');
    mkdirSync(outputRoot, { recursive: true });
    const reconcileWorkspace = rootKind === 'agent' ? outputRoot : workspacePath;
    writeFileSync(join(outputRoot, 'prior.native-ppt.json'), '{"legacy":true}');
    getSqlite()!
      .prepare(
        `INSERT INTO artifacts(id,task_id,message_id,type,name,file_path,local_path,root,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        'prior-intermediate',
        'task-1',
        'msg-1',
        'code',
        'prior.native-ppt.json',
        join(outputRoot, 'prior.native-ppt.json'),
        rootKind === 'agent' ? 'prior.native-ppt.json' : 'task-1/prior.native-ppt.json',
        rootKind,
        new Date().toISOString(),
      );
    const baseline = await captureTaskArtifactBaseline({
      workspacePath: reconcileWorkspace,
      taskId: 'task-1',
      rootKind,
    });
    for (const name of [
      'current.native-ppt.json',
      'UPPER.NATIVE-PPT.JSON',
      '.royin-ppt-receipt-private.json',
      '.ROYIN-PPT-RECEIPT-private.JSON',
      'current.native-ppt.json.tmp',
      'diagnostic.tmp',
      'diagnostic.PART',
      'diagnostic.partial',
      'diagnostic.lock',
      'draft.json~',
      '~$draft.json',
      'report.json',
    ])
      writeFileSync(join(outputRoot, name), JSON.stringify({ file: name }));
    mkdirSync(join(outputRoot, '.royin-native-private'), { recursive: true });
    writeFileSync(join(outputRoot, '.royin-native-private', 'source.json'), '{"intermediate":true}');
    const params = { workspacePath: reconcileWorkspace, taskId: 'task-1', messageId: 'msg-1', rootKind, baseline };
    const first = await reconcileTaskArtifacts(params, { stabilityDelayMs: 5 });
    const second = await reconcileTaskArtifacts(params, { stabilityDelayMs: 5 });
    const rows = getSqlite()!.prepare('SELECT id,name,root,local_path FROM artifacts ORDER BY name').all();
    return { first, second, rows };
  }

  /**
   * M1 端到端判据（2026-10-06）：**坏文件物理上进不了 `artifacts` 表**。
   *
   * 真机形态（图14/16）：模型写文件写到一半、或写出非法 JSON 后进程继续跑，
   * 半截 `.pptx` 被 reconcile 收编 → 用户在产物里点开是坏文件。
   * 这里在**真 SQLite + 真文件系统 + 真扫描**上钉这条不变式：
   *   · 合法包 → saved（列表里有它）；
   *   · 截断包（合法包切掉尾巴 = 中央目录没了）→ 不登记、进 skipped、库里查无此行。
   */
  if (scenario === 'corrupt-pptx') {
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    const complete = await minimalPptx();
    const truncated = complete.subarray(0, Math.floor(complete.length * 0.6));
    writeFileSync(join(workspacePath, 'task-1', 'complete.pptx'), complete);
    writeFileSync(join(workspacePath, 'task-1', 'truncated.pptx'), truncated);
    const result = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    const rows = getSqlite()!.prepare('SELECT name, local_path, mime_type FROM artifacts ORDER BY name').all();
    return { result, rows };
  }

  /**
   * M1 续（2026-10-06）：**原地改坏 ⇒ 清行**。
   *
   * 真机形态：`deck.pptx` 先被合法登记，模型改稿时把它原地覆盖成半截文件。
   * 此时"不登记新版本"是不够的 —— 旧行还在列表里，用户点开就是坏字节。
   * 这条钉的判据：改坏后那次 reconcile 必须把该行**从库里删掉**，候选进 skipped。
   */
  if (scenario === 'corrupt-after-register') {
    const complete = await minimalPptx();
    const deckPath = join(workspacePath, 'task-1', 'deck.pptx');
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    writeFileSync(deckPath, complete);
    const first = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    const before = getSqlite()!.prepare('SELECT id, name FROM artifacts ORDER BY name').all();
    // 原地改坏：合法包切掉尾巴（中央目录没了）—— 与"模型写到一半就停"同构。
    writeFileSync(deckPath, complete.subarray(0, Math.floor(complete.length * 0.6)));
    const second = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    const after = getSqlite()!.prepare('SELECT id, name FROM artifacts ORDER BY name').all();
    return { first, before, second, after };
  }

  /**
   * ⭐ P1-1（2026-10-07 体检）：门内**读失败 ≠ 结构损坏**。
   *
   * 真机形态：文件曾经合法登记；某一趟 reconcile 扫到它时 `readFileSync` 抛错
   * （EBUSY/EACCES —— 杀软正在扫、U 盘/SMB 抖动）。旧实现 `catch { ok = false }`
   * 把这一瞬当成"文件坏了"，顺手 DELETE 掉登记行；而下一轮基线按签名跳过 ⇒
   * 列表里那份**永久消失且不可自愈**。
   *
   * ⚠️ NTFS 上没法确定性造出 EBUSY/EACCES（Node 打开的句柄都带共享读），
   *    所以用探针钩子在"稳定性检查之后、完整性读之前"把文件移走 ——
   *    对门来说这与 EBUSY **同构**：读那一刻读不到，而文件此前一直好好的。
   */
  if (scenario === 'unreadable-keeps-row') {
    const deckPath = join(workspacePath, 'task-1', 'deck.pptx');
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    writeFileSync(deckPath, await minimalPptx());
    const first = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    const before = getSqlite()!.prepare('SELECT id, name FROM artifacts ORDER BY name').all();
    const second = await reconcileTaskArtifacts(
      { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline },
      { beforeIntegrityRead: () => rmSync(deckPath, { force: true }) },
    );
    const after = getSqlite()!.prepare('SELECT id, name FROM artifacts ORDER BY name').all();
    return { first, before, second, after };
  }

  /**
   * ⭐ P3-10（2026-10-07 体检）：陈旧行的清行必须**按行身份复核**。
   *
   * 两趟并发 reconcile 的真实形态：A 读到坏字节 → 准备删旧行；B 已经把该路径重新登记成
   * **新行**（新 id / 新 source_key）。旧实现按 (task_id, root, local_path) 删、且在事务外
   * ⇒ 把 B 刚登记的好行连带抹掉。
   *
   * 这里用同一个"读之前"钩子精确摆出这个时序：钩子里把旧行换成新行，
   * 本趟读到的仍是坏字节（该删的是**它读的那一行**，不是"这个路径上的任何行"）。
   */
  if (scenario === 'corrupt-race-keeps-new-row') {
    const complete = await minimalPptx();
    const deckPath = join(workspacePath, 'task-1', 'deck.pptx');
    // 结构确认坏：合法包切掉尾巴（中央目录没了）—— 与"模型写到一半就停"同构。
    writeFileSync(deckPath, complete.subarray(0, Math.floor(complete.length * 0.6)));
    getSqlite()!
      .prepare(
        `INSERT INTO artifacts
         (id, task_id, message_id, type, name, file_path, local_path, mime_type, size, source_key, content_text, created_at)
         VALUES ('prior-row', 'task-1', 'msg-1', 'file', 'deck.pptx', ?, 'task-1/deck.pptx',
                 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 10,
                 'workspace-file:deck.pptx:old', '', ?)`,
      )
      .run(deckPath, new Date().toISOString());
    const result = await reconcileTaskArtifacts(
      { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} },
      {
        beforeIntegrityRead: () => {
          const sqlite = getSqlite()!;
          // 并发那趟：旧行被替换成新登记（不同 id、不同 source_key，指向同一路径）。
          sqlite.prepare('DELETE FROM artifacts WHERE id = ?').run('prior-row');
          sqlite
            .prepare(
              `INSERT INTO artifacts
               (id, task_id, message_id, type, name, file_path, local_path, mime_type, size, source_key, content_text, created_at)
               VALUES ('concurrent-row', 'task-1', 'msg-1', 'file', 'deck.pptx', ?, 'task-1/deck.pptx',
                       'application/vnd.openxmlformats-officedocument.presentationml.presentation', 10,
                       'workspace-file:deck.pptx:new', '', ?)`,
            )
            .run(deckPath, new Date().toISOString());
        },
      },
    );
    const rows = getSqlite()!.prepare('SELECT id, name FROM artifacts ORDER BY name').all();
    return { result, rows };
  }

  /**
   * ⭐ docx 登记门 + 脚本类排除（2026-10-06，用户反馈 #9：
   *    "重新生成 docx：桌面出现 js 文件；新 docx 打不开/乱码；手动切换模型才正常。"）。
   *
   * 一次验两个根**同一口径**：
   *   · `.docx` 必须过与 pptx 同构的完整性门（纯文本改名 / 半截包不登记）；
   *   · `.js/.cjs/.mjs/.py` 这类**模型自己跑过的作业脚本**不进产物列表；
   *   · 对照：`.md/.html` 与合法 OOXML 照旧登记（只排除脚本类，不是排除文本类）。
   *
   * ⚠️ 口径说明（行为差异就写在这里）：**两个根用同一条规则，不按根分叉**。
   *    理由：显式保存路径（`saveArtifact*`，含用户点名要的代码块产物）根本不经过本扫描，
   *    "排除脚本"只影响**自动收编**；两个根在这一点上没有用户可感知的差异，
   *    按根分叉只会让同一份文件在两个根里表现不一致。
   */
  if (scenario === 'docx-and-scripts') {
    // —— 应用根（任务目录）——
    const taskDir = join(workspacePath, 'task-1');
    const appBaseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    writeFileSync(join(taskDir, 'real.docx'), await minimalDocx());
    writeFileSync(join(taskDir, 'fake.docx'), '这不是文档，是纯文本改名');
    writeFileSync(join(taskDir, 'notes.md'), '# notes');
    writeFileSync(join(taskDir, 'page.html'), '<p>page</p>');
    for (const name of ['debug.js', 'generate.cjs', 'tool.mjs', 'probe.py'])
      writeFileSync(join(taskDir, name), '// 模型自己的作业脚本');
    const appResult = await reconcileTaskArtifacts({
      workspacePath,
      taskId: 'task-1',
      messageId: 'msg-1',
      baseline: appBaseline,
    });

    // —— 助手根（模型写文件的真实现场）——
    const agentWorkspace = join(workspacePath, 'agent-ws');
    mkdirSync(agentWorkspace, { recursive: true });
    const agentBaseline = await captureTaskArtifactBaseline({
      workspacePath: agentWorkspace,
      taskId: 'task-1',
      rootKind: 'agent',
    });
    writeFileSync(join(agentWorkspace, 'report.docx'), await minimalDocx());
    writeFileSync(join(agentWorkspace, 'agent-fake.docx'), '又一份纯文本改名的假 docx');
    for (const name of ['agent-debug.js', 'agent-probe.py'])
      writeFileSync(join(agentWorkspace, name), '// 模型自己的作业脚本');
    const agentResult = await reconcileTaskArtifacts({
      workspacePath: agentWorkspace,
      taskId: 'task-1',
      messageId: 'msg-1',
      baseline: agentBaseline,
      rootKind: 'agent',
    });

    const rows = getSqlite()!.prepare('SELECT name, root, local_path FROM artifacts ORDER BY name').all();
    return { appResult, agentResult, rows };
  }

  if (scenario === 'lifecycle') {
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    // ⚠️ 2026-10-06（docx 登记门）：`'document'` 这种纯文本改名的假 docx 现在会被门拒掉 ——
    //    夹具必须换成**最小合法包**（"docx 能登记"这条不变式说的本来就是"**合法** docx 能登记"，
    //    与 minimalPptx 那次换夹具同一个理由）。假 docx 被拒由 `docx-and-scripts` 场景钉住。
    writeFileSync(join(workspacePath, 'task-1', '总结.docx'), await minimalDocx());
    // ⭐ 2026-09-24（A 方案的 spike 2）：将来的 pptx 就长在任务目录里，
    // 这里显式验它会被登记成产物、类型是 file、MIME 是 PPTX 那一串 ——
    // 别只靠"docx 能行，pptx 同表"推断。
    // ⚠️ 2026-10-06（M1 门）：内容必须是**结构完整的包**才允许登记（见 minimalPptx 注释）。
    writeFileSync(join(workspacePath, 'task-1', '汇报.pptx'), await minimalPptx());
    writeFileSync(join(workspacePath, 'task-1', '.secret.txt'), 'secret');
    writeFileSync(join(workspacePath, 'task-1', 'draft.tmp'), 'temp');
    writeFileSync(join(workspacePath, 'task-1', 'empty.pdf'), '');
    writeFileSync(join(workspacePath, 'task-1', 'inbox', 'source.pdf'), 'source');
    const first = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    const second = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    const count = getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get();
    return { first, second, count };
  }

  if (scenario === 'videos') {
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    // ⚠️ .mp4 要**结构性合法**（登记前置门的 box 链判据，2026-10-12 视频接入）；
    //    .webm 不在受检名单，垃圾字节照旧（顺带钉住"未受检格式不受影响"）。
    writeFileSync(join(workspacePath, 'task-1', 'clip.mp4'), makeMp4Buffer());
    writeFileSync(join(workspacePath, 'task-1', 'clip.webm'), 'video');
    const first = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    const second = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline });
    return { first, second };
  }

  if (scenario === 'baseline') {
    writeFileSync(join(workspacePath, 'task-1', 'original.md'), 'user file');
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    return {
      result: await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline }),
    };
  }

  if (scenario === 'new-task-baseline') {
    seedTaskAndMessage('task-new', 'msg-new');
    return { baseline: await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-new' }) };
  }

  if (scenario === 'task-link') {
    const outside = mkdtempSync(join(tmpdir(), 'clawwork-artifact-outside-'));
    writeFileSync(join(outside, 'stolen.pdf'), 'outside');
    rmSync(join(workspacePath, 'task-1'), { recursive: true, force: true });
    try {
      symlinkSync(outside, join(workspacePath, 'task-1'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      rmSync(outside, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return { supported: false };
      throw error;
    }
    let error = '';
    try {
      await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    rmSync(outside, { recursive: true, force: true });
    return { supported: true, error };
  }

  if (scenario === 'missing') {
    const localPath = 'task-1/deleted.pdf';
    getSqlite()!
      .prepare(
        `INSERT INTO artifacts
         (id, task_id, message_id, type, name, file_path, local_path, mime_type, size, source_key, content_text, created_at)
         VALUES ('artifact-missing', 'task-1', 'msg-1', 'file', 'deleted.pdf', '', ?, 'application/pdf', 4,
                 'workspace-file:deleted.pdf:4:1', '', ?)`,
      )
      .run(localPath, new Date().toISOString());
    return {
      result: await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} }),
    };
  }

  if (scenario === 'changing') {
    const output = join(workspacePath, 'task-1', 'changing.txt');
    writeFileSync(output, 'one');
    return {
      result: await reconcileTaskArtifacts(
        { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} },
        { beforeSecondSnapshot: () => writeFileSync(output, 'changed while scanning') },
      ),
    };
  }

  if (scenario === 'changing-once') {
    const output = join(workspacePath, 'task-1', 'changing-once.txt');
    writeFileSync(output, 'one');
    let checks = 0;
    return {
      result: await reconcileTaskArtifacts(
        { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} },
        {
          stabilityDelayMs: 5,
          beforeSecondSnapshot: () => {
            checks += 1;
            if (checks === 1) writeFileSync(output, 'stable-after-first-check');
          },
        },
      ),
      checks,
    };
  }

  if (scenario === 'old-files-budget') {
    for (let index = 0; index < 105; index += 1) {
      writeFileSync(join(workspacePath, 'task-1', `old-${String(index).padStart(3, '0')}.txt`), `old-${index}`);
    }
    const baseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    writeFileSync(join(workspacePath, 'task-1', 'z-result.txt'), 'new result');
    return {
      result: await reconcileTaskArtifacts(
        { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline },
        { budgets: { maxResults: 2 } },
      ),
    };
  }

  if (scenario === 'truncated-baseline') {
    for (let index = 0; index < 4; index += 1) {
      writeFileSync(join(workspacePath, 'task-1', `old-${index}.txt`), `old-${index}`);
    }
    const baseline = await captureTaskArtifactBaseline(
      { workspacePath, taskId: 'task-1' },
      { budgets: { maxVisited: 2 } },
    );
    writeFileSync(join(workspacePath, 'task-1', 'result.txt'), 'new result');
    return {
      result: await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline }),
    };
  }

  if (scenario === 'budget') {
    for (let index = 0; index < 12; index += 1) {
      writeFileSync(join(workspacePath, 'task-1', `${String(index).padStart(2, '0')}.txt`), `file-${index}`);
    }
    return {
      result: await reconcileTaskArtifacts(
        { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} },
        { budgets: { maxVisited: 5, maxResults: 2, maxDepth: 2, maxTotalBytes: 1024 } },
      ),
    };
  }

  if (scenario === 'concurrent') {
    writeFileSync(join(workspacePath, 'task-1', 'parallel.pdf'), minimalPdf('parallel'));
    const input = { workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} } as const;
    const [left, right] = await Promise.all([reconcileTaskArtifacts(input), reconcileTaskArtifacts(input)]);
    const count = getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get();
    return { left, right, count };
  }

  if (scenario === 'updated') {
    const output = join(workspacePath, 'task-1', 'report.txt');
    writeFileSync(output, 'first');
    const first = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    writeFileSync(output, 'second version');
    const second = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    const count = getSqlite()!.prepare('SELECT COUNT(*) AS count FROM artifacts').get();
    const stored = getSqlite()!.prepare('SELECT size FROM artifacts WHERE id = ?').get(first.saved[0].id);
    return { first, second, count, stored };
  }

  if (scenario === 'replaced-same-metadata') {
    const output = join(workspacePath, 'task-1', 'identity.txt');
    writeFileSync(output, 'first');
    const first = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    const original = statSync(output);
    const replacement = join(workspacePath, 'task-1', 'replacement.tmp.txt');
    writeFileSync(replacement, 'other');
    utimesSync(replacement, original.atime, original.mtime);
    renameSync(replacement, output);
    const second = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    return { first, second };
  }

  if (scenario === 'attachment') {
    writeFileSync(join(workspacePath, 'task-1', 'image.png'), 'image bytes');
    getSqlite()!
      .prepare(
        `INSERT INTO artifacts
         (id, task_id, message_id, type, name, file_path, local_path, mime_type, size, source_key, content_text, created_at)
         VALUES ('attachment-artifact', 'task-1', 'msg-1', 'image', 'image.png', '', 'task-1/image.png', 'image/png',
                 11, 'attachment:0:image.png', 'preserve me', ?)`,
      )
      .run(new Date().toISOString());
    const result = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    const stored = getSqlite()!
      .prepare('SELECT source_key, content_text FROM artifacts WHERE id = ?')
      .get('attachment-artifact');
    return { result, stored };
  }

  /**
   * 第二个受信根：**助手自己的工作区**（2026-09-27）。
   *
   * 现场：助手用 exec 在它自己的工作区里生成 pptx / html，而产物表**从来没有过任何记录**
   * （真机 `.clawwork.db` 实测 `COUNT(*) = 0`）—— 任务产物的扫描根一直是
   * `<应用工作区>/<taskId>`，与助手工作区是**兄弟目录**。
   *
   * 这个场景一次验三件事：
   *   ① 助手根里新出现的文件**能被登记**，且 `root='agent'`、`local_path` 不带任务前缀；
   *   ② **不在助手工作区里建任务目录**（那是网关的目录，我们只读）；
   *   ③ 之后跑的那趟**应用根** reconcile **不把助手根的行判成 missing**（两批各行其是）。
   */
  if (scenario === 'agent-root') {
    const agentWorkspace = join(workspacePath, 'agent-ws');
    mkdirSync(agentWorkspace, { recursive: true });

    const baseline = await captureTaskArtifactBaseline({
      workspacePath: agentWorkspace,
      taskId: 'task-1',
      rootKind: 'agent',
    });
    const createdTaskDirInsideAgentWs = existsSync(join(agentWorkspace, 'task-1'));

    // ⚠️ 2026-10-06（M1 门）：`'PPTX'` 这种占位字节现在会被完整性门拒掉 —— 用真包。
    writeFileSync(join(agentWorkspace, 'deck.pptx'), await minimalPptx());
    // 助手**自己的配置**：不是产物（用户当初选「只要交付物」时点名排除的那批）。
    // 漏掉的后果不是"少一条"，是每个任务的产物面板里永远堆着同一批噪音。
    writeFileSync(join(agentWorkspace, 'SOUL.md'), '# SOUL');
    writeFileSync(join(agentWorkspace, 'IDENTITY.md'), '# IDENTITY');
    writeFileSync(join(agentWorkspace, 'AGENTS.md'), '# AGENTS');
    mkdirSync(join(agentWorkspace, 'memory'), { recursive: true });
    writeFileSync(join(agentWorkspace, 'memory', '2026-09-27.md'), 'a note');
    const agentResult = await reconcileTaskArtifacts({
      workspacePath: agentWorkspace,
      taskId: 'task-1',
      messageId: 'msg-1',
      baseline,
      rootKind: 'agent',
    });

    // 再跑一趟**应用根**（同一个任务）：它只该看自己的行。
    const appBaseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    const appResult = await reconcileTaskArtifacts({
      workspacePath,
      taskId: 'task-1',
      messageId: 'msg-1',
      baseline: appBaseline,
    });

    const rows = getSqlite()!.prepare('SELECT name, local_path, root, source_key FROM artifacts').all();
    return { createdTaskDirInsideAgentWs, agentResult, appResult, rows };
  }

  /**
   * ⭐ **第三个受信根**：应用工作区**根层**（2026-10-07）。
   *
   * 现场：模型不走 docgen/slidegen，而是用 exec / CLI 把成品写到
   * `荣盈魔方工作区\荣盈互动公司介绍-v2-ade3018a.pptx` —— 上面两条链
   * （`<工作区>/<taskId>` 与助手工作区）一个都不覆盖 ⇒ 文件明明生成了，
   * 产物面板里却什么都没有（claim-guard 找得到它：不是"丢了"，是**没登记**，
   * 所以连失败提示都不会有）。
   *
   * 这个场景一次验六件事：
   *   ① 这一轮写到根层的**文档类**交付物被登记（root='workspace-root'、`local_path` 是裸名）；
   *   ② 起跑**之前**就在根层的文件（用户自己的东西）不被误收 —— 基线挡；
   *   ③ **depth 0 不递归**：`task-1/` 与 `rongying-agents/` 里的文件一个都不收；
   *   ④ 正向扩展名白名单：`.json` 这类杂物与被排除的脚本不进列表；
   *   ⑤ **只读**：不建任务目录、不往根层写任何东西；
   *   ⑥ 应用根那趟**不许**把根层的行判成 missing（判了界面上就是一片红）。
   */
  if (scenario === 'workspace-root') {
    const agentWorkspace = join(workspacePath, 'rongying-agents', 'main');
    mkdirSync(agentWorkspace, { recursive: true });
    // 起跑**之前**就躺在根层的文件（用户自己的文档）—— 基线必须把它挡在外面。
    writeFileSync(join(workspacePath, '用户已有文档.docx'), await minimalDocx());

    // ⚠️ 用一个**还没有任务目录**的 taskId 采基线：第三个根绝不 ensureTaskDir
    //    （它是只读的；模型把成品写到根层时，任务目录甚至可能还不存在）。
    const missingTaskBaseline = await captureTaskArtifactBaseline({
      workspacePath,
      taskId: 'task-missing',
      rootKind: 'workspace-root',
    });
    const createdTaskDir = existsSync(join(workspacePath, 'task-missing'));

    const baseline = await captureTaskArtifactBaseline({
      workspacePath,
      taskId: 'task-1',
      rootKind: 'workspace-root',
    });

    // —— 这一轮模型跑到根层的东西 ——
    writeFileSync(join(workspacePath, '荣盈互动公司介绍-v2-ade3018a.pptx'), await minimalPptx());
    writeFileSync(join(workspacePath, '交付说明.md'), '# 交付说明');
    // 反向对照：白名单外的杂物与作业脚本**不进**产物（根层是用户与模型共用的一片）。
    writeFileSync(join(workspacePath, 'data.json'), '{"note":"not a deliverable"}');
    writeFileSync(join(workspacePath, 'debug.js'), '// 模型自己的作业脚本');
    writeFileSync(join(workspacePath, '.hidden.pdf'), minimalPdf('hidden'));
    // 任务目录里 / 助手目录里的：depth 0 ⇒ 一个都不许收。
    writeFileSync(join(workspacePath, 'task-1', 'task-dir.pptx'), await minimalPptx());
    writeFileSync(join(agentWorkspace, 'deck.pptx'), await minimalPptx());
    // 根层的 junction（Windows 上建目录联接不需要特权，与真机形态同构）：不跟随。
    const outside = mkdtempSync(join(tmpdir(), 'clawwork-artifact-root-link-'));
    writeFileSync(join(outside, 'outside.pdf'), minimalPdf('outside'));
    let linkSupported = true;
    try {
      symlinkSync(outside, join(workspacePath, 'outside-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      linkSupported = false;
    }

    const params = { workspacePath, taskId: 'task-1', messageId: 'msg-1', rootKind: 'workspace-root' } as const;
    const first = await reconcileTaskArtifacts({ ...params, baseline }, { stabilityDelayMs: 5 });
    const second = await reconcileTaskArtifacts({ ...params, baseline }, { stabilityDelayMs: 5 });

    // 应用根那趟照旧跑：它只该看自己的行（根层的行归第三个根）。
    const appBaseline = await captureTaskArtifactBaseline({ workspacePath, taskId: 'task-1' });
    const appResult = await reconcileTaskArtifacts({
      workspacePath,
      taskId: 'task-1',
      messageId: 'msg-1',
      baseline: appBaseline,
    });

    rmSync(outside, { recursive: true, force: true });
    const rows = getSqlite()!.prepare('SELECT name, root, local_path, source_key FROM artifacts ORDER BY name').all();
    return {
      createdTaskDir,
      linkSupported,
      missingTaskBaseline,
      first,
      second,
      appResult,
      rows,
    };
  }

  if (scenario === 'nested-link') {
    seedTaskAndMessage('task-2', 'msg-2');
    mkdirSync(join(workspacePath, 'task-2'), { recursive: true });
    writeFileSync(join(workspacePath, 'task-2', 'other.pdf'), minimalPdf('other'));
    const outside = mkdtempSync(join(tmpdir(), 'clawwork-artifact-linked-'));
    writeFileSync(join(outside, 'outside.pdf'), 'outside');
    try {
      symlinkSync(outside, join(workspacePath, 'task-1', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      rmSync(outside, { recursive: true, force: true });
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return { supported: false };
      throw error;
    }
    writeFileSync(join(workspacePath, 'task-1', 'own.pdf'), minimalPdf('own-task'));
    const result = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1', baseline: {} });
    rmSync(outside, { recursive: true, force: true });
    return { supported: true, result };
  }

  throw new Error(`unknown scenario: ${scenario}`);
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
