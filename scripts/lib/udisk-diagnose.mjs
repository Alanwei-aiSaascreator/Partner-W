/**
 * U 盘诊断（只读）：把"我们看不见的那台机器"变成一份能回传的 txt。
 *
 * 为什么需要它（不是"顺手写的工具"）：同事报了五个症状（插件用不了 / 安装失败 /
 * 市场 prompt 装不上 / 部分助手装不上 / 一上来「找不到工作区」），我们能问的都问了，
 * **一件证据都没到手**（见 `docs/plan/2026-09-20-自主任务队列.md` 第一轮那五件）。
 * 没有那台机器上的一手事实，再改代码就是猜。这个脚本就是去取事实的：
 *
 *   ① **这块盘会被判成"便携"还是"落本机"** —— 判据抄自 `portable-app-data.ts`
 *      （盘根 marker / 工作区 marker / DriveType=2），同事那台机器的形态（固定盘 +
 *      两个 marker 都没有）会当场暴露出来；
 *   ② **配置里那三个字段**（`workspacePath` / `workspaceRelPath` / `volumeMarker`）+
 *      那个工作区**现在能不能打开** —— 「找不到工作区」那条弹窗的触发条件就在这；
 *   ③ **运行时那侧的链接是活的还是死的**（`<state>\plugin-skills\*`、
 *      `<state>\npm\projects\*\node_modules\openclaw`）—— 网关只在自己的时机修它们，
 *      而 `plugin-skills` 那半连 `openclaw doctor` 都不查（第五轮实测）。
 *
 * ⚠️ **只读**。唯一会写盘的一下：在盘根建一个几字节的探针文件再**立刻删掉**（判断盘
 *    能不能写，"装不上"的一大类原因就是这个）。不想让它写就加 `--no-write-test`。
 *
 * ⚠️ **本模块是纯函数**（不碰 fs / 不起进程）：判据要能用夹具测，CLI 才碰真机器。
 * ⚠️ 所有路径按 **Windows 语义**（`path.win32`）拼 —— 这是个 Windows 专用工具，
 *    不跟着宿主平台变（测试因此在任何平台上都得到同一份期望值）。
 */

import path from 'node:path';

const W = path.win32;

/** 盘上应用数据目录名（与 `runtime/portable-app-data.ts` 的 `PORTABLE_APP_DATA_DIR_NAME` 同名）。 */
export const PORTABLE_USER_DATA_DIR_NAME = '荣盈魔方-运行数据';
/** 网关状态目录名（与 `runtime/state-config.ts` 的 `STATE_DIR_NAME` 同名）。 */
export const STATE_DIR_NAME = 'openclaw-state';
/** 客户端配置文件（与 `@clawwork/shared` 的 `CONFIG_FILE_NAME` 同名）。 */
export const CONFIG_FILE_NAME = 'clawwork-config.json';
/** 认盘 marker（与 `runtime/locate.ts` 的 `RUNTIME_MANIFEST_FILE` 同名）。 */
export const RUNTIME_MANIFEST_FILE = 'openclaw-runtime-manifest.json';
/** 盘上工作区目录名与它自己的标记文件（与 `workspace/portable.ts` 同名）。 */
export const PORTABLE_WORKSPACE_DIR_NAME = '荣盈魔方工作区';
export const WORKSPACE_MARKER_FILE = '.clawwork-workspace.json';

/**
 * 运行时部署那三个名字（与 `runtime/deploy.ts` 同名）。
 * ⚠️ `POINTER_KEY_FIELD` 是**指针里的那个字段名** —— 本机实测栽过一次：我按 `key`/`deploymentKey`
 *    猜，结果真机那份 current.json（字段叫 `runtimeDeploymentKey`）读不出来，
 *    报告却说成「缺 current.json」= **假事实**。字段名只此一个，且要有漂移守卫（测试 ⑨）。
 */
export const CURRENT_POINTER_FILE = 'current.json';
/** 部署凭据：「部署完成」的**唯一**标志（它不在，这份部署就是半成品）。 */
export const DEPLOYMENT_STAMP_FILE = '.clawwork-runtime.json';
/** 网关入口（相对部署根）。 */
export const CLAWROUTER_ENTRY = 'node_modules/openclaw/dist/extensions/clawrouter/index.js';
export const POINTER_KEY_FIELD = 'runtimeDeploymentKey';

/** 回传给我们的那份报告的文件名。 */
export const REPORT_NAME = '荣盈魔方-诊断结果.txt';
/** 交给同事的东西：一个纯 ASCII 的 .bat + 这个脚本。 */
export const TOOL_BAT_NAME = '诊断.bat';
export const TOOL_SCRIPT_NAME = 'diagnose.mjs';
/** 打码后的占位（字段名留着，值打掉）。 */
export const REDACTED = '<已打码>';

