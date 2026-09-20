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
 * ⚠️ **只读**。会写盘的一共两下，都是**它自己的临时探针**，建完立刻删：盘根一个几字节
 *    的文件（测可写性 "装不上"的一大类原因就是这个）、盘根一个空目录 + 一个 junction
 *    （测"这块盘到底能不能建链接" —— FAT/exFAT 不支持 reparse point）。两句都能用
 *    `--no-write-test` 关掉（关掉时报告里照实写"没测"，不当成"没问题"）。
 *
 * ⚠️ **本模块不 import fs、不起进程**：要么是纯函数，要么副作用全部由调用方注入
 *    （`probeLinkCapability` 拿的是 `fsLike`）—— 判据要能用夹具测，CLI 才碰真机器。
 * ⚠️ 所有路径按 **Windows 语义**（`path.win32`）拼 —— 这是个 Windows 专用工具，
 *    不跟着宿主平台变（测试因此在任何平台上都得到同一份期望值）。
 */

import path from 'node:path';

const W = path.win32;

/** 盘上应用数据目录名（与 `runtime/portable-app-data.ts` 的 `PORTABLE_APP_DATA_DIR_NAME` 同名）。 */
export const PORTABLE_USER_DATA_DIR_NAME = '荣盈魔方-运行数据';
/**
 * 交付夹最多埋在卷根下几层（与 `workspace/portable.ts` 的 `MAX_DELIVERY_DEPTH` 同名同值）。
 * ⚠️ 这个数**照抄**源码：抄错 ⇒ 诊断会把"埋太深的本机目录"说成盘上形态（或反过来）。
 */
export const MAX_DELIVERY_DEPTH = 2;
/**
 * 安装形态的常见位置段（镜像 `workspace/portable.ts` 的 `INSTALL_DIR_SEGMENTS` 三条正则）。
 * 命中任一段就不算交付夹 —— 用户完全可能把安装版装在 `D:\Program Files\荣盈魔方`。
 */
