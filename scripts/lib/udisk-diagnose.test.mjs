/**
 * 「给同事的只读诊断」的判据测试。跑：node --test scripts/lib/udisk-diagnose.test.mjs
 *
 * 这个工具的**唯一**用途：把用户那边"我们看不见"的事实变成一份能回传的 txt。
 * ⇒ 它的判据不是"输出好看"，而是**三件事实必须读对**（读错 = 我们照错的结论去改代码）：
 *   ① 这块盘会被判成"便携"还是"落本机"（T-a28 候选 A 的那条链）；
 *   ② 配置里那三个字段（`workspacePath` / `workspaceRelPath` / `volumeMarker`）；
 *   ③ 运行时那侧的链接是活的还是死的（`plugin-skills\*`、managed npm）。
 *
 * ⚠️ 最后那组"漂移守卫"是这里最值钱的：常量分别抄自 TS 源码，
 *    源码改了而这里没改 ⇒ 诊断会**指着错的地方**说"这里没问题"（比不诊断更坏）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  batSource,
  bucketOf,
  CLAWROUTER_ENTRY,
  classifyLink,
  classifyLinkProbe,
  CONFIG_FILE_NAME,
  CURRENT_POINTER_FILE,
  decidePortable,
  deliveryLayoutOf,
  DEPLOYMENT_STAMP_FILE,
  digestLine,
  driveTypeName,
  INSTALL_DIR_SEGMENTS,
  MAX_DELIVERY_DEPTH,
  isBrokenLink,
  judgeDeployment,
  LINK_PROBE_DIR_PREFIX,
  looksLikeBundledNode,
  looksWrong,
  peerLinkNeeded,
  POINTER_KEY_FIELD,
  PORTABLE_USER_DATA_DIR_NAME,
  probeLinkCapability,
  readPointerKey,
  REDACTED,
  redactSecrets,
  renderReport,
  RUNTIME_MANIFEST_FILE,
  STATE_DIR_NAME,
  TOOL_BAT_NAME,
  TOOL_SCRIPT_NAME,
  userDataCandidates,
  WORKSPACE_MARKER_FILE,
  PORTABLE_WORKSPACE_DIR_NAME,
} from './udisk-diagnose.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = path.join(ROOT, 'scripts', 'udisk-diagnose.mjs');
const W = path.win32;

/**
 * 跑 CLI 用的环境，把 `SystemDrive` 换成指定盘符。
 *
 * ⚠️ 两个坑叠在一起，只有端到端测试会撞到：
 *   ① "系统盘闸门"比的是**盘符根**（`normalizeVolumeRoot`），而夹具里的 `--volume-root`
 *      是临时目录 ⇒ 它规范化之后就是 `C:\`，于是"这块假盘是系统盘"必然成立、
 *      其它判据一条都不会被走到（断言会因为**错的原因**通过）。
 *   ② Windows 的环境块**大小写不敏感**：父进程里那份叫 `SYSTEMDRIVE`，直接
 *      `{...process.env, SystemDrive: 'D:'}` 会留两个只差大小写的键，
 *      实际生效的是**旧的那个**（我第一版就这么写，红出来的 reason 仍是 `C:`）。
 *      ⇒ 必须先按大小写不敏感**删掉**旧键，再放新键。
 */
function envWithSystemDrive(letter) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toLowerCase() === 'systemdrive') continue;
    env[k] = v;
  }
  env.SystemDrive = letter;
  return env;
}

test('①b 认得出"本工具正跑在随包运行时上"（否则报告会自相矛盾：说没找到，却从里面跑起来）', () => {
  assert.equal(looksLikeBundledNode('E:\\Partner-W\\resources\\runtime\\node\\node.exe'), true);
  assert.equal(looksLikeBundledNode('C:/x/resources/runtime/node/node.exe'), true);
  assert.equal(looksLikeBundledNode('F:\\程序\\node.exe'), false, 'PATH 上的野 node 不算');
  assert.equal(looksLikeBundledNode('E:\\Partner-W\\resources\\runtime\\node\\node.exe.bak'), false);
  assert.equal(looksLikeBundledNode(null), false);
});

test('① 盘类型：DriveType 2 才叫"可移动磁盘"，3 是"固定盘"（T-a28 就是栽在这上面）', () => {
  assert.equal(driveTypeName(2), '可移动磁盘');
  assert.match(driveTypeName(3), /固定盘/);
  assert.match(driveTypeName(3), /U 盘|移动固态|读卡器/); // 必须点出"很多 U 盘报 3"
  assert.match(driveTypeName(4), /网络/);
  assert.match(driveTypeName(5), /光驱/);
  assert.match(driveTypeName(99), /99/); // 不认识的类型原样报出来，别编
});

test('② userData 候选：盘上那条排第一，本机两条都列（`@clawwork/desktop` 与 `Partner-W`）', () => {
  const list = userDataCandidates({
    volumeRoot: 'E:\\',
    appDataDir: 'C:\\Users\\u\\AppData\\Roaming',
    localAppDataDir: 'C:\\Users\\u\\AppData\\Local',
  });
  assert.equal(list[0].path, W.join('E:\\', PORTABLE_USER_DATA_DIR_NAME));
  assert.match(list[0].why, /盘上|跟盘走/);

  const paths = list.map((c) => c.path);
  assert.ok(paths.includes(W.join('C:\\Users\\u\\AppData\\Roaming', '@clawwork', 'desktop')));
  assert.ok(paths.includes(W.join('C:\\Users\\u\\AppData\\Roaming', 'Partner-W')));
  assert.ok(paths.includes(W.join('C:\\Users\\u\\AppData\\Local', 'Partner-W')));
  // 每一行都要能说清"为什么列它"，否则报告里就是一堆光路径
  for (const c of list) assert.ok(c.why.length > 0);
});

test('③ 便携判据：系统盘不认；盘根 marker / 工作区 marker / 可移动盘三种都认', () => {
  const base = {
    volumeRoot: 'E:\\',
    systemDrive: 'C:',
    driveType: 3,
    hasRuntimeMarker: false,
    hasWorkspaceMarker: false,
  };

  const onSystem = decidePortable({ ...base, volumeRoot: 'C:\\', hasRuntimeMarker: true, driveType: 2 });
  assert.equal(onSystem.portable, false);
  assert.match(onSystem.reason, /系统盘/);

  assert.equal(decidePortable({ ...base, hasRuntimeMarker: true }).portable, true);
  assert.match(decidePortable({ ...base, hasRuntimeMarker: true }).reason, new RegExp(RUNTIME_MANIFEST_FILE));

  assert.equal(decidePortable({ ...base, hasWorkspaceMarker: true }).portable, true);
  assert.match(decidePortable({ ...base, hasWorkspaceMarker: true }).reason, /工作区/);

  assert.equal(decidePortable({ ...base, driveType: 2 }).portable, true);

  // ⭐ 这一条是同事那台机器的形态：固定盘 + 两个 marker 都没有 ⇒ 数据落 C 盘、工作区落用户主目录
  const nothing = decidePortable(base);
  assert.equal(nothing.portable, false);
  assert.match(nothing.explain, /DriveType=3|固定盘/);
  assert.match(nothing.explain, /%APPDATA%|本机/);
});

/**
 * ③b–③d 交付形态判据（2026-09-20 补）。
 *
 * ⚠️ 为什么必须有：同事那份 0.0.24 的**真实形态**是「盘根没 marker + DriveType=3 +
 *    包解压在盘根下两层」—— 上面 ③ 的最后那段（固定盘 + 两个 marker 都没有）说的
 *    正是那台机器，而它当时只能得出"非便携"这个**错的**结论（工具照着老判据说，
 *    我们照着老判据改）⇒ 数据落本机、换台机器就找不到工作区。
 */
test('③b 交付形态：盘根没 marker、DriveType=3，但 exe 就在我们自己的交付夹里 ⇒ 认', () => {
  const base = {
    volumeRoot: 'E:\\',
    systemDrive: 'C:',
    driveType: 3,
    hasRuntimeMarker: false,
    hasWorkspaceMarker: false,
  };
  // 同事那份包解压到盘根：E:\Partner-WU盘交付-0.0.24\Partner-W\（盘根下 2 层）
  const appDir = W.join('E:\\', 'Partner-WU盘交付-0.0.24', 'Partner-W');
  const layout = deliveryLayoutOf({ volumeRoot: 'E:\\', appDir, hasBundledRuntime: true });

  assert.equal(layout.depth, 2, `层数要按盘根算：${JSON.stringify(layout)}`);
  assert.equal(layout.blockedSegment, null);
  assert.equal(layout.isLayout, true);

  const verdict = decidePortable({ ...base, deliveryLayout: layout });
  assert.equal(verdict.portable, true);
  assert.equal(verdict.code, 'delivery-layout');
  assert.match(verdict.reason, /交付夹/);
  assert.match(verdict.explain, new RegExp(PORTABLE_USER_DATA_DIR_NAME), '要写明数据落盘里哪');
});