/** 盘类型人话。⚠️ 3 那句必须点出"很多 U 盘也报 3" —— 那是 T-a28 的根。 */
/**
 * 这个 node 路径是不是"随包运行时里的那个"（`…\resources\runtime\node\node.exe`）。
 *
 * ⚠️ 为什么要问：`.bat` 会往深一层去找随包 node（本工具自己的扫描只看盘根和它下一层），
 *    于是会出现"报告说没找到随包程序目录，可这一行的 node 明明就是从里面跑起来的" ——
 *    自相矛盾的报告比不全的报告更坏。端到端实测（假 U 盘 + 交付包自带的 node）撞到的就是它。
 */
export function looksLikeBundledNode(nodePath) {
  return typeof nodePath === 'string' && /[\\/]resources[\\/]runtime[\\/]node[\\/]node\.exe$/i.test(nodePath);
}

export function driveTypeName(type) {
  switch (type) {
    case 2:
      return '可移动磁盘';
    case 3:
      return '固定盘（本地磁盘）—— ⚠️ 很多 U 盘/移动固态/读卡器都报这个';
    case 4:
      return '网络驱动器';
    case 5:
      return '光驱';
    case 6:
      return 'RAM 盘';
    default:
      return `未知类型（DriveType=${type}）`;
  }
}

/**
 * `'E:'` / `'E:\'` / `'e:/'` → `'E:\'`；给不出盘根返回 null（与 `workspace/portable.ts` 同名同义）。
 *
 * ⚠️ 为什么要这一步，而不是直接比字符串（这是我第一版真栽的坑，测试抓住）：
 *    `path.win32.normalize('C:')` 返回的是 **`'C:.'`**（"C 盘当前目录"的意思），
 *    而 `normalize('C:\\')` 返回 `'C:\\'` ⇒ 两边永远不相等 ⇒ **系统盘闸门一次都不会触发**，
 *    报告会把"C 盘上装的正式版"说成"盘上形态"。所有卷根比较都必须先过这个规范化。
 */
export function normalizeVolumeRoot(letter) {
  if (!letter) return null;
  const trimmed = String(letter).trim();
  if (!trimmed) return null;
  const root = W.parse(trimmed.endsWith('\\') || trimmed.endsWith('/') ? trimmed : `${trimmed}\\`).root;
  if (!root) return null;
  return root.endsWith('\\') || root.endsWith('/') ? root : `${root}\\`;
}

/** 目录比较用的规范化（`'C:\'`/`'C:'` → `'c:'`；其余去掉尾部斜杠、折大小写）。 */
function foldPathForCompare(p) {
  let s = W.normalize(String(p));
  if (/^[A-Za-z]:[\\/]*$/.test(s)) s = s.slice(0, 2);
  return s.replace(/[\\/]+$/, '').toLowerCase();
}

/** 同一个卷根吗（两边都先规范化，见 `normalizeVolumeRoot` 那条注释）。 */
function sameVolume(a, b) {
  return foldPathForCompare(normalizeVolumeRoot(a) ?? a) === foldPathForCompare(normalizeVolumeRoot(b) ?? b);
}

/** `child` 在 `root` 底下吗（大小写不敏感，Windows 语义）。 */
export function isUnder(child, root) {
  const c = foldPathForCompare(child);
  const r = foldPathForCompare(root);
  return c === r || c.startsWith(`${r}\\`);
}

/** 盘把文件放在哪：盘上那条排第一，本机那几条都要列出来（哪条真有东西，看 exists）。 */
export function userDataCandidates({ volumeRoot, appDataDir, localAppDataDir }) {
  const list = [];
  if (volumeRoot) {
    list.push({ path: W.join(volumeRoot, PORTABLE_USER_DATA_DIR_NAME), why: '盘上（"数据跟盘走"那一形态）' });
  }
  if (appDataDir) {
    list.push({
      path: W.join(appDataDir, '@clawwork', 'desktop'),
      why: '本机（0.0.24 及之前：包内 package.json 的 name 就是它）',
    });
    list.push({ path: W.join(appDataDir, '荣盈魔方'), why: '本机（productName 形态）' });
  }
  if (localAppDataDir) {
    list.push({ path: W.join(localAppDataDir, '荣盈魔方'), why: '本机（Local 下的同名目录）' });
    list.push({ path: W.join(localAppDataDir, '@clawwork', 'desktop'), why: '本机（Local 下的包名形态）' });
  }
  return list;
}