export const INSTALL_DIR_SEGMENTS = ['Program Files', 'Program Files (x86)', 'Programs', 'AppData'];
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
 * 交付形态那几条事实（镜像 `workspace/portable.ts` 的 `isDeliveryLayout`）。
 *
 * 现场（2026-09-20 同事那份 0.0.24）：交付说明让用户"解压到 U 盘根目录"，而不少
 * U 盘/移动固态/读卡器被 Windows 报成 `DriveType=3`（固定盘）⇒「枚举可移动盘」永远
 * 不命中；盘根 marker 又是说明里叮嘱"千万别拷"的文件 ⇒ 老两条判据全落空。
 * 交付形态认的是**我们自己的包**：`<盘根>\…\荣盈魔方\resources\runtime\<manifest>`。
 *
 * 四条与源码一一对应：深度 ≤ `MAX_DELIVERY_DEPTH`、路径里没有安装形态的段、
 * 夹子里真有随包运行时清单（`hasBundledRuntime`）。
 *（源码里还有一条"resources 必须是 exe 自己那份"—— 本工具找夹子时就按
 *  `<夹子>\resources\runtime\` 找，天然成立，不再重复判。）
 *
 * ⚠️ 传进来的 `volumeRoot` **按原样用**（不规范化成盘符根）：本工具拿 `--volume-root`
 *    当"这块盘"的根，端到端测试里它是临时目录；规范化会把任何路径都变成 `C:\`。
 */
export function deliveryLayoutOf({ volumeRoot, appDir, hasBundledRuntime }) {
  const miss = {
    isLayout: false,
    appDir: appDir ?? null,
    depth: null,
    blockedSegment: null,
    hasBundledRuntime: Boolean(hasBundledRuntime),
  };
  if (!volumeRoot || !appDir) return miss;

  const root = String(volumeRoot).replace(/[\\/]+$/, '');
  const rel = W.relative(root, appDir);
  if (!rel || rel.startsWith('..') || W.isAbsolute(rel)) return miss;

  const segments = rel.split(/[\\/]+/).filter(Boolean);
  const blocked = segments.find((s) => INSTALL_DIR_SEGMENTS.some((d) => d.toLowerCase() === s.toLowerCase())) ?? null;
  const depth = segments.length;
  return {
    isLayout: depth > 0 && depth <= MAX_DELIVERY_DEPTH && blocked === null && Boolean(hasBundledRuntime),
    appDir,
    depth,
    blockedSegment: blocked,
    hasBundledRuntime: Boolean(hasBundledRuntime),
  };
}

/**
 * 这块盘会被判成"盘上运行"吗 —— 判据**照抄** `decidePortableAppData`（顺序也照抄）。
 *
 * ⚠️ 这是**镜像**，不是引用：运行时改了顺序这里要跟着改（队列里记着这条风险）。
 *    但哪怕它过期，报告里也同时列了原始事实（marker 有没有、DriveType 几、交付夹几层），
 *    后人能自己重判。
 */
export function decidePortable({
  volumeRoot,
  systemDrive,
  driveType,
  hasRuntimeMarker,
  hasWorkspaceMarker,
  deliveryLayout,
}) {
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
  if (deliveryLayout?.isLayout) {
    return {
      code: 'delivery-layout',
      portable: true,
      reason: `exe 就在我们自己的交付夹里（盘根下 ${deliveryLayout.depth} 层 + 夹子里有随包运行时）⇒ 认`,
      explain:
        `交付夹形状（${deliveryLayout.appDir}，盘根下 ${deliveryLayout.depth} 层，` +
        `里面有 resources\\runtime\\${RUNTIME_MANIFEST_FILE}）` +
        ` ⇒ 按"盘上运行"处理：数据落 <盘根>\\${PORTABLE_USER_DATA_DIR_NAME}\\。` +
        `⚠️ 这条判据是 2026-09-20 补的：DriveType=3 的盘上「枚举可移动盘」永远不命中，` +
        `只有它能认出"这就是我们发出去的那份"。`,
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
    reason: '三条判据都不命中 ⇒ 不认',
    explain:
      `三块判据都没命中：盘根没有 ${RUNTIME_MANIFEST_FILE}、` +
      `盘里没有 ${PORTABLE_WORKSPACE_DIR_NAME}\\${WORKSPACE_MARKER_FILE}、` +
      `exe 也不在我们自己的交付夹里${deliveryFactsNote(deliveryLayout)}、` +
      `也不在 DriveType=2 的可移动盘列表里（这块盘 DriveType=${driveType ?? '?'}，` +
      `${driveTypeName(driveType ?? -1)}）` +
      ` ⇒ 数据落本机 %APPDATA%、工作区落用户主目录。` +
      `⚠️ 这正是"换台机器/换个口就找不到数据"的那条链：判成非便携之后，连"把正在运行的那块盘当候选"的能力也一起丢掉了。`,
  };
}

/** "没认成交付夹"的那点事实（深度/被哪一段挡下/有没有随包运行时）—— 报告里要能看出为什么。 */
function deliveryFactsNote(layout) {
  if (!layout) return '（没扫到任何带随包运行时的夹子）';
  const bits = [];
  if (layout.appDir) bits.push(`扫到 ${layout.appDir}`);
  if (layout.depth !== null && layout.depth !== undefined) bits.push(`盘根下 ${layout.depth} 层`);
  if (layout.blockedSegment) bits.push(`命中安装位置段 ${layout.blockedSegment}`);
  if (!layout.hasBundledRuntime) bits.push(`夹子里没有 ${RUNTIME_MANIFEST_FILE}`);
  return bits.length ? `（${bits.join('；')}）` : '（没扫到任何带随包运行时的夹子）';
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

// ─────────────────── 「这块盘到底能不能装」：链接（reparse point）能力探测 ───────────────────
//
// 为什么要有这一段（T-a28 候选 D，见队列第十刀"这条对方案的影响"）：
// 同事那台机器上还剩两个活口，其中一条是**文件系统能力** —— FAT/exFAT 建不了 reparse
// point（junction）⇒ 网关的 `plugin-skills\*` 链接**根本建不出来**，它只 `log.warn` 一句，
// 用户看到的就是「插件用不了」。而本机四个卷**全是 NTFS** ⇒ 这个前提在我们这边造不出来。
//
// ➡ 所以判据不是"查文件系统类型猜能不能"，而是**在这块盘上真建一个 junction 再删掉**，
//    然后把结果与 `Win32_LogicalDisk.FileSystem` 报出来的类型**并列**写进报告：
//    · 建不成 + FAT/exFAT ⇒ 与"这类文件系统不支持 reparse point"一致 ⇒ 让用户换 NTFS 的盘
//      （⚠️ 我们手上没有这类卷，这句话是按 Windows 的设计说的，报告里必须写明"没实测过"）；
//    · 建不成 + NTFS ⇒ **不把话说死**，只把原文给出去（可能是杀软/权限/只读）；
//    · 没测（--no-write-test / 探针没建起来）⇒ 照实写"没测"，绝不当成"没问题"。

/** 探针目录名前缀。唯一命名（带 pid）⇒ 绝不会撞上盘上别人的东西。 */
export const LINK_PROBE_DIR_PREFIX = '.clawwork-link-test-';

/**
 * 在这块盘上真建一个 junction 再删掉（**依赖注入**：本模块不 import fs，见文件头那条纪律）。
 *
 * ⚠️ 三条纪律（测试 ⑫b/⑫c/⑫d/⑫e 逐条钉着）：
 *   ① 探针目录用 **非递归** `mkdirSync` 建：名字被别人占用了就该失败 ⇒ 报"没测"，
 *      **绝不**用递归建/递归删去"清开一条路"（那是能删掉用户数据的动作）；
 *   ② 收尾只删**自己刚建的那两个**，而且顺序是 **先摘链接 → 再删空目录**：
 *      `rmSync(dir, {recursive:true})` 会**沿着 junction 进目标目录**（本仓库栽过一次，
 *      删过真身）⇒ 这里一次递归删都没有；
 *   ③ 删不掉的要**列出来**（`leftBehind`），报告照实说"我们在你盘上留了个目录"。
 *
 * @param {{ volumeRoot: string, probeName: string, fsLike: {
 *   lstatSync: (p: string) => unknown,
 *   mkdirSync: (p: string, o?: object) => unknown,
 *   symlinkSync: (t: string, l: string, k?: string) => unknown,
 *   unlinkSync: (p: string) => unknown,
 *   rmdirSync: (p: string) => unknown,
 * } }} args
 */
export function probeLinkCapability({ volumeRoot, probeName, fsLike }) {
  const dir = W.join(volumeRoot, probeName);
  const target = W.join(dir, 'target');
  const link = W.join(dir, 'link');
  const errText = (err) => (err instanceof Error ? err.message : String(err));
  const errCode = (err) => (err && typeof err === 'object' && err.code ? String(err.code) : null);

  try {
    // ⚠️ 非递归（见纪律 ①）：EEXIST 时这里就抛，下面照实报"没测"
    fsLike.mkdirSync(dir);
  } catch (err) {
    return {
      volumeRoot,
      dir,
      tested: false,
      ok: false,
      errorCode: errCode(err),
      errorMessage: errText(err),
      leftBehind: [],
      message: `探针目录没建起来（${errText(err)}）⇒ 这一条没测`,
    };
  }

  let outcome;
  try {
    fsLike.mkdirSync(target);
    fsLike.symlinkSync(target, link, 'junction'); // ← 真正要测的那一下
    outcome = { tested: true, ok: true, errorCode: null, errorMessage: null };
  } catch (err) {
    outcome = { tested: true, ok: false, errorCode: errCode(err), errorMessage: errText(err) };
  }

  // 收尾（纪律 ②③）：先摘链接、再删空目录；删不掉的列出来
  for (const [p, how] of [
    [link, 'unlinkSync'],
    [target, 'rmdirSync'],
    [dir, 'rmdirSync'],
  ]) {
    try {
      fsLike[how](p);
    } catch {
      /* 本来就没有（比如链接那一下没建成）不算错；真没删掉由下面 existsSync 兜出来 */
    }
  }
  // ⚠️ 用 `lstatSync` 而**不是** `existsSync`：后者会**跟随链接** —— 一个"摘不掉、目标又已经被
  //    删掉"的悬空链接，`existsSync` 会说"不存在"，我们就会**静默少报**一条留在别人盘上的东西。
  //    （这一条是测试 ⑫e 当场抓到的：第一版就是 `existsSync`，实到只报了目录、没报链接。）
  const leftBehind = [link, target, dir].filter((p) => {
    try {
      fsLike.lstatSync(p);
      return true;
    } catch {
      return false;
    }
  });

  return { volumeRoot, dir, ...outcome, leftBehind, message: outcome.ok ? '建成了（已删干净）' : '建失败了' };
}

/** 文件系统是不是 FAT 家族（这类**按设计**不支持 reparse point）。 */
const FAT_FAMILY = /^(fat|fat16|fat32|vfat|exfat)$/i;

/**
 * 把探测结果判成能写进报告的三句话（纯函数）：`headline`（短，进摘要）/ `detail`（带原文）/
 * `advice`（下一步 + 诚实边界）。
 */
export function classifyLinkProbe(f) {
  const raw = [f.errorCode, f.errorMessage].filter(Boolean).join('：') || '（没有错误信息）';

  if (!f.tested) {
    return {
      verdict: 'untested',
      tested: false,
      headline: '链接能力：没测',
      detail: `链接能力：没测（${f.errorMessage ?? '这一条没跑'}）`,
      advice: '这一条没测 ⇒ **别当成"能建链接"**（插件/技能这类找"随包运行时"的功能就靠链接）。',
    };
  }

  if (f.ok) {
    return {
      verdict: 'ok',
      tested: true,
      headline: '链接能力：能建',
      detail: '链接能力：能建（在这块盘上真建了一个 junction 又删掉了）',
      advice: '',
    };
  }

  const fsType = typeof f.fileSystem === 'string' && f.fileSystem.trim().length > 0 ? f.fileSystem.trim() : null;
  if (fsType && FAT_FAMILY.test(fsType)) {
    return {
      verdict: 'unsupported',
      tested: true,
      headline: `链接能力：建不了 —— 换一块 NTFS 的盘`,
      detail: `链接能力：建不了（${raw}）`,
      advice:
        `这块盘的文件系统是 ${fsType}：FAT/exFAT **按设计**就不支持 reparse point（junction）⇒ ` +
        `插件、技能这类功能在这块盘上用不了 —— **换一块 NTFS 的盘**。` +
        '（⚠️ 这条是按 Windows 的设计说的：我们手上没有 FAT/exFAT 的卷 ⇒ **没实测**过。）',
    };
  }

  return {
    verdict: 'failed',
    tested: true,
    headline: '链接能力：建不了（原因见下面「## 盘」那节的原文）',
    detail: `链接能力：建不了（${raw}）`,
    advice:
      `文件系统是 ${fsType ?? '读不出来'}：这本该能建链接 ⇒ 这一次失败的原因要看上面那句原文` +
      '（常见：杀软拦、目录只读、权限）。把这一行原样发回来即可。',
  };
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
  // ⭐ 「这块盘能不能装」要在摘要里（同事常常只截这一段）：建不了时摘要就得带上"换 NTFS 的盘"
  if (f.linkProbe) {
    const cap = classifyLinkProbe(f.linkProbe);
    lines.push(`   ${cap.headline}`);
  }
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
  if (f.deliveryLayout) {
    const d = f.deliveryLayout;
    lines.push(
      `交付夹形状（盘根下 ≤${MAX_DELIVERY_DEPTH} 层 + resources\\runtime\\${RUNTIME_MANIFEST_FILE}）：` +
        (d.appDir
          ? `${d.isLayout ? '认' : '不认'} —— ${d.appDir}` +
            `（盘根下 ${d.depth} 层${d.blockedSegment ? `；命中安装位置段 ${d.blockedSegment}` : ''}` +
            `${d.hasBundledRuntime ? '' : `；夹子里没有 ${RUNTIME_MANIFEST_FILE}`}）`
          : '没扫到（盘根与它下一层都没有带随包运行时的夹子）'),
    );
  }
  lines.push(
    `工作区 marker（${PORTABLE_WORKSPACE_DIR_NAME}\\${WORKSPACE_MARKER_FILE}）：${yesNo(f.markers?.workspace)}`,
  );
  if (f.writable) {
    lines.push(
      `可写性：${f.writable.tested ? (f.writable.ok ? '能写' : `写不进去（${f.writable.message}）`) : `没测（${f.writable.message}）`}`,
    );
  }
  if (f.linkProbe) {
    const cap = classifyLinkProbe(f.linkProbe);
    lines.push(cap.detail);
    if (cap.advice) lines.push(`   → ${cap.advice}`);
    if (f.linkProbe.leftBehind?.length) {
      lines.push(`   ⚠️ 探针自己没删掉：${f.linkProbe.leftBehind.join('；')} —— 这几样是本工具建的，可以手动删`);
    }
    // 只在"不正常"时才写它建在哪（正常时这一行是噪声；要排查"为什么说没测"时它才有用）
    if (f.linkProbe.dir && (!f.linkProbe.ok || f.linkProbe.leftBehind?.length))
      lines.push(`   （探针本来要建在 ${f.linkProbe.dir}）`);
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
  lines.push(
    '（会动盘的地方只有它自己的两个**临时探针**：盘根一个几字节的文件、一个空目录 + 一个链接，' +
      '建完就删；`--no-write-test` 时连这两下都不做。链接探针的结果见「## 盘」那节。）',
  );
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