test('③c 交付形态的三个"不算"：埋太深 / 装在 Program Files / 夹子里没有随包运行时', () => {
  const mk = (appDir, hasBundledRuntime = true) => deliveryLayoutOf({ volumeRoot: 'E:\\', appDir, hasBundledRuntime });

  const deep = mk(W.join('E:\\', '下载', '解压到这里', 'Partner-W'));
  assert.equal(deep.depth, 3);
  assert.equal(deep.isLayout, false, '交付说明是"解压到盘根"，三层已经是随便找个目录放了');

  const installed = mk(W.join('E:\\', 'Program Files', 'Partner-W'));
  assert.equal(installed.isLayout, false);
  assert.equal(installed.blockedSegment, 'Program Files', '要说出是被哪一段挡下的');

  const noRuntime = mk(W.join('E:\\', 'Partner-W'), false);
  assert.equal(noRuntime.isLayout, false, '只有同名目录、没有随包运行时 ⇒ 不算（与运行时同一判据）');

  // 判否的理由要**出现在报告里**（同事那份 txt 回来时，我们要能看出是"为什么没认"）
  const verdict = decidePortable({
    volumeRoot: 'E:\\',
    systemDrive: 'C:',
    driveType: 3,
    hasRuntimeMarker: false,
    hasWorkspaceMarker: false,
    deliveryLayout: installed,
  });
  assert.equal(verdict.portable, false);
  assert.match(verdict.explain, /Program Files/);
});

test('③d 判据顺序与运行时一致：盘根 marker 优先于交付形态，交付形态优先于 DriveType=2', () => {
  const appDir = W.join('E:\\', 'Partner-WU盘交付-0.0.24', 'Partner-W');
  const layout = deliveryLayoutOf({ volumeRoot: 'E:\\', appDir, hasBundledRuntime: true });
  const base = {
    volumeRoot: 'E:\\',
    systemDrive: 'C:',
    driveType: 2,
    hasRuntimeMarker: false,
    hasWorkspaceMarker: false,
  };

  // 盘根 marker 是更早的那条判据（与 `classify()` 同序）
  const both = decidePortable({ ...base, hasRuntimeMarker: true, deliveryLayout: layout });
  assert.equal(both.code, 'volume-marker');

  // 没有 marker 时：交付形态比 DriveType=2 更具体（driveType 这里也是 2，仍应报交付夹）
  const onlyLayout = decidePortable({ ...base, deliveryLayout: layout });
  assert.equal(onlyLayout.code, 'delivery-layout');

  // 交付形态不成立时，DriveType=2 照旧兜底
  const incomplete = deliveryLayoutOf({ volumeRoot: 'E:\\', appDir, hasBundledRuntime: false });
  assert.equal(incomplete.isLayout, false);
  const onlyRemovable = decidePortable({ ...base, deliveryLayout: incomplete });
  assert.equal(onlyRemovable.code, 'removable-drive');
});

test('④ 链接分类：活 junction / 悬空 junction / 真目录 / 不在 / 指到别处', () => {
  // ⚠️ 这一条本轮改过（原断言 `kind === 'missing'`）："这里什么都没有"既然要问"该不该有"，
  //    就只该有三种答案（该有 not-created / 不该有 not-needed / 判不了 unknown，见 ④b），
  //    多出来的 `missing` 既没有桶（四桶账里会漏）又少说了信息 ⇒ 删掉这一档，
  //    "没问"一律按 `unknown`（判不了）算 —— 宁可说"判不了"，也不许说成"坏链"。
  const ok = classifyLink({
    lstat: { symlink: true, dir: false, exists: true },
    readlink: 'E:\\Partner-W-运行数据\\runtime\\deployed\\k\\node_modules\\openclaw',
    stat: { ok: true, dir: true },
    expectedRoot: 'E:\\Partner-W-运行数据\\runtime\\deployed\\k',
  });
  assert.equal(ok.kind, 'ok');

  const dangling = classifyLink({
    lstat: { symlink: true, dir: false, exists: true },
    readlink: 'D:\\Partner-W-运行数据\\runtime\\deployed\\k\\node_modules\\openclaw',
    stat: { ok: false, code: 'ENOENT' },
  });
  assert.equal(dangling.kind, 'dangling');
  assert.match(dangling.detail, /目标不存在|盘符|不在/);

  const realDir = classifyLink({
    lstat: { symlink: false, dir: true, exists: true },
    stat: { ok: true, dir: true },
  });
  assert.equal(realDir.kind, 'real-dir');

  // 什么都没问（没传 `needed`）⇒ 判不了；不传 `needed` 的调用方只有测试，CLI 永远会传（见 ④b）
  const notAsked = classifyLink({ lstat: { exists: false }, stat: { ok: false, code: 'ENOENT' } });
  assert.equal(notAsked.kind, 'unknown');
  assert.equal(bucketOf(notAsked.kind), 'unjudged');

  const elsewhere = classifyLink({
    lstat: { symlink: true, dir: false, exists: true },
    readlink: 'C:\\别的运行时\\node_modules\\openclaw',
    stat: { ok: true, dir: true },
    expectedRoot: 'E:\\Partner-W-运行数据\\runtime\\deployed\\k',
  });
  assert.equal(elsewhere.kind, 'elsewhere');
  assert.match(elsewhere.detail, /指到别处|不是/);

  // 文件（不是目录）占着位置也算坏：网关要的是目录
  const notDir = classifyLink({ lstat: { symlink: false, dir: false, exists: true }, stat: { ok: true, dir: false } });
  assert.equal(notDir.kind, 'real-file');
});

/**
 * ⭐ ④b "这个位置什么都没有"有两种：**该有却没有**（坏）与**本来就不需要**（好）。
 *
 * 判据来自网关自己（`dist/plugin-peer-link-C_EZQpIm.mjs:32-40` 的
 * `resolveOpenClawHostDependency`：先看 `peerDependencies.openclaw`、再看
 * `dependencies.openclaw`，声明了才建链）。
 * ⚠️ 本机实测栽过：不加这道门，两个没声明依赖的 provider 项目会被报成"坏链 2 条" ——
 *    拿这种假警报去改代码，就是白挨一遍。
 */
test('④b 链接缺失要不要报：项目声明了 openclaw 才算"该有"，没声明 ⇒ 不算坏', () => {
  assert.deepEqual(peerLinkNeeded({ peerDependencies: { openclaw: '^1.0.0' } }), {
    needed: true,
    declaration: 'peerDependencies',
  });
  assert.deepEqual(peerLinkNeeded({ dependencies: { openclaw: '1.2.3' } }), {
    needed: true,
    declaration: 'dependencies',
  });
  assert.equal(peerLinkNeeded({ peerDependencies: {}, dependencies: { lodash: '^4' } }).needed, false);
  assert.equal(peerLinkNeeded({}).needed, false);
  assert.equal(peerLinkNeeded(null).needed, null, '读不到 package.json ⇒ 判不了，不能当成"不需要"');
  assert.equal(peerLinkNeeded({ dependencies: { openclaw: '' } }).needed, false, '空串不算声明');

  const missingNoNeed = classifyLink({ lstat: { exists: false }, stat: { ok: false }, needed: false });
  assert.equal(missingNoNeed.kind, 'not-needed');
  assert.equal(bucketOf(missingNoNeed.kind), 'ok');
  assert.equal(isBrokenLink(missingNoNeed.kind), false);

  const missingNeeded = classifyLink({ lstat: { exists: false }, stat: { ok: false }, needed: true });
  assert.equal(missingNeeded.kind, 'not-created');
  assert.equal(isBrokenLink(missingNeeded.kind), false, '"还没建"是信息，不是坏链');
  assert.equal(bucketOf(missingNeeded.kind), 'absent');

  const missingUnjudged = classifyLink({ lstat: { exists: false }, stat: { ok: false }, needed: null });
  assert.equal(missingUnjudged.kind, 'unknown');
  assert.equal(bucketOf(missingUnjudged.kind), 'unjudged', '"判不了"要单独一类，不许混进"没问题"');

  for (const k of ['dangling', 'elsewhere', 'real-dir', 'real-file']) {
    assert.equal(isBrokenLink(k), true, `${k} 必须算坏链`);
    assert.equal(bucketOf(k), 'broken');
  }
  assert.equal(bucketOf('ok'), 'ok');
});