/**
 * 这块盘会被判成"盘上运行"吗 —— 判据**照抄** `decidePortableAppData`（顺序也照抄）。
 *
 * ⚠️ 这是**镜像**，不是引用：运行时改了顺序这里要跟着改（队列里记着这条风险）。
 *    但哪怕它过期，报告里也同时列了原始事实（marker 有没有、DriveType 几），
 *    后人能自己重判。
 */
export function decidePortable({ volumeRoot, systemDrive, driveType, hasRuntimeMarker, hasWorkspaceMarker }) {
  if (systemDrive && volumeRoot && sameVolume(volumeRoot, systemDrive)) {
    return {
      code: 'system-drive',
      portable: false,
      reason: '系统盘 ⇒ 不认（安装形态）',
      explain: `${volumeRoot} 是系统盘（${systemDrive}）⇒ 判定为安装形态：数据落本机 %APPDATA%。`,
    };
  }
  if (hasRuntimeMarker) {
    return {
      code: 'volume-marker',
      portable: true,
      reason: `盘根有 ${RUNTIME_MANIFEST_FILE} ⇒ 认`,
      explain: `盘根有 ${RUNTIME_MANIFEST_FILE} ⇒ 按"盘上运行"处理：数据落 <盘根>\\${PORTABLE_USER_DATA_DIR_NAME}\\。`,
    };
  }
  if (hasWorkspaceMarker) {
    return {
      code: 'workspace-marker',
      portable: true,
      reason: `盘里有 ${PORTABLE_WORKSPACE_DIR_NAME}\\${WORKSPACE_MARKER_FILE} ⇒ 认`,
      explain:
        `盘里有 ${PORTABLE_WORKSPACE_DIR_NAME}\\${WORKSPACE_MARKER_FILE}（我们自己写的、换盘符之后的主判据）` +
        ` ⇒ 按"盘上运行"处理：数据落 <盘根>\\${PORTABLE_USER_DATA_DIR_NAME}\\。`,
    };
  }
  if (driveType === 2) {
    return {
      code: 'removable-drive',
      portable: true,
      reason: 'DriveType=2（可移动盘）⇒ 认',
      explain: `这块盘在可移动盘列表里（DriveType=2）⇒ 按"盘上运行"处理：数据落 <盘根>\\${PORTABLE_USER_DATA_DIR_NAME}\\。`,
    };
  }
  return {
    code: 'no-criterion',
    portable: false,
    reason: '两条判据都不命中 ⇒ 不认',
    explain:
      `两块判据都没命中：盘根没有 ${RUNTIME_MANIFEST_FILE}、` +
      `也不在 DriveType=2 的可移动盘列表里（这块盘 DriveType=${driveType ?? '?'}，` +
      `${driveTypeName(driveType ?? -1)}）` +
      ` ⇒ 数据落本机 %APPDATA%、工作区落用户主目录。` +
      `⚠️ 这正是"换台机器/换个口就找不到数据"的那条链：判成非便携之后，连"把正在运行的那块盘当候选"的能力也一起丢掉了。`,
  };
}

/**
 * 链接分类（运行时那侧：`plugin-skills\*` 与 managed npm 里的 `node_modules\openclaw`）。
 *
 * 输入是**探测结果**（`lstat` / `readlink` / `stat` 的三元组），不是路径 —— 这样才能
 * 用夹具把五种形态都测到。探测形状（2026-09-20 本机实测）：
 *   · 活 junction：`lstat.symlink=true`、`readlink` 出目标、`stat.ok=true`
 *   · 悬空 junction：`lstat.symlink=true`、`readlink` 出目标、`stat` 抛 `ENOENT`
 *   · 真目录：`lstat.symlink=false, dir=true`
 */
export function classifyLink({ lstat, readlink, stat, expectedRoot, needed }) {
  if (!lstat || lstat.exists === false) {
    // ⭐ "这里什么都没有"分三种，别混成一个（本机实测：混了就会报一堆假警报）
    if (needed === false) {
      return {
        kind: 'not-needed',
        target: null,
        detail: '项目没有声明 openclaw 依赖（照网关自己的判据）—— 本来就不需要这条链',
      };
    }
    if (needed === null || needed === undefined) {
      return {
        kind: 'unknown',
        target: null,
        detail: '这里没有链接，而项目里的 package.json 读不出来（或被清了）⇒ 判不了该不该有',
      };
    }
    return { kind: 'not-created', target: null, detail: '网关还没建过它（装过又卸掉、或者压根没走到那一步）' };
  }
  if (!lstat.symlink) {
    if (lstat.dir) {
      return {
        kind: 'real-dir',
        target: null,
        detail: '是一个真目录，不是链接（常见于"整目录拷过来的盘"/装的时候被复制过）—— 网关要的是链接',
      };
    }
    return { kind: 'real-file', target: null, detail: '这里是个文件，不是链接也不是目录' };
  }

  const target = readlink ?? null;
  if (!stat || !stat.ok) {
    return {
      kind: 'dangling',
      target,
      detail:
        `链接的目标不存在（${stat?.code ?? 'ENOENT'}）：${target ?? '（读不出目标）'}` +
        ' —— 盘符变过、或盘上那份运行时被删/被换，都会成这样',
    };
  }
  if (!stat.dir) {
    return { kind: 'real-file', target, detail: `链接指向的不是目录：${target ?? '?'}` };
  }
  if (expectedRoot && target && !isUnder(target, expectedRoot)) {
    return {
      kind: 'elsewhere',
      target,
      detail: `指到别处：${target} —— 不是这份程序正在用的那一份（${expectedRoot}）`,
    };
  }
  return { kind: 'ok', target, detail: '目标存在' };
}

/**
 * 链接分四桶（报告里要分开数，别把"没建"和"坏了"混成一个数）：
 *   ok        指对了（含"本来就不需要"）
 *   absent    该有却没有（还没建过）—— **信息，不是故障**
 *   unjudged  判不了（读不到项目的 package.json）
 *   broken    真坏：悬空 / 指到别处 / 被真目录或文件占了位置
 */
const BUCKETS = {
  ok: 'ok',
  'not-needed': 'ok',
  'not-created': 'absent',
  unknown: 'unjudged',
  dangling: 'broken',
  elsewhere: 'broken',
  'real-dir': 'broken',
  'real-file': 'broken',
};

/** 这一种链接算不算"坏链"（会真的让插件/安装失败的那种）。 */
export function isBrokenLink(kind) {
  return BUCKETS[kind] === 'broken';
}

export function bucketOf(kind) {
  return BUCKETS[kind] ?? 'unjudged';
}

/**
 * 项目声明了 `openclaw` 依赖吗 —— 判据**照抄**网关的 `resolveOpenClawHostDependency`
 * （`dist/plugin-peer-link-*.mjs`：先 `peerDependencies.openclaw`，再 `dependencies.openclaw`，
 * 非空字符串才算声明）。
 *
 * ⚠️ 没这道门，没声明依赖的插件项目会被报成"坏链" —— 本机实测就报了 2 条假警报。
 * 返回 `needed: null` 表示**判不了**（读不到 manifest），不许当成 false。
 */
export function peerLinkNeeded(manifest) {
  if (!manifest || typeof manifest !== 'object') return { needed: null, declaration: null };
  for (const declaration of ['peerDependencies', 'dependencies']) {
    const deps = manifest[declaration];
    if (!deps || typeof deps !== 'object' || Array.isArray(deps)) continue;
    const spec = deps.openclaw;
    if (typeof spec === 'string' && spec.length > 0) return { needed: true, declaration };
  }
  return { needed: false, declaration: null };
}

/**
 * 读指针文件（`<userData>\runtime\current.json`）里的部署 key。
 *
 * ⚠️ **只认 `runtimeDeploymentKey`**：猜字段名栽过一次（文件明明在、内容也合法，
 *    报告却说"缺 current.json"）。读不出来就返回 `null`，由调用方说"读不出来"。
 */