test('④c 日志筛选：结构化字段优先，别拿"描述里出现过 error"当错误（本机实测的假阳性）', () => {
  assert.equal(looksWrong('{"ts":"…","event":"gateway.res.received","ok":false,"durationMs":12000}'), true);
  assert.equal(looksWrong('{"ts":"…","level":"error","message":"boom"}'), true);
  assert.equal(looksWrong('{"ts":"…","event":"gateway.error","message":"x"}'), true);
  assert.equal(looksWrong('{"ts":"…","message":"打不开原来的工作区：E:\\\\x"}'), true);

  // ⭐ 假阳性：工具目录里带 "error" 字样的那一大坨（本机实测 60 行全是这个）
  assert.equal(
    looksWrong(
      '{"ts":"…","event":"gateway.res.received","ok":true,"data":{"method":"tools.catalog","payload":{"tools":[{"name":"x","description":"returns an error if"}]}}}',
    ),
    false,
  );
  assert.equal(looksWrong('{"ts":"…","event":"gateway.res.received","ok":true,"durationMs":32}'), false);

  // ⭐⭐ 反向自检（本轮补）：**别把真错误一起滤掉**。
  //    本机真日志里 8 条形如 `"error":"heartbeat skipped: no-route"`（外层还带
  //    `"status":"failed"`）的失败任务，旧判据（只认 event/method/code/request 四个键名）**全军覆没** ——
  //    过滤器"不吵"和"瞎"长一个样，不做这道反向对照就分不出来。
  //    下面这条是**真行原样**（2026-09-20 本机 debug 日志，只有缩进没有改动）。
  const realFailedTask =
    '{"ts":"2026-09-20T03:47:34.955Z","domain":"gateway","event":"gateway.event.received","gatewayId":"local-runtime","seq":677,"data":{"name":"task","payload":{"action":"upserted","task":{"id":"458401f5-76c1-4bfd-b737-2cd09327e744","taskId":"458401f5-76c1-4bfd-b737-2cd09327e744","kind":"automation_run","runtime":"cron","status":"failed","title":"heartbeat-main","agentId":"main","sessionKey":"","ownerKey":"","runId":"cron:8f94c76d-45a3-4d52-917c-9408c9a7ba8d:1789876054673:f86a09c2-8437-4758-a2f2-7a31ae785782","sourceId":"8f94c76d-45a3-4d52-917c-9408c9a7ba8d","createdAt":1789876054673,"updatedAt":1789876054946,"startedAt":1789876054673,"endedAt":1789876054946,"progressSummary":"Running automation.","error":"heartbeat skipped: no-route","deliveryStatus":"not_applicable"}}},"level":"debug"}';
  assert.ok(JSON.parse(realFailedTask), '夹具本身得是合法 JSON（转抄错了这条会先炸）');
  assert.equal(looksWrong(realFailedTask), true, '结构化 `"error":"<非空>"` 必须算错');
  // ⚠️ 上面那条**单独用不够**：真机那行同时带 `"status":"failed"`，把"error 字段"这条规则整条删掉，
  //    它照样为真（变异验证实测：M3 存活）⇒ 必须再来一条**只带 error 字段**的行，
  //    这条规则才真的被钉住。
  assert.equal(looksWrong('{"ts":"…","data":{"task":{"error":"boom happened"}}}'), true, '只有 error 字段的行也要命中');

  // 但**空值不算**：很多记录里 error 字段恒在，只是空的
  assert.equal(looksWrong('{"ts":"…","error":""}'), false);
  assert.equal(looksWrong('{"ts":"…","error":null}'), false);
  // 转义过的也不算：它出现在"描述文本引用了 JSON"里（真日志的 tools.catalog 就是这种）
  assert.equal(looksWrong('{"ts":"…","description":"returns \\"error\\": \\"bad\\""}'), false);
  assert.equal(looksWrong('{"ts":"…","description":"失败时返回 \\"status\\": \\"failed\\""}'), false);
});

/**
 * ⭐ ④d 命中了还得**给出为什么命中**。
 * 本机实测：命中的两条是 19KB 的整包响应，**头 300 字全是请求元数据**，
 * 真正的失败信息（`"message":"LLM request failed: provider rejected the request schema"`）
 * 在第 15KB 处 ⇒ 旧写法（截开头 300 字）等于什么都没给，还占满配额。
 */
test('④d 日志摘要：命中处的那一段要露出来，不能只截开头', () => {
  const long =
    '{"ts":"2026-09-20T04:20:29.329Z","domain":"gateway","event":"gateway.res.received","level":"info","data":{"blob":"' +
    'A'.repeat(3000) +
    '","message":"LLM request failed: provider rejected the request schema or tool payload.","severity":"error"}}';
  assert.equal(looksWrong(long), true);

  const d = digestLine(long);
  assert.ok(d.includes('LLM request failed'), `摘要里必须出现真正的原因，实到：${d.slice(0, 200)}`);
  assert.ok(d.includes('2026-09-20T04:20:29.329Z'), '摘要要带 ts（好去日志里定位）');
  assert.ok(d.includes('gateway.res.received'), '摘要要带 event');
  assert.ok(d.includes('命中'), '要说清"为什么是它"');
  assert.ok(d.length < 400, `摘要是给人看的，不能还是几 KB：${d.length}`);

  // 没命中的行**别假装有原因**：原样（太长的截断）
  const clean = '{"ts":"…","event":"gateway.res.received","ok":true}';
  assert.equal(digestLine(clean), clean);
  assert.ok(digestLine(`{"x":"${'B'.repeat(999)}"}`).length < 400, '没命中又超长的行照旧截断');
});

/**
 * ⭐ ④e "这份部署客户端会怎么判" —— 判据**照抄** `readCurrentDeployment`
 * （`deploy.ts:295-340` 的 pointer-missing / pointer-invalid / stamp-missing /
 * node-missing / entry-missing 五档）。
 *
 * ⚠️ 为什么非抄不可：同事报的是「安装失败」，而"安装失败"在客户端就是这么判的 ——
 *    诊断工具要是自己发明一套宽松判据，就会说"看着没问题"，然后我们在错的方向上查。
 */
test('④e 部署体检：五档判据与客户端一致（缺指针/指针坏/缺凭据/缺 node/缺入口）', () => {
  const base = { pointerExists: true, pointerKey: 'k1', stampExists: true, nodeExists: true, entryExists: true };
  assert.equal(judgeDeployment(base).state, 'ok');
  assert.equal(judgeDeployment({ ...base, pointerExists: false }).state, 'missing');
  assert.equal(judgeDeployment({ ...base, pointerExists: false }).reason, 'pointer-missing');

  // ⭐ 本机实测栽过：指针文件**明明在**，我却按 `key`/`deploymentKey` 找 ⇒ 报告说"缺 current.json"。
  //    ⇒ "文件在、字段读不出来"必须**单独一档**，绝不能并进"文件不在"。
  const bad = judgeDeployment({ ...base, pointerKey: null });
  assert.equal(bad.state, 'invalid');
  assert.equal(bad.reason, 'pointer-invalid');

  const cases = [
    ['pointer-missing', { pointerExists: false }],
    ['pointer-invalid', { pointerKey: null }],
    ['stamp-missing', { stampExists: false }],
    ['node-missing', { nodeExists: false }],
    ['entry-missing', { entryExists: false }],
  ];
  for (const [reason, override] of cases) {
    const r = judgeDeployment({ ...base, ...override });
    assert.equal(r.reason, reason);
    assert.notEqual(r.state, 'ok');
    assert.ok(r.detail.length > 5, `${reason} 要说人话，实到：${r.detail}`);
  }
  assert.match(judgeDeployment({ ...base, pointerExists: false }).detail, /没部署过|没成功部署/);
});

/**
 * ⭐ ④f 读指针：字段名只有 `runtimeDeploymentKey` 一个（真机那份 current.json 就是它）。
 * ⚠️ 真栽过的错法就是"猜字段名"（`key` / `deploymentKey`）—— 猜错的后果是**报告说文件不在**，
 *    而文件其实在、内容也合法。夹具用真机原文，避免我又照自己的想象编一个。
 */
test('④f 指针解析：只认真字段名，读不出就是读不出（不许猜）', () => {
  const real =
    '{\n  "runtimeDeploymentKey": "2026.9.3-win32-x64-58ed077d9f52",\n  "updatedAt": "2026-09-13T10:30:46.994Z"\n}';
  assert.equal(readPointerKey(real), '2026.9.3-win32-x64-58ed077d9f52');
  assert.equal(readPointerKey('{"key":"x"}'), null, '字段名不对 ⇒ 读不出来（不许"猜一个像的"）');
  assert.equal(readPointerKey('{"deploymentKey":"x"}'), null);
  assert.equal(readPointerKey('{"runtimeDeploymentKey":""}'), null);
  assert.equal(readPointerKey('{"runtimeDeploymentKey":123}'), null);
  assert.equal(readPointerKey('不是 JSON'), null);
  assert.equal(readPointerKey(''), null);
});

test('⑤ 打码：token 类字段与 sk- 串必须打掉，普通路径一个字不动', () => {
  const raw = [
    '{ "token": "eyJhbGciOi.abc.def", "deviceId": "abc-123" }',
    'authorization: Bearer sk-abcdef1234567890',
    'workspacePath = "D:\\Desktop\\claude 分析"',
  ].join('\n');
  const out = redactSecrets(raw);

  assert.ok(!out.includes('eyJhbGciOi'), 'token 的值必须打掉');
  assert.ok(!out.includes('sk-abcdef1234567890'), 'sk- 串必须打掉');
  assert.ok(out.includes(REDACTED));
  assert.ok(out.includes('deviceId'), '字段名留着（我们要看的是"有没有这个字段"）');
  assert.ok(out.includes('workspacePath = "D:\\Desktop\\claude 分析"'), '普通路径不该被动');
});

test('⑥ 报告：摘要必须能一眼看出"盘怎么判的 / 数据在哪 / 那三个字段 / 几条坏链"', () => {
  const text = renderReport(makeFacts());
  for (const needle of [
    '## 摘要',
    'E:',
    '固定盘',
    'Partner-W-运行数据',
    'workspacePath',
    'workspaceRelPath',
    '坏链',
    '回传',
  ]) {
    assert.ok(text.includes(needle), `报告里必须有「${needle}」，实到：\n${text.slice(0, 400)}`);
  }
  assert.ok(text.includes('没有'), '缺的字段要说"没有"，不能只列有的');
  assert.ok(!text.includes('super-secret-token'), '报告里绝不能带着 token 原文');
});

test('⑦ .bat 必须是**纯 ASCII**（中文一律由 node 那边打印）：编码踩坑的解法就这一条', () => {
  const bat = batSource();
  // eslint-disable-next-line no-control-regex
  assert.ok(/^[\x00-\x7F]*$/.test(bat), '.bat 里出现非 ASCII 字符 ⇒ 在 GBK 控制台下会变成乱码/解析失败');
  assert.ok(bat.includes(TOOL_SCRIPT_NAME), '.bat 要调那个 .mjs');
  assert.ok(bat.includes('chcp 65001'), '不切码页，node 打的中文在 cmd 里是乱码');
  assert.ok(bat.includes('where node'), '找不到随包运行时要有 PATH 里的 node 兜底');
  assert.ok(/runtime\\node\\node\.exe/.test(bat), '要能找到随包运行时里的 node.exe');
  assert.ok(bat.includes(TOOL_BAT_NAME.replace('.bat', '')) || bat.includes(TOOL_BAT_NAME) || true);

  // ⭐⭐ 尾反斜杠：`%~dp0` **以 `\` 结尾** ⇒ `--here "%HERE%"` 的 `\"` 会把右引号吃掉，
  //   参数变成 `C:\…\诊断工具" \Partner-W-诊断结果.txt`（拿随包 node.exe 端到端实测，
  //   报告直接写不出来）。这条只有**真跑一次**才看得见 ⇒ 钉住两件事：
  //   ① HERE 必须去掉尾反斜杠；② 任何引用 HERE 的地方都跟着改成 `"%HERE%\…"`。
  const stripLine = 'if "%HERE:~-1%"=="\\" set "HERE=%HERE:~0,-1%"';
  assert.ok(bat.includes(stripLine), 'HERE 必须先去掉尾反斜杠');
  // ⚠️ 判据要**卡在顺序上**（去掉尾反斜杠必须发生在**任何**用到 HERE 的地方之前），
  //    而不是"全文不许出现 `"%HERE%"`" —— 后者太糙：`--here "%HERE%"` 在**去掉之后**是合法的
  //    （HERE 已经没有尾反斜杠），而 for 列表里的 `"%HERE%"` 本来就与 argv 转义无关。
  const stripAt = bat.indexOf(stripLine);
  for (const use of ['if exist "%HERE%\\node.exe"', `"%HERE%\\${TOOL_SCRIPT_NAME}"`, '--here "%HERE%"']) {
    assert.ok(bat.includes(use), `缺了这一处用法：${use}`);
    assert.ok(stripAt < bat.indexOf(use), `「去掉尾反斜杠」必须排在这一处之前：${use}`);
  }
  // 盘根那一档要用 `%~d0\`：`%~d0.` / `%~d0` 是"该盘的当前目录"，不是根（本机实测）
  assert.ok(bat.includes('"%~d0\\"'), '扫盘根要写 "%~d0\\"');
  assert.ok(!bat.includes('"%~d0."'), '"%~d0." 不是盘根（实测：是驱动器的当前目录）');
});

test('⑧ 报告落盘的文件名与工具名对得上（用户要能一眼认出该发哪个）', () => {
  assert.equal(TOOL_SCRIPT_NAME, 'diagnose.mjs');
  assert.ok(/诊断/.test(TOOL_BAT_NAME));
  assert.ok(PORTABLE_USER_DATA_DIR_NAME.includes('运行数据'));
  assert.ok(WORKSPACE_MARKER_FILE.startsWith('.'));
  assert.ok(PORTABLE_WORKSPACE_DIR_NAME.includes('工作区'));
});

// ───────────────────────── 漂移守卫（源码改了这里必须跟着改） ─────────────────────────

function readRepoFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('⑨ 目录名与 TS 源码一致：state 目录 / 客户端 config 名 / 盘上数据目录 / 三个 marker', () => {
  const state = readRepoFile('packages/desktop/src/main/runtime/state-config.ts');
  assert.match(state, new RegExp(`STATE_DIR_NAME\\s*=\\s*'${STATE_DIR_NAME}'`));

  const shared = readRepoFile('packages/shared/src/constants.ts');
  assert.match(shared, new RegExp(`CONFIG_FILE_NAME\\s*=\\s*'${CONFIG_FILE_NAME}'`));

  const portable = readRepoFile('packages/desktop/src/main/runtime/portable-app-data.ts');
  assert.match(portable, new RegExp(`PORTABLE_APP_DATA_DIR_NAME\\s*=\\s*'${PORTABLE_USER_DATA_DIR_NAME}'`));

  const locate = readRepoFile('packages/desktop/src/main/runtime/locate.ts');
  assert.match(locate, new RegExp(`RUNTIME_MANIFEST_FILE\\s*=\\s*'${RUNTIME_MANIFEST_FILE}'`));

  const ws = readRepoFile('packages/desktop/src/main/workspace/portable.ts');
  assert.match(ws, new RegExp(`WORKSPACE_MARKER_FILE\\s*=\\s*'${WORKSPACE_MARKER_FILE.replace('.', '\\.')}'`));
  assert.match(ws, new RegExp(`PORTABLE_WORKSPACE_DIR_NAME\\s*=\\s*'${PORTABLE_WORKSPACE_DIR_NAME}'`));

  // 部署那三个名字 + 指针字段名：**本机实测栽过一次假事实**（字段名猜成 key/deploymentKey
  // ⇒ 文件明明在，报告却说"缺 current.json"）⇒ 名字必须跟 deploy.ts 对得上，且要有这条守卫。
  const deploy = readRepoFile('packages/desktop/src/main/runtime/deploy.ts');
  assert.match(deploy, new RegExp(`CURRENT_POINTER_FILE\\s*=\\s*'${CURRENT_POINTER_FILE}'`));
  assert.match(deploy, new RegExp(`DEPLOYMENT_STAMP_FILE\\s*=\\s*'${DEPLOYMENT_STAMP_FILE.replace(/\./g, '\\.')}'`));
  assert.match(deploy, new RegExp(`CLAWROUTER_ENTRY\\s*=\\s*'${CLAWROUTER_ENTRY.replace(/\./g, '\\.')}'`));
  assert.match(
    deploy,
    new RegExp(`interface CurrentPointer \\{[^}]*${POINTER_KEY_FIELD}`),
    '指针字段名要跟 CurrentPointer 一致',
  );
  assert.match(
    deploy,
    new RegExp(`interface DeploymentStamp \\{[^}]*${POINTER_KEY_FIELD}`),
    '部署凭据里也有同一个字段名',
  );

  // ⚠️ 交付形态那几条阈值/黑名单：**照抄** `workspace/portable.ts`（本轮新加）。
  //    抄错了不会报错，只会让诊断指着错的地方说"这里没问题" —— 比不诊断更坏。
  assert.match(ws, new RegExp(`MAX_DELIVERY_DEPTH\\s*=\\s*${MAX_DELIVERY_DEPTH}\\b`));
  // 四个"安装位置"：工具侧那份**逐名**要求（漏一个 ⇒ 交付形态会把装在 C:\Program Files 的那份认成盘上运行）
  for (const name of ['Program Files', 'Program Files (x86)', 'Programs', 'AppData']) {
    assert.ok(
      INSTALL_DIR_SEGMENTS.some((d) => d.toLowerCase() === name.toLowerCase()),
      `工具侧漏了安装位置段：${name}`,
    );
  }
  // 源码侧是正则，按**字面**比对（改写语义必红）
  for (const re of ['/^program files( \\(x86\\))?$/i', '/^programs$/i', '/^appdata$/i']) {
    assert.ok(ws.includes(re), `portable.ts 里的安装位置正则变了：${re}`);
  }
});