export function readPointerKey(rawText) {
  if (typeof rawText !== 'string' || rawText.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawText.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  const key = parsed?.[POINTER_KEY_FIELD];
  return typeof key === 'string' && key.length > 0 ? key : null;
}

/**
 * "这份部署客户端会怎么判" —— 五档判据**照抄** `readCurrentDeployment`
 * （`deploy.ts:295-340`）：pointer-missing / pointer-invalid / stamp-missing /
 * node-missing / entry-missing。
 *
 * ⚠️ 为什么要抄而不是自己发明：同事报的「安装失败」在客户端就是这么判的；
 *    诊断工具要是用一套宽松判据，就会说"看着没问题"，我们就会往错的方向查。
 */
export function judgeDeployment({ pointerExists, pointerKey, stampExists, nodeExists, entryExists }) {
  if (!pointerExists) {
    return {
      state: 'missing',
      reason: 'pointer-missing',
      detail: `本机还没成功部署过运行时（缺 ${CURRENT_POINTER_FILE}）—— 客户端每次启动都会重新部署`,
    };
  }
  if (!pointerKey) {
    return {
      state: 'invalid',
      reason: 'pointer-invalid',
      detail: `${CURRENT_POINTER_FILE} 在，但读不出 ${POINTER_KEY_FIELD}（文件坏了，或者字段名对不上）`,
    };
  }
  if (!stampExists) {
    return {
      state: 'invalid',
      reason: 'stamp-missing',
      detail: `缺部署凭据（${DEPLOYMENT_STAMP_FILE}）—— 这份部署是**半成品**，客户端不认（"安装失败"的一大类就是它）`,
    };
  }
  if (!nodeExists) {
    return { state: 'invalid', reason: 'node-missing', detail: '部署里没有 node.exe —— 客户端会要求重插运行时盘' };
  }
  if (!entryExists) {
    return {
      state: 'invalid',
      reason: 'entry-missing',
      detail: `部署里没有网关入口（${CLAWROUTER_ENTRY}）—— 客户端会要求重插运行时盘`,
    };
  }
  return { state: 'ok', reason: null, detail: '这份部署客户端认' };
}

/**
 * 这行日志像"出错"吗 —— **看结构化字段，不看文字里有没有 error**。
 *
 * ⚠️ 本机实测（2026-09-20）：第一版用 `/error|失败/` 之类的子串匹配，结果
 *    `tools.catalog` 那一大坨（工具描述里带 "returns an error if…"）把 60 行配额**全占了** ——
 *    真正的错误一条没露出来。诊断工具报了满屏噪声，比不报还坏。
 * ⚠️ 反过来也栽过一次（同一轮的自检）：只认 `event/method/code/request` 四个键名，
 *    于是真日志里 `"error":"heartbeat skipped: no-route"` 那种（带 `"status":"failed"`）
 *    **一条都没命中** —— "不吵" 和 "瞎" 输出长得一样，不做反向对照就分不出来。
 *    ⇒ 规则表列出来，`looksWrong` 与"为什么"共用同一份，改一处不会两边打架。
 */
const WRONG_RULES = [
  { name: 'ok:false', re: /"ok":\s*false/ },
  { name: '级别', re: /"(level|severity)":\s*"(error|warn|fatal)"/i },
  // 字段名就叫 error 且值非空 ⇒ 按约定就是错误（空串/null 不算，很多记录里它恒在）
  { name: 'error 字段', re: /"error":\s*"[^"]+"/ },
  { name: 'status', re: /"status":\s*"(failed|error|denied|refused|timeout|unavailable)"/i },
  {
    name: '事件名',
    re: /"(event|method|code|request)":\s*"[^"]*(error|fail|denied|refus|timeout|unavailable|conflict)/i,
  },
  { name: '用户文案', re: /(打不开|安装失败|装入失败|找不到工作区|连接超时)/ },
];

export function looksWrong(line) {
  return WRONG_RULES.some((r) => r.re.test(line));
}

/**
 * 命中在哪、命中的那一段长什么样。给 `digestLine` 用（**必须和 `looksWrong` 同源**）。
 * 返回 `[{ rule, at, snippet }]`，`at` 是命中位置（找不到返回 -1）。
 */
export function whyWrong(line) {
  const out = [];
  for (const r of WRONG_RULES) {
    const m = r.re.exec(line);
    if (m) out.push({ rule: r.name, at: m.index, snippet: m[0] });
  }
  return out;
}

/**
 * 把命中行摘成**一行**给人看的摘要：`ts domain event level=… | 命中(规则名) ⟪…命中处上下文…⟫`
 *
 * ⚠️ 为什么不是"截开头 N 字"：本机实测命中的是 19KB 的整包响应，**开头 300 字全是请求元数据**，
 *    真正的失败信息（`"message":"LLM request failed: …"`）在 15KB 处 —— 截开头的写法
 *    等于"报了错但不告诉你错在哪"，还白占 60 行配额。⇒ 改成**围绕命中处开窗**。
 * 没命中的行原样返回（只截断），不假装有原因。
 */
export function digestLine(line, { before = 160, after = 90, max = 360 } = {}) {
  const why = whyWrong(line);
  if (why.length === 0) return line.length > max ? `${line.slice(0, max)}…` : line;

  const at = Math.min(...why.map((w) => w.at));
  let head = '';
  try {
    const j = JSON.parse(line);
    head = [j.ts, j.domain, j.event, j.level ? `level=${j.level}` : null].filter(Boolean).join(' ');
  } catch {
    head = '';
  }
  const start = Math.max(0, at - before);
  const end = Math.min(line.length, at + after);
  const win = `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
  const tag = `命中(${why.map((w) => w.rule).join('+')})`;
  return `${head ? `${head} | ` : ''}${tag} ⟪${win}⟫`;
}

const SECRET_KEY = /^(token|secret|password|passphrase|api[_-]?key|apikey|authorization|credential|devicePrivateKey)$/i;

/**
 * 打码：字段名留着（我们要看的是"有没有这个字段"），值打掉。
 *
 * ⚠️ 这份报告要经微信/邮件回传，而 `clawwork-config.json` 里有网关 token、
 *    日志里可能有授权头。打码宁可多做：**打错了只是少一点信息，漏了是把凭据发出去**。
 */
export function redactSecrets(text) {
  let out = String(text);
  // ① JSON 里 `"token": "值"` 形态
  out = out.replace(/"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"[^"]*"/g, (m, key) =>
    SECRET_KEY.test(key) ? `"${key}": "${REDACTED}"` : m,
  );
  // ② `token=值` / `token: 值` 形态
  out = out.replace(
    /\b(token|secret|password|api[_-]?key|authorization)\b\s*[:=]\s*"?([^\s",]{4,})"?/gi,
    (m, key) => `${key}: ${REDACTED}`,
  );
  // ③ 独立出现的密钥串
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED);
  out = out.replace(/\bBearer\s+[A-Za-z0-9._-]{8,}/gi, `Bearer ${REDACTED}`);
  return out;
}

function yesNo(v) {
  return v ? '是' : '没有';
}

/**
 * 一份"本机缓存运行时"的明细几行：指针 → 部署目录 → 凭据/node/入口 → **客户端会怎么判**。
 * ⚠️ 判词用客户端自己的档名（`pointer-missing` 那几个），我们照它查，不自己发明。
 */
function deploymentLines(d) {
  const out = [`已部署运行时：${d.userDataDir}`];
  if (!d.pointer) {
    out.push(
      `   · ${CURRENT_POINTER_FILE}：${d.pointerRawExcerpt ? `**在但读不出来**（原文节选：${d.pointerRawExcerpt}）` : '没有'}`,
    );
  } else {
    out.push(`   · ${CURRENT_POINTER_FILE}：${d.pointer}`);
  }
  if (d.pointer) {
    out.push(`   · 部署目录：${d.deployedRoot}${d.deployedRootExists ? '' : '（**这个目录不在**）'}`);
    out.push(
      `   · 部署凭据 ${DEPLOYMENT_STAMP_FILE}：` +
        (d.stamp
          ? `在（node ${d.stamp.nodeVersion ?? '?'} · ${d.stamp.platform ?? '?'} ${d.stamp.arch ?? '?'} · 部署于 ${d.stamp.deployedAt ?? '?'}）`
          : '**没有**'),
    );
    out.push(`   · node：${d.check.nodeExists ? '在' : `**不在**（找的是 ${d.check.nodeRelativePath ?? '?'}）`}`);
    out.push(`   · 网关入口：${d.check.entryExists ? '在' : `**不在**（找的是 ${d.check.entry}）`}`);
  }
  out.push(
    `   · **客户端会怎么判：${d.judged.state === 'ok' ? '可用' : `不可用（${d.judged.reason}）`}** —— ${d.judged.detail}`,
  );
  return out;
}

/** 摘要 + 明细。给人看的，所有行都能单独读懂（同事会整份转给我们）。 */
export function renderReport(facts) {
  const f = facts;
  const allLinks = f.stateDirs.flatMap((s) => s.links);
  const broken = allLinks.filter((l) => bucketOf(l.kind) === 'broken');
  const absent = allLinks.filter((l) => bucketOf(l.kind) === 'absent');
  const unjudged = allLinks.filter((l) => bucketOf(l.kind) === 'unjudged');
  const lines = [];

  lines.push(`荣盈魔方 · U 盘诊断结果`);
  lines.push(`生成时间：${f.generatedAt}`);
  lines.push('');

  // ── 摘要：同事只截一段的话，我们要的就是这一段 ──
  lines.push('## 摘要');
  const vol = f.self?.volume;
  lines.push(
    `1. 盘：${f.self?.volumeRoot ?? '（推不出）'}` +
      (vol
        ? ` · ${driveTypeName(vol.driveType)} · 文件系统 ${vol.fileSystem ?? '?'} · 可用 ${humanBytes(vol.freeBytes)} / ${humanBytes(vol.totalBytes)}`
        : ''),
  );
  lines.push(`2. 判定：${f.portable.portable ? '盘上形态（便携）' : '本机形态（非便携）'} —— ${f.portable.reason}`);
  lines.push(`   ${f.portable.explain}`);
  const lived = f.userDatas.filter((u) => u.exists);
  lines.push(
    `3. 数据实际落在：${lived.length ? lived.map((u) => u.path).join('；') : '（一个候选目录都不存在 —— 程序还没跑起来过）'}`,
  );
  for (const c of f.configs) {
    lines.push(`4. ${c.path}`);
    lines.push(`   workspacePath：${c.fields.workspacePath ?? '没有这个字段'}`);
    lines.push(`   这个工作区现在能打开：${yesNo(c.workspaceExists)}`);
    lines.push(
      `   workspaceRelPath：${c.fields.workspaceRelPath ?? '没有'}（没有 ⇒ 换盘符后"自愈候选"是 0 个，直接弹「找不到工作区」）`,
    );
    lines.push(`   volumeMarker：${c.fields.volumeMarker ?? '没有'}`);
  }
  if (f.configs.length === 0) lines.push('4. 没找到任何 clawwork-config.json（程序可能压根没启动成功）');
  lines.push(
    `5. 坏链：${broken.length} 条${broken.length ? '（下面详列）' : '（这一项是好的）'}` +
      (absent.length ? `；另有 ${absent.length} 处"链接还没建"（多半正常）` : '') +
      (unjudged.length ? `；${unjudged.length} 处判不了（读不到项目的 package.json）` : ''),
  );
  lines.push('');

  // ── 明细 ──
  lines.push('## 这台机器');
  lines.push(`系统：${f.host.platform} ${f.host.release} ${f.host.arch} · 系统盘 ${f.host.systemDrive}`);
  if (f.installedPcVersion?.length) {
    lines.push(`⚠️ 本机上还装着"电脑版"：${f.installedPcVersion.join('；')}（两份会抢同一个实例）`);
  } else {
    lines.push('本机没有发现"电脑版"的安装痕迹（这条只查了常见安装位置，不是全盘搜索）');
  }
  lines.push('');

  lines.push('## 盘');
  for (const v of f.volumes ?? []) {
    lines.push(
      `· ${v.letter} · ${driveTypeName(v.driveType)} · ${v.fileSystem ?? '?'} · 可用 ${humanBytes(v.freeBytes)} / ${humanBytes(v.totalBytes)}` +
        (v.label ? ` · 卷标 ${v.label}` : ''),
    );
  }
  lines.push(`认盘 marker（盘根 ${RUNTIME_MANIFEST_FILE}）：${yesNo(f.markers?.runtime)}`);
  lines.push(
    `工作区 marker（${PORTABLE_WORKSPACE_DIR_NAME}\\${WORKSPACE_MARKER_FILE}）：${yesNo(f.markers?.workspace)}`,
  );
  if (f.writable) {
    lines.push(
      `可写性：${f.writable.tested ? (f.writable.ok ? '能写' : `写不进去（${f.writable.message}）`) : `没测（${f.writable.message}）`}`,
    );
  }
  lines.push('');

  lines.push('## 程序与运行时');
  if (f.delivery?.found) {
    lines.push(`随包程序目录：${f.delivery.root}`);
    if (f.delivery.runtimeManifest) lines.push(`随包运行时清单：${JSON.stringify(f.delivery.runtimeManifest)}`);
  } else {
    lines.push('没在盘里找到随包程序目录（形状：<某个顶层目录>\\resources\\runtime\\node\\node.exe）');
    if (f.delivery?.runningFromBundledNode) {
      lines.push(`   ⚠️ 但本工具自己正跑在 ${f.delivery.runningFromBundledNode} 上 —— 那就是随包运行时里的 node`);
      lines.push('      （这份扫描只看盘根和它的下一层；程序目录在更深的地方时不报，不代表盘里没有）');
    }
  }
  lines.push(`本工具用的 node：${f.node?.path ?? '（没找到）'} ${f.node?.version ?? ''}`);
  for (const d of f.deployments ?? []) {
    lines.push(...deploymentLines(d));
  }
  lines.push('');

  lines.push('## 数据目录候选（哪个存在就是它）');
  for (const u of f.userDatas) {
    lines.push(
      `· ${u.exists ? '[有]' : '[无]'} ${u.path} —— ${u.why}` +
        (u.exists ? `（${CONFIG_FILE_NAME}：${yesNo(u.hasConfig)}，${STATE_DIR_NAME}：${yesNo(u.hasState)}）` : ''),
    );
  }
  lines.push('');

  lines.push('## 链接体检（插件/安装类问题的机制就在这）');
  if (f.stateDirs.length === 0) lines.push('（没有 state 目录可查）');
  for (const s of f.stateDirs) {
    lines.push(`· ${s.path}`);
    if (s.links.length === 0) lines.push('   （目录下没有任何链接 —— 网关还没建过）');
    for (const l of s.links) {
      const bucket = bucketOf(l.kind);
      const mark = bucket === 'broken' ? '❌' : bucket === 'unjudged' ? '⚠️' : bucket === 'absent' ? '·' : '✅';
      lines.push(`   ${mark} ${l.kind}：${l.path}`);
      lines.push(`      目标：${l.target ?? '（无）'}${l.detail ? ` —— ${l.detail}` : ''}`);
    }
  }
  lines.push('');

  lines.push('## 日志线索（**筛出来的**，不是最后几行）');
  if (!f.logs?.length) lines.push('（没找到 debug-*.ndjson）');
  for (const g of f.logs ?? []) {
    const n = g.matched ?? g.lines.length;
    lines.push(`· ${g.path}（原文 ${g.total ?? '?'} 行，筛出 ${n} 条像出错的，这里给最后 ${g.lines.length} 条）`);
    for (const line of g.lines) lines.push(`   ${line}`);
  }
  lines.push('');

  if (f.warnings?.length) {
    lines.push('## 这个工具自己没做成的事（别当成"没问题"）');
    for (const w of f.warnings) lines.push(`· ${w}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('这份文件是**只读**诊断的结果：它没有改过任何设置，也不需要联网。');
  lines.push('回传方式：把**整个文件**发回给我们（微信/邮件/截图「## 摘要」那一段都行）。');
  lines.push('里面可能含路径与日志片段，token 一类字段已自动打码；如果里面有不想给我们看的东西，');
  lines.push('删掉那几行再发也行 —— 但请保留「## 摘要」那一段，那一段是判断问题用的。');

  return redactSecrets(lines.join('\n'));
}

function humanBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '?';
  const mb = bytes / 1048576;
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

/**
 * 交给同事的那个 `.bat`：**纯 ASCII**。
 *
 * 为什么必须是纯 ASCII（这是个真坑，不是洁癖）：cmd 是**逐行执行、按当前码页解码**的，
 * 而简体中文机器的码页是 936（GBK）、我们仓库里存的是 UTF-8 —— 中文直接写进 `.bat`，
 * 用户双击看到的是乱码，运气不好连解析都失败。所以：
 *   · `.bat` 里**一个非 ASCII 字节都不放**（注释、提示语全用英文）；
 *   · 中文提示与整份报告由 **node** 打印（`chcp 65001` 之后的输出才是 UTF-8）；
 *   · `chcp` 之后的行仍是 ASCII ⇒ 两种码页下解码结果相同 ⇒ 中途切码页是安全的。
 */
export function batSource() {
  return [
    '@echo off',
    'setlocal',
    'rem  U-disk self-check - READ ONLY. Run this from the U disk. All Chinese text is printed by node.',
    `rem  Finds a node.exe by itself, then runs ${TOOL_SCRIPT_NAME}.`,
    'set "HERE=%~dp0"',
    // ⚠️ 必须先去掉尾反斜杠：`%~dp0` 是 `…\\诊断工具\\`，`--here "%HERE%"` 里的 `\\"` 会把右引号**吃掉**，
    //    node 收到的参数会变成 `C:\\…\\诊断工具" \\荣盈魔方-诊断结果.txt` ⇒ 报告写不出来。
    //    （拿交付包自带的 node.exe 端到端实测，见测试 ⑦ 与测试 ⑩。）
    'if "%HERE:~-1%"=="\\" set "HERE=%HERE:~0,-1%"',
    'set "NODE="',
    'rem  1) a node.exe sitting right next to this script',
    'if exist "%HERE%\\node.exe" set "NODE=%HERE%\\node.exe"',
    'rem  2) the node shipped inside the delivery package: look for a folder holding',
    'rem     resources\\runtime\\node\\node.exe - in this folder, its parent, and the drive root',
    'rem     (so it works whether this tool sits beside the app folder or inside it)',
    'rem     NOTE: write the drive root as drive-letter plus a trailing backslash (see the third',
    'rem     entry below). Without that backslash cmd expands it to the drive CURRENT directory',
    'if not defined NODE for %%R in ("%HERE%" "%HERE%\\.." "%~d0\\") do (',
    '  for /d %%D in ("%%~fR\\*") do (',
    '    if not defined NODE if exist "%%~fD\\resources\\runtime\\node\\node.exe" set "NODE=%%~fD\\resources\\runtime\\node\\node.exe"',
    '  )',
    ')',
    'rem  3) whatever node is on PATH',
    'if not defined NODE for /f "delims=" %%N in (\'where node 2^>nul\') do if not defined NODE set "NODE=%%N"',
    'if not defined NODE (',
    '  echo [diagnose] node.exe not found.',
    '  echo [diagnose] Put this folder on the SAME U disk as the app folder - the folder that',
    '  echo [diagnose] holds resources\\runtime\\node\\node.exe - and double-click this file again.',
    '  echo [diagnose] Nothing has been changed. Press any key to close.',
    '  pause >nul',
    '  exit /b 2',
    ')',
    'chcp 65001 >nul',
    `"%NODE%" "%HERE%\\${TOOL_SCRIPT_NAME}" --here "%HERE%" %*`,
    'echo.',
    'echo [diagnose] finished. Please send back the report file that was just written here.',
    'pause',
    '',
  ].join('\r\n');
}