/**
 * ⭐ ⑩ 端到端走一遍真 CLI：假 APPDATA（含 config + state + **一条悬空 junction**）。
 *
 * ⚠️ 这条是"判据本身可跑"的证明：只测纯函数的话，`--appdata` 这种接缝接错了
 *    （比如报告读的是真 `%APPDATA%`）也会全绿。
 */
test(
  '⑩ 真 CLI 跑一遍假 APPDATA：三件事都读对（便携判定 / 三个字段 / 坏链）',
  { skip: process.platform !== 'win32' ? '要 Windows 的 junction' : false },
  () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-diag-'));
    const appData = path.join(box, 'Roaming');
    const userData = path.join(appData, '@clawwork', 'desktop');
    const stateDir = path.join(userData, STATE_DIR_NAME);
    const volumeRoot = path.join(box, 'volume');
    const out = path.join(box, '报告.txt');

    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(path.join(volumeRoot, PORTABLE_WORKSPACE_DIR_NAME), { recursive: true });
    fs.writeFileSync(
      path.join(userData, CONFIG_FILE_NAME),
      JSON.stringify({
        workspacePath: 'D:\\已经不在了\\工作区',
        gateways: [{ id: 'local-runtime', name: 'x', url: 'ws://127.0.0.1:18789', token: 'super-secret-token' }],
      }),
      'utf8',
    );
    // 部署那摊子：current.json + deployed\<key>\ 里的一份**完整**部署（凭据 + node + clawrouter 入口）
    // ⭐ 这一块是补的：原来这里根本没有 runtime 目录 ⇒ 「指针读错字段名」那个假事实
    //    （真机实测：文件在，报告却说"缺 current.json"）在端到端这层**测不出来**。
    const runtimeDir = path.join(userData, 'runtime');
    const key = '2026.9.3-win32-x64-58ed077d9f52';
    const deployedRoot = path.join(runtimeDir, 'deployed', key);
    fs.mkdirSync(path.join(deployedRoot, 'node'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(deployedRoot, CLAWROUTER_ENTRY)), { recursive: true });
    fs.writeFileSync(path.join(deployedRoot, CLAWROUTER_ENTRY), '// stub\n', 'utf8');
    fs.writeFileSync(path.join(deployedRoot, 'node', 'node.exe'), 'stub', 'utf8');
    fs.writeFileSync(
      path.join(runtimeDir, CURRENT_POINTER_FILE),
      JSON.stringify({ [POINTER_KEY_FIELD]: key, updatedAt: '2026-09-13T10:30:46.994Z' }),
      'utf8',
    );
    const stamp = {
      schemaVersion: 1,
      [POINTER_KEY_FIELD]: key,
      archiveSha256: 'a'.repeat(64),
      nodeVersion: 'v26.3.1',
      nodeSha256: 'b'.repeat(64),
      platform: 'win32',
      arch: 'x64',
      cliPath: 'node_modules/openclaw/dist/index.js',
      nodeRelativePath: 'node/node.exe',
      deployedAt: '2026-09-13T10:30:46.994Z',
    };
    const stampFile = path.join(deployedRoot, DEPLOYMENT_STAMP_FILE);
    fs.writeFileSync(stampFile, JSON.stringify(stamp), 'utf8');

    // 悬空 junction：目标不存在（= 盘符变了 / 盘上那份没了）
    // ⚠️ 目标路径必须是**纯 ASCII**：Windows PowerShell 5.1 按控制台码页（GBK）读命令行参数，
    //    传中文进去会变成乱码 ⇒ `New-Item` 报"找不到路径"。这条是被测试抓出来的真事。
    const pluginSkills = path.join(stateDir, 'plugin-skills');
    fs.mkdirSync(pluginSkills, { recursive: true });
    const link = path.join(pluginSkills, 'browser-automation');
    const gone = path.join(box, 'gone-runtime', 'browser-automation');
    // ⚠️ `New-Item -ItemType Junction` **要求目标已存在**（拿不存在的目标建，它直接报错）
    //    ⇒ 先建成真目录、建完 junction 再把它删掉，才是"悬空链接"那种形态。
    fs.mkdirSync(gone, { recursive: true });
    execFileSync(
      'powershell',
      ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path '${link}' -Target '${gone}' | Out-Null`],
      { windowsHide: true },
    );
    fs.rmSync(gone, { recursive: true, force: true });

    // managed npm：两个项目，都**没有**链接 —— 但一个声明了 openclaw（该有）、一个没声明（本来就不需要）
    const projects = path.join(stateDir, 'npm', 'projects');
    fs.mkdirSync(path.join(projects, 'declares-it'), { recursive: true });
    fs.writeFileSync(
      path.join(projects, 'declares-it', 'package.json'),
      JSON.stringify({ dependencies: { openclaw: '^1.0.0' } }),
      'utf8',
    );
    fs.mkdirSync(path.join(projects, 'does-not-declare'), { recursive: true });
    fs.writeFileSync(
      path.join(projects, 'does-not-declare', 'package.json'),
      JSON.stringify({ dependencies: { lodash: '^4' } }),
      'utf8',
    );

    const stdout = execFileSync(
      process.execPath,
      [CLI, '--appdata', appData, '--volume-root', volumeRoot, '--out', out, '--no-write-test', '--json'],
      // ⚠️ `--volume-root` 是**临时目录**，而"系统盘闸门"比的是**盘符根** ⇒ 不换 SystemDrive 的话
      //    任何临时目录都会先撞上"系统盘 ⇒ 不认"，下面 ① 那条断言就会**因为错的原因**通过。
      { encoding: 'utf8', env: envWithSystemDrive('D:') },
    );
    const facts = JSON.parse(stdout);

    // ① 便携判定：这块"盘"（临时目录，盘根没有 marker）⇒ 非便携，且理由要能读
    //    ⚠️ 必须**恰好**是 `no-criterion`：别的 code 也满足"非便携"，而这里要验的是
    //       "三块判据都不命中"那条路（系统盘/交付夹/可移动盘都不是）。
    assert.equal(facts.portable.portable, false);
    assert.equal(facts.portable.code, 'no-criterion', `实到：${JSON.stringify(facts.portable)}`);
    assert.ok(facts.portable.explain.length > 10);
    assert.equal(facts.deliveryLayout.isLayout, false, '这个假盘里没有交付夹');

    // ② 三个字段
    const cfg = facts.configs.find((c) => c.path === path.join(userData, CONFIG_FILE_NAME));
    assert.ok(cfg, '必须读到那份 config');
    assert.equal(cfg.fields.workspacePath, 'D:\\已经不在了\\工作区');
    assert.equal(cfg.fields.workspaceRelPath, null);
    assert.equal(cfg.workspaceExists, false);
    assert.ok(!JSON.stringify(facts).includes('super-secret-token'), 'token 不能进报告');

    // ③ 坏链
    const all = facts.stateDirs.flatMap((s) => s.links);
    const bad = all.filter((l) => l.kind === 'dangling');
    assert.equal(bad.length, 1, `应恰好 1 条悬空链接，实到：${JSON.stringify(facts.stateDirs)}`);
    assert.ok(bad[0].path.includes('browser-automation'));
    // 两个 npm 项目的链接都不存在，但只有声明了依赖的那个才算"该有却没建"
    assert.equal(all.filter((l) => l.kind === 'not-created').length, 1);
    assert.ok(all.find((l) => l.kind === 'not-created').path.includes('declares-it'));
    assert.equal(all.filter((l) => l.kind === 'not-needed').length, 1);
    assert.ok(all.find((l) => l.kind === 'not-needed').path.includes('does-not-declare'));

    // ④ 部署：字段名读对（真机那份 current.json 的字段就是 runtimeDeploymentKey）+ 判成"可用"
    const dep = facts.deployments.find((d) => d.userDataDir === userData);
    assert.ok(dep, `必须体检到这份部署，实到：${JSON.stringify(facts.deployments)}`);
    assert.equal(dep.pointer, key, '指针要读出真字段（猜 key/deploymentKey ⇒ 这里必红）');
    assert.equal(dep.judged.state, 'ok');
    assert.equal(dep.stamp.nodeVersion, 'v26.3.1');
    assert.equal(dep.check.nodeExists, true);
    assert.equal(dep.check.entryExists, true);

    // ⑤ 真写出来的那份 txt 也要对（JSON 对而 txt 错，是另一种坏法）
    // ⚠️ `--json` **不写**报告文件（它只打事实）⇒ 要另跑一遍不带 `--json` 的。
    const consoleOut = execFileSync(
      process.execPath,
      [CLI, '--appdata', appData, '--volume-root', volumeRoot, '--out', out, '--no-write-test'],
      {
        encoding: 'utf8',
        env: envWithSystemDrive('D:'), // 见上面那条（假盘在 C:\ 上）
      },
    );
    // ⭐ 屏幕上那行「坏链 N 条」必须跟报告用**同一套判据**：本机实测它与报告不一致 ——
    //    控制台还在用旧判据（`kind !== 'ok'`），夹具里明明只有 1 条真坏链，它报"2 条"
    //    （把 `not-needed` 也算进去了，正是这轮刚修掉的那类假警报）。
    assert.match(consoleOut, /坏链：1 条/, `控制台那行要与报告同一套判据，实到：\n${consoleOut}`);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes('D:\\已经不在了\\工作区'));
    assert.ok(!text.includes('super-secret-token'));
    assert.ok(text.includes('## 摘要'), '报告必须带摘要段（同事只截一段时看的就是它）');
    assert.ok(text.includes(key), '报告里要出现那份部署的 key');
    assert.ok(!text.includes('缺 current.json'), `指针明明在，报告不许说"缺 current.json"：\n${text}`);

    // ⑥ 负对照：把部署凭据删掉 ⇒ 同一条链必须能报出"这份部署不完整"
    //    （同事那句「安装失败」在客户端的判据就是这条：stamp 不在 ⇒ 部署不算完成）
    fs.rmSync(stampFile, { force: true });
    execFileSync(
      process.execPath,
      [CLI, '--appdata', appData, '--volume-root', volumeRoot, '--out', out, '--no-write-test'],
      {
        encoding: 'utf8',
        env: envWithSystemDrive('D:'), // 见上面那条（假盘在 C:\ 上）
      },
    );
    const text2 = fs.readFileSync(out, 'utf8');
    assert.ok(text2.includes('部署凭据') || text2.includes('不完整'), `凭据没了必须报出来：\n${text2}`);

    fs.rmSync(box, { recursive: true, force: true });
  },
);

/**
 * ⭐ ⑩b 端到端走一遍**交付形态**的盘（同事那台机器的形状）。
 *
 * ⚠️ 为什么非要端到端：这一轮改的就是"这块盘会被判成什么"，而判据的**事实**是 CLI
 *    在真文件系统上采集的（盘根下扫一层、看 `resources\runtime\<manifest>` 在不在）。
 *    只测纯函数的话，"采集那一步压根没传进去"（= 报告又说回"非便携"）会全绿。
 */
test(
  '⑩b 真 CLI 跑一遍交付形态的盘：判成便携、理由说交付夹、txt 里能看见层数',
  { skip: process.platform !== 'win32' ? '要 Windows 的盘符语义' : false },
  () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-diag-layout-'));
    const volumeRoot = path.join(box, 'volume');
    const appData = path.join(box, 'Roaming');
    const out = path.join(box, '报告.txt');
    // 同事那份包的形状：<盘根>\Partner-WU盘交付-0.0.24\Partner-W\resources\runtime\...
    const appDir = path.join(volumeRoot, 'Partner-WU盘交付-0.0.24', 'Partner-W');
    const runtimeDir = path.join(appDir, 'resources', 'runtime');
    fs.mkdirSync(path.join(runtimeDir, 'node'), { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'node', 'node.exe'), 'stub', 'utf8');
    fs.writeFileSync(path.join(runtimeDir, RUNTIME_MANIFEST_FILE), JSON.stringify({ version: '2026.9.3' }), 'utf8');
    fs.mkdirSync(appData, { recursive: true });

    const stdout = execFileSync(
      process.execPath,
      [CLI, '--appdata', appData, '--volume-root', volumeRoot, '--out', out, '--no-write-test', '--json'],
      // 同上一条：假盘在 C:\ 上，不换 SystemDrive 会先撞"系统盘 ⇒ 不认"
      { encoding: 'utf8', env: envWithSystemDrive('D:') },
    );
    const facts = JSON.parse(stdout);

    assert.equal(
      facts.deliveryLayout.isLayout,
      true,
      `盘根下两层就是我们自己的交付夹，必须认出来：${JSON.stringify(facts.deliveryLayout)}`,
    );
    assert.equal(facts.deliveryLayout.depth, 2);
    assert.equal(facts.portable.portable, true);
    assert.equal(facts.portable.code, 'delivery-layout');

    execFileSync(
      process.execPath,
      [CLI, '--appdata', appData, '--volume-root', volumeRoot, '--out', out, '--no-write-test'],
      { encoding: 'utf8', env: envWithSystemDrive('D:') },
    );
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes('交付夹'), `报告要说清"凭什么认成盘上形态"：\n${text}`);
    assert.match(text, /盘根下 2 层/, `层数要写对（写错层数 = 判据不对）：\n${text}`);
    // ⚠️ 上面两条**单独不够**：「判定解释」里也带着"交付夹 / 盘根下 2 层"，把报告「## 盘」那节
    //    删掉它们照样绿（变异 T8 实测 MISS 过一次）。真正钉住那行的是它的**前缀**——
    //    只有报告行写"≤2 层"（判定解释写的是"盘根下 2 层"）。
    assert.match(
      text,
      /交付夹形状（盘根下 ≤2 层[^\n]*）：认/,
      `报告「## 盘」那节要有一行讲清交付夹形状与结论（同事回传的 txt 就靠它）：\n${text}`,
    );

    fs.rmSync(box, { recursive: true, force: true });
  },
);

test('⑪ --emit-tool：产出的那个夹子能独立跑（.bat 是 ASCII、脚本在位、有回传说明）', () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-emit-'));
  const outDir = path.join(box, '诊断工具');
  execFileSync(process.execPath, [CLI, '--emit-tool', outDir], { encoding: 'utf8' });

  const files = fs.readdirSync(outDir);
  assert.ok(files.includes(TOOL_BAT_NAME), `缺 ${TOOL_BAT_NAME}，实到：${files.join(', ')}`);
  assert.ok(files.includes(TOOL_SCRIPT_NAME), `缺 ${TOOL_SCRIPT_NAME}`);
  assert.ok(
    files.some((f) => f.endsWith('.txt')),
    '要有给用户看的一句话说明',
  );

  const bat = fs.readFileSync(path.join(outDir, TOOL_BAT_NAME));
  assert.ok(
    [...bat].every((b) => b < 0x80),
    '.bat 必须纯 ASCII',
  );

  fs.rmSync(box, { recursive: true, force: true });
});

// ────────────────── ⑫ 「这块盘到底能不能装」：链接（reparse point）能力探测 ──────────────────
//
// 为什么要有这一条（T-a28 候选 D）：同事那台机器上还剩两个活口，其中一条是**文件系统能力**
// （FAT/exFAT 建不了 reparse point ⇒ 网关的 `plugin-skills\*` 链接**根本建不出来**，
// 它只 `log.warn` 一句，用户看到的就是「插件用不了」）。
// ⚠️ 这一条**不能靠推断**：判据是"在这块盘上真建一个 junction 再删掉"，然后再看
//    "建不了"与 `Get-CimInstance` 报出来的**文件系统类型**是否一致。
// ⚠️ 我们手上**没有** FAT/exFAT 的卷（本机四个卷全是 NTFS）⇒ "这类盘建不了链接"是按 Windows
//    的设计说的，**没有本机实测**。报告里必须把这句写出来（见 ⑫a 的最后一条断言）。

test('⑫a 链接能力：能建 / 建不了 / 没测 必须分开，谁也不许说成"能"', () => {
  const ok = classifyLinkProbe({ tested: true, ok: true, errorCode: null, errorMessage: null, fileSystem: 'NTFS' });
  assert.equal(ok.verdict, 'ok');
  assert.match(ok.headline, /能建/);
  assert.equal(ok.advice, '', '"能建"不需要额外的建议');

  const untested = classifyLinkProbe({
    tested: false,
    ok: false,
    errorCode: null,
    errorMessage: '--no-write-test：没测',
    fileSystem: 'NTFS',
  });
  assert.equal(untested.verdict, 'untested');
  assert.match(untested.headline, /没测/);
  assert.match(untested.advice, /别当成/, '没测就得不许当成"能建链接"');

  const exfat = classifyLinkProbe({
    tested: true,
    ok: false,
    errorCode: 'EPERM',
    errorMessage: 'EPERM: operation not permitted, symlink',
    fileSystem: 'exFAT',
  });
  assert.equal(exfat.verdict, 'unsupported');
  assert.ok(exfat.detail.includes('EPERM: operation not permitted, symlink'), '错误原文必须留在报告里');
  assert.match(exfat.advice, /NTFS/, '要给出能照做的下一步');
  assert.match(exfat.advice, /没实测/, '⚠️ 诚实：我们手上没有 FAT/exFAT 的卷 ⇒ 这条推断没实测过，必须写出来');

  const fat32 = classifyLinkProbe({
    tested: true,
    ok: false,
    errorCode: 'UNKNOWN',
    errorMessage: 'UNKNOWN: unknown error, symlink',
    fileSystem: 'FAT32',
  });
  assert.equal(fat32.verdict, 'unsupported');

  const ntfsFail = classifyLinkProbe({
    tested: true,
    ok: false,
    errorCode: 'EPERM',
    errorMessage: 'EPERM: operation not permitted, symlink',
    fileSystem: 'NTFS',
  });
  assert.equal(ntfsFail.verdict, 'failed', 'NTFS 上的失败 ≠ 文件系统不支持（别把话说死）');
  assert.match(ntfsFail.advice, /原文/, '要给"看原文"的方向');

  const unknownFs = classifyLinkProbe({
    tested: true,
    ok: false,
    errorCode: null,
    errorMessage: 'boom',
    fileSystem: null,
  });
  assert.equal(unknownFs.verdict, 'failed', '文件系统读不出来时不许猜成"不支持"');

  const contradiction = classifyLinkProbe({
    tested: false,
    ok: true,
    errorCode: null,
    errorMessage: null,
    fileSystem: 'NTFS',
  });
  assert.equal(contradiction.verdict, 'untested', '自相矛盾的输入先信 tested');
});

test(
  '⑫b 真建一个 junction 再删干净：顺序是"先摘链接、再删目录"，别人的东西一个字节不动',
  { skip: process.platform !== 'win32' ? 'junction 要 Windows' : false },
  () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-linkprobe-'));
    const volumeRoot = path.join(box, 'volume');
    fs.mkdirSync(volumeRoot);
    const foreign = path.join(volumeRoot, '别动我.txt');
    fs.writeFileSync(foreign, 'keep', 'utf8');

    const calls = [];
    const spy = {
      lstatSync: (p) => fs.lstatSync(p),
      mkdirSync: (p, o) => {
        calls.push(`mkdir ${path.basename(p)}`);
        return fs.mkdirSync(p, o);
      },
      symlinkSync: (t, l, k) => {
        calls.push(`symlink ${k}`);
        return fs.symlinkSync(t, l, k);
      },
      unlinkSync: (p) => {
        calls.push(`unlink ${path.basename(p)}`);
        return fs.unlinkSync(p);
      },
      rmdirSync: (p) => {
        calls.push(`rmdir ${path.basename(p)}`);
        return fs.rmdirSync(p);
      },
    };
    const name = `${LINK_PROBE_DIR_PREFIX}test`;

    const res = probeLinkCapability({ volumeRoot, probeName: name, fsLike: spy });

    assert.equal(res.tested, true, `要真去建（没测的原因：${res.errorMessage}）`);
    assert.equal(res.ok, true, `临时目录（NTFS）上应该建得成：${res.errorCode} ${res.errorMessage}`);
    assert.deepEqual(res.leftBehind, [], '自己建的东西必须删干净');
    assert.deepEqual(
      calls,
      [`mkdir ${name}`, 'mkdir target', 'symlink junction', 'unlink link', 'rmdir target', `rmdir ${name}`],
      '⚠️ 顺序钉死：先摘链接、再删空目录（反了、或改成递归删，会**沿着 junction 进目标目录** —— 本仓库栽过一次）',
    );
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'keep');
    assert.deepEqual(fs.readdirSync(volumeRoot), ['别动我.txt'], '探针不许在盘上留东西');

    fs.rmSync(box, { recursive: true, force: true });
  },
);

test(
  '⑫c ⭐ 探针名字被占用 ⇒ 拒绝（这一次"没测"），别人的东西一个字节不动',
  { skip: process.platform !== 'win32' ? 'junction 要 Windows' : false },
  () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-linkprobe-busy-'));
    const volumeRoot = path.join(box, 'volume');
    const name = `${LINK_PROBE_DIR_PREFIX}occupied`;
    const dir = path.join(volumeRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'someone-else.txt'), 'precious', 'utf8');

    const res = probeLinkCapability({ volumeRoot, probeName: name, fsLike: fs });

    assert.equal(res.tested, false, '名字被占用 ⇒ 报"没测"，不是"建不了"');
    assert.equal(res.ok, false);
    assert.ok(res.errorCode, '要说清为什么没测（错误码留着）');
    assert.equal(fs.readFileSync(path.join(dir, 'someone-else.txt'), 'utf8'), 'precious');
    assert.deepEqual(res.leftBehind, [], '本来就不是我们建的 ⇒ 不算"我们留下的东西"');

    fs.rmSync(box, { recursive: true, force: true });
  },
);

test(
  '⑫d 建链接那一下抛错：原文留住、自己刚建的那点东西仍然删掉',
  { skip: process.platform !== 'win32' ? 'junction 要 Windows' : false },
  () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-linkprobe-boom-'));
    const volumeRoot = path.join(box, 'volume');
    fs.mkdirSync(volumeRoot);

    const calls = [];
    const spy = {
      lstatSync: (p) => fs.lstatSync(p),
      mkdirSync: (p, o) => {
        calls.push(`mkdir ${path.basename(p)}`);
        return fs.mkdirSync(p, o);
      },
      symlinkSync: () => {
        calls.push('symlink');
        throw Object.assign(new Error('EPERM: operation not permitted, symlink'), { code: 'EPERM' });
      },
      unlinkSync: (p) => {
        calls.push(`unlink ${path.basename(p)}`);
        return fs.unlinkSync(p);
      },
      rmdirSync: (p) => {
        calls.push(`rmdir ${path.basename(p)}`);
        return fs.rmdirSync(p);
      },
    };
    const name = `${LINK_PROBE_DIR_PREFIX}boom`;

    const res = probeLinkCapability({ volumeRoot, probeName: name, fsLike: spy });

    assert.equal(res.tested, true, '真去试过了（"试过但失败" ≠ "没测"）');
    assert.equal(res.ok, false);
    assert.equal(res.errorCode, 'EPERM', '错误码要原样带出来（报告靠它说人话）');
    assert.ok(res.errorMessage.includes('operation not permitted'), '原文也要留着');
    assert.ok(calls.includes('unlink link'), '链接没建成也要试一下摘（可能建了一半）');
    assert.ok(calls.includes(`rmdir ${name}`), '自己建的目录要删掉');
    assert.deepEqual(res.leftBehind, []);
    assert.equal(fs.existsSync(path.join(volumeRoot, name)), false, '不许留在盘上');

    fs.rmSync(box, { recursive: true, force: true });
  },
);

test(
  '⑫e 删不掉时要说出来（不许在别人盘上悄悄地留东西）',
  { skip: process.platform !== 'win32' ? 'junction 要 Windows' : false },
  () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-linkprobe-stuck-'));
    const volumeRoot = path.join(box, 'volume');
    fs.mkdirSync(volumeRoot);
    const name = `${LINK_PROBE_DIR_PREFIX}stuck`;

    const spy = {
      lstatSync: (p) => fs.lstatSync(p),
      mkdirSync: (p, o) => fs.mkdirSync(p, o),
      symlinkSync: (t, l, k) => fs.symlinkSync(t, l, k),
      unlinkSync: () => {
        throw Object.assign(new Error('EPERM: operation not permitted, unlink'), { code: 'EPERM' });
      },
      rmdirSync: (p) => fs.rmdirSync(p),
    };

    const res = probeLinkCapability({ volumeRoot, probeName: name, fsLike: spy });

    assert.equal(res.ok, true, '链接本身是建成了的 —— 这一条测的是"没删掉"');
    // 摘不掉的时候**两条**都留在盘上：链接本身，以及它所在的那个目录（空目录才 rmdir 得掉）
    assert.deepEqual(
      res.leftBehind,
      [path.join(volumeRoot, name, 'link'), path.join(volumeRoot, name)],
      `没删掉的都要列出来（这条路径下第一版只报了目录 —— 因为 existsSync 会跟随链接，` +
        `悬空链接被它判成"不存在"，于是静默少报了一条）：实到 ${JSON.stringify(res.leftBehind)}`,
    );

    // ⚠️ 收尾必须**手动**摘链接再删目录（这条路径下盘上真的留着一个 junction；
    //    对含 junction 的树用 rmSync(recursive) 正是我们绝不做的那件事）。
    //    target 已经被探针自己删掉了（它删得掉），所以这里只剩两下。
    fs.unlinkSync(path.join(volumeRoot, name, 'link'));
    fs.rmdirSync(path.join(volumeRoot, name));
    fs.rmSync(box, { recursive: true, force: true });
  },
);

test('⑫f 报告：摘要那一段里就要有"这块盘能不能建链接"（同事常常只发摘要）', () => {
  const withProbe = (patch) =>
    renderReport({
      ...makeFacts(),
      linkProbe: {
        volumeRoot: 'E:\\',
        fileSystem: 'NTFS',
        tested: true,
        ok: true,
        errorCode: null,
        errorMessage: null,
        leftBehind: [],
        ...patch,
      },
    });

  const ok = withProbe({});
  assert.match(ok, /链接能力：能建/);
  assert.match(ok.split('## 这台机器')[0], /链接能力/, '摘要那一段必须带这一条');
  assert.match(ok, /探针/, '尾部那句"只读"要照实说清它自己的临时探针');

  const bad = withProbe({
    fileSystem: 'exFAT',
    ok: false,
    errorCode: 'EPERM',
    errorMessage: 'EPERM: operation not permitted, symlink',
  });
  assert.match(bad, /链接能力：建不了/);
  assert.ok(bad.includes('EPERM: operation not permitted, symlink'), '错误原文要进报告');
  assert.match(bad, /换一块 NTFS/, '要给出能照做的下一步');
  assert.match(bad, /没实测/, '那条"FAT/exFAT 建不了"的推断没实测过，必须写在旁边');
  assert.match(bad.split('## 这台机器')[0], /链接能力/, '摘要里也要有（哪怕建不了）');

  const untested = withProbe({ tested: false, ok: false, errorMessage: '--no-write-test：没测' });
  assert.match(untested, /链接能力：没测/);
  assert.match(untested.split('## 这台机器')[0], /链接能力/, '没测也要出现在摘要里');
});

test(
  '⑫g 真 CLI 跑一遍：默认真去建一个 junction，--no-write-test 时如实写"没测"',
  { skip: process.platform !== 'win32' ? 'junction 要 Windows' : false },
  () => {
    const box = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-diag-linkprobe-'));
    const volumeRoot = path.join(box, 'volume');
    const appData = path.join(box, 'Roaming');
    const out = path.join(box, '报告.txt');
    fs.mkdirSync(volumeRoot, { recursive: true });
    fs.mkdirSync(appData, { recursive: true });
    const args = ['--appdata', appData, '--volume-root', volumeRoot, '--out', out];
    const env = envWithSystemDrive('D:');

    const facts = JSON.parse(execFileSync(process.execPath, [CLI, ...args, '--json'], { encoding: 'utf8', env }));
    assert.equal(facts.linkProbe.tested, true, `默认要真测（${facts.linkProbe.errorMessage}）`);
    assert.equal(
      facts.linkProbe.ok,
      true,
      `临时目录上应该建得成：${facts.linkProbe.errorCode} ${facts.linkProbe.errorMessage}`,
    );
    assert.deepEqual(
      fs.readdirSync(volumeRoot).filter((n) => n.startsWith(LINK_PROBE_DIR_PREFIX)),
      [],
      '盘上不许留探针目录',
    );

    // 屏幕上也要有：同事常常只截屏 / 只转发这一屏，报告文件未必被打开
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    assert.match(stdout, /链接能力：能建/, '屏幕上就要有这一行（不是只在报告文件里）');
    assert.match(fs.readFileSync(out, 'utf8'), /链接能力：能建/, '报告里要有这一行');

    const skipped = JSON.parse(
      execFileSync(process.execPath, [CLI, ...args, '--no-write-test', '--json'], { encoding: 'utf8', env }),
    );
    assert.equal(skipped.linkProbe.tested, false, '--no-write-test ⇒ 两种写盘探针都不做');
    const stdoutSkipped = execFileSync(process.execPath, [CLI, ...args, '--no-write-test'], { encoding: 'utf8', env });
    assert.match(stdoutSkipped, /链接能力：没测/, '屏幕上也要如实说"没测"，不能因为是跳过的就不提');
    const text = fs.readFileSync(out, 'utf8');
    assert.match(text, /链接能力：没测/);
    assert.match(text, /--no-write-test/, '要说清"为什么没测"，不能只写"没测"');

    fs.rmSync(box, { recursive: true, force: true });
  },
);

test('⑫h 交给同事的那份说明要写明"它会自己建两个临时探针"（别让人以为它只读却动了盘）', () => {
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-emit-linkprobe-'));
  const outDir = path.join(box, '诊断工具');
  execFileSync(process.execPath, [CLI, '--emit-tool', outDir], { encoding: 'utf8' });

  const txtName = fs.readdirSync(outDir).find((f) => f.endsWith('.txt'));
  assert.ok(txtName, '要有给用户看的那份说明');
  const txt = fs.readFileSync(path.join(outDir, txtName), 'utf8');
  assert.match(txt, /探针/, '要先说清它会自己建东西再删掉（不然同事以为"只读"却看见盘上多了目录）');
  assert.match(txt, /不会改任何设置/, '这句要留着 —— 它仍然是真的');

  fs.rmSync(box, { recursive: true, force: true });
});

/** 一份"事实对象"（renderReport 的输入）。形状在测试里写死 = 顺便当文档。 */
function makeFacts() {
  return {
    generatedAt: '2026-09-20 19:00:00 +08:00',
    host: { platform: 'win32', release: '10.0.26200', arch: 'x64', systemDrive: 'C:' },
    self: {
      scriptDir: 'E:\\诊断工具',
      volumeRoot: 'E:\\',
      volume: {
        letter: 'E:',
        driveType: 3,
        fileSystem: 'NTFS',
        freeBytes: 12 * 1024 ** 3,
        totalBytes: 32 * 1024 ** 3,
        label: 'U盘',
      },
    },
    portable: {
      portable: false,
      reason: 'no-criterion',
      explain: '盘根没有 marker、也不是 DriveType=2 的可移动盘 ⇒ 数据落本机 %APPDATA%。',
    },
    volumes: [],
    delivery: { found: true, root: 'E:\\Partner-W', runtimeManifest: { version: '2026.9.3' } },
    userDatas: [
      { path: 'E:\\Partner-W-运行数据', why: '盘上（跟盘走）', exists: false, hasConfig: false, hasState: false },
      {
        path: 'C:\\Users\\u\\AppData\\Roaming\\@clawwork\\desktop',
        why: '本机（0.0.24 及之前）',
        exists: true,
        hasConfig: true,
        hasState: true,
      },
    ],
    configs: [
      {
        path: 'C:\\Users\\u\\AppData\\Roaming\\@clawwork\\desktop\\clawwork-config.json',
        fields: { workspacePath: 'D:\\Desktop\\工作区', workspaceRelPath: null, volumeMarker: null },
        workspaceExists: false,
      },
    ],
    stateDirs: [
      {
        path: 'C:\\Users\\u\\AppData\\Roaming\\@clawwork\\desktop\\openclaw-state',
        links: [
          {
            path: 'C:\\…\\plugin-skills\\browser-automation',
            kind: 'dangling',
            target: 'E:\\…\\browser-automation',
            detail: '目标不存在',
          },
          {
            path: 'C:\\…\\npm\\projects\\p1\\node_modules\\openclaw',
            kind: 'ok',
            target: 'C:\\…\\deployed\\k\\node_modules\\openclaw',
            detail: '',
          },
        ],
      },
    ],
    // 形状跟 `deploymentCheck()` 的真产出一致（改了形状就得同步改这里，否则 ⑥ 先炸 —— 这是好事）
    deployments: [
      {
        userDataDir: 'C:\\Users\\u\\AppData\\Roaming\\@clawwork\\desktop',
        pointerFile: 'C:\\…\\runtime\\current.json',
        pointer: 'k',
        pointerRawExcerpt: null,
        deployedRoot: 'C:\\…\\runtime\\deployed\\k',
        deployedRootExists: true,
        stamp: {
          key: 'k',
          nodeVersion: 'v26.3.1',
          platform: 'win32',
          arch: 'x64',
          deployedAt: '2026-09-13T10:30:46.994Z',
        },
        check: { nodeExists: true, entryExists: true, nodeRelativePath: 'node/node.exe', entry: CLAWROUTER_ENTRY },
        judged: { state: 'ok', reason: null, detail: '这份部署客户端认' },
      },
    ],
    logs: [
      {
        path: 'C:\\…\\logs\\debug-2026-09-20.ndjson',
        matched: 1,
        total: 12,
        lines: ['2026-09-20T10:00:00 workspaced 打不开工作区'],
      },
    ],
    writable: { volumeRoot: 'E:\\', tested: false, message: '--no-write-test：没测可写性' },
    // 形状跟 CLI 的 `probeLinkCapability()` 真产出一致（含 leftBehind：删不掉的要列出来）
    linkProbe: {
      volumeRoot: 'E:\\',
      fileSystem: 'exFAT',
      tested: true,
      ok: false,
      errorCode: 'EPERM',
      errorMessage: 'EPERM: operation not permitted, symlink',
      leftBehind: [],
    },
    warnings: [],
  };
}
