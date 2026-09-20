/**
 * U 盘交付包：**"双击盘里的 exe 就能用、不用 .bat"** 这件事的机检（不是文档，是闸门）。
 *
 * 为什么要有它：`.bat` 被去掉这件事**只有新构建才安全**。老构建抢不到单实例锁时是
 * 裸 `app.quit()` —— 用户看到的是"双击了没反应"，那个 `.bat` 正是为此存在的。
 * 所以"去掉 .bat"和"构建里带新启动行为"必须绑在一起，而这个绑定**只能靠机器检查**：
 * 手写清单会在第 N 次换构建时悄悄失效（清单不更新 = 假绿）。
 *
 * 三条硬规则（各自对应一次真实事故或一次真实的返工）：
 * ① 构建里必须能读到自解释文案的指纹 —— 否则**不许**去掉 `.bat`；
 * ② 交付包必须自带运行时（`<app>/resources/runtime/openclaw-runtime-manifest.json`）——
 *    2026-09-18 那次"装完完全用不了"就是包里没有运行时；
 * ③ 说明里教的入口必须是真的那个（双击 `<app>\<exe>`）—— 说明教用户点一个不存在的
 *    文件，比没有说明更坏。
 *
 * ⚠️ 判据是**文件名与文件内容**，不是"人工确认过"：三个常量都要与 TS 源码对齐，
 *    有守卫测盯着（`udisk-delivery.test.mjs` 的漂移用例）—— 改名字不改这里会红。
 * ⚠️ 本模块**不碰文件系统**（全注入），也不抛：它要能在任何机器上跑、结论要能读。
 */

import path from 'node:path';

/** 程序目录名与 exe 名（`electron-builder.yml` 的 `productName` 决定的）。 */
export const APP_DIR_NAME = '荣盈魔方';
export const EXE_NAME = '荣盈魔方.exe';
/** 交付包里那份人话说明（人手写，**不覆盖**：里面还有版本更新记录）。 */
export const README_NAME = '使用说明.txt';
/** 盘根那个启动器 —— 新版交付包**不带**它（它唯一在做的事已搬进程序）。 */
export const LAUNCHER_BAT_NAME = '①双击这里启动.bat';
/** "装到电脑才用"那个文件夹（U 盘交付包不放它，放了就是把用户引向安装版）。 */
export const INSTALLER_DIR_PREFIX = '⚠️装到电脑才用';
/** 认盘/认运行时的 marker（与 `runtime/locate.ts` 的 `RUNTIME_MANIFEST_FILE` 同名）。 */
export const RUNTIME_MANIFEST_NAME = 'openclaw-runtime-manifest.json';
/** 盘上数据目录名（与 `runtime/portable-app-data.ts` 的 `PORTABLE_APP_DATA_DIR_NAME` 同名）。 */
export const RUN_DATA_DIR_NAME = '荣盈魔方-运行数据';
/** 交付包里的相对路径。 */
export const EXE_REL = path.join(APP_DIR_NAME, EXE_NAME);
export const ASAR_REL = path.join(APP_DIR_NAME, 'resources', 'app.asar');
export const BUNDLED_RUNTIME_MANIFEST_REL = path.join(APP_DIR_NAME, 'resources', 'runtime', RUNTIME_MANIFEST_NAME);

/**
 * "这份构建自己会解释"的指纹 —— `instance-guard.ts` 里 `buildInstanceBusyCopy` 的标题。
 *
 * ⚠️ 换文案就要换这里（守卫测会红）—— 但**别换成一句会随风改的界面文字**：
 *    它代表的是"这个二进制里有自解释文案"这个能力，选的是**标题**这种最稳的字面量。
 */
export const INSTANCE_BUSY_TITLE = '荣盈魔方已经在运行';

/** `--fix` 把移除物搬到交付包**外面**的哪个目录（放里面会被一起复制到 U 盘）。 */
export const REMOVED_DIR_PREFIX = '_U盘交付-已移除';

/**
 * 字节流里有没有这个字符串 —— 原文 + `\uXXXX` 转义（大/小写）三种形态都试。
 *
 * ⚠️ 为什么不能只试原文：打包器可能把非 ASCII 转义成 `\uXXXX`（esbuild 的
 *    `charset` 开关就会这么干，实测这个仓库当前是原文）。只认原文的话，
 *    换了打包器就会"看不见指纹" ⇒ 交付闸门误报"构建太老"。
 */
export function bufferHasString(buf, s) {
  if (!buf || !s) return false;
  const needle = Buffer.from(s, 'utf8');
  if (buf.includes(needle)) return true;

  const hex = (up) =>
    [...s]
      .map((c) => {
        const code = c.charCodeAt(0);
        if (code <= 127) return c;
        const h = code.toString(16).padStart(4, '0');
        return `\\u${up ? h.toUpperCase() : h}`;
      })
      .join('');

  return buf.includes(Buffer.from(hex(true), 'utf8')) || buf.includes(Buffer.from(hex(false), 'utf8'));
}

/**
 * 说明文件有没有"教用户去做一件不可能做成的事"。
 *
 * 只查三件最容易过期的事（**不查文风**）：入口是不是还在讲 `.bat`、有没有点名
 * `<exe>`、有没有写清数据落在盘上（数据在盘上是这个产品的卖点，也是"拔盘前先退出"
 * 这条注意事项的前提）。
 */
export function readmeProblems(text) {
  const flat = String(text ?? '').replace(/\s+/g, ' ');
  const problems = [];
  if (flat.includes('双击这里启动')) problems.push(`还在教用户双击「${LAUNCHER_BAT_NAME}」`);
  if (!flat.includes(EXE_NAME)) problems.push(`没点名入口 ${APP_DIR_NAME}\\${EXE_NAME}`);
  if (!flat.includes('双击')) problems.push('没写"双击"这个动作（用户要找的是一句话）');
  if (!flat.includes(RUN_DATA_DIR_NAME)) problems.push(`没写数据落在盘上的 ${RUN_DATA_DIR_NAME}\\`);
  return problems;
}

/**
 * 交付包体检。`io` 全部注入（真机上是 fs，测试里是临时目录）：
 * `exists(p)` / `listNames(dir)` / `readFile(p) => Buffer|null`。
 *
 * 返回的 findings 里 `level: 'error'` 表示**别发这个包**，`warn` 表示"能发，但先说清"。
 */
export function auditDelivery(io, root) {
  const findings = [];
  const at = (...parts) => path.join(root, ...parts);

  const hasExe = io.exists(at(EXE_REL));
  const hasAsar = io.exists(at(ASAR_REL));
  if (!hasExe) {
    findings.push({
      id: 'missing-exe',
      level: 'error',
      title: `找不到 ${EXE_REL}`,
      detail: `这个目录看着不像交付包：程序目录里必须有 ${EXE_NAME}。`,
    });
  }
  if (!hasAsar) {
    findings.push({
      id: 'missing-asar',
      level: 'error',
      title: `找不到 ${ASAR_REL}`,
      detail: '没有 app.asar 就没法判断"这份构建带不带自解释文案" —— 换一份完整构建再检查。',
    });
  }
  if (!io.exists(at(BUNDLED_RUNTIME_MANIFEST_REL))) {
    findings.push({
      id: 'missing-bundled-runtime',
      level: 'error',
      title: '交付包没自带运行时',
      detail:
        `缺 ${BUNDLED_RUNTIME_MANIFEST_REL}。干净机器上装完会"完全用不了"` +
        '（0.0.19 的真实事故）；盘上形态还要靠它避免每次换机器重新解压。',
    });
  }

  const asar = hasAsar ? io.readFile(at(ASAR_REL)) : null;
  const selfExplains = asar ? bufferHasString(asar, INSTANCE_BUSY_TITLE) : null;
  if (selfExplains === false) {
    findings.push({
      id: 'stale-build',
      level: 'error',
      title: '这份构建还不带"自解释"行为（不能去掉 .bat）',
      detail:
        `在 app.asar 里找不到指纹「${INSTANCE_BUSY_TITLE}」。这种构建抢不到单实例锁时是静默退出 ——` +
        `用户双击第二次看到的就是"没反应"，所以它**必须**靠 ${LAUNCHER_BAT_NAME} 去解释。`,
    });
  }

  const names = io.listNames(root);
  const hasBat = names.includes(LAUNCHER_BAT_NAME);
  if (hasBat && selfExplains === true) {
    findings.push({
      id: 'launcher-bat',
      level: 'error',
      title: `还在用 ${LAUNCHER_BAT_NAME}`,
      detail:
        '新构建自己会说清"已经在运行"和"端口被占"，这个 .bat 已经没有存在理由；' +
        '留着它反而让用户以为"必须走启动器"，而且它教的那条路（从盘根启动）和托盘退出的口径会打架。',
      fix: { kind: 'move-out', name: LAUNCHER_BAT_NAME },
    });
  }
  if (!hasBat && selfExplains === false) {
    findings.push({
      id: 'no-explainer',
      level: 'error',
      title: '既没有 .bat，构建又不会自解释',
      detail:
        '这一版发出去，用户双击第二份时**什么都不会发生**（连一句人话都没有）。换成带新启动行为的构建，或把 .bat 放回来。',
    });
  }

  if (names.some((n) => n.startsWith(INSTALLER_DIR_PREFIX))) {
    findings.push({
      id: 'installer-folder',
      level: 'warn',
      title: 'U 盘交付包里带着"装到电脑"的安装包',
      detail:
        '产品口径是 U 盘即插即用（AI U 盾）：同一个包裹里放安装包，会让一部分用户装到电脑上，' +
        '此后 U 盘这份就总是"端口被占用"（两份抢 18789）。要发安装版就单独做一个交付夹。',
    });
  }

  const readmeText = io.exists(at(README_NAME)) ? io.readFile(at(README_NAME))?.toString('utf8') : null;
  if (readmeText === null) {
    findings.push({
      id: 'readme-missing',
      level: 'warn',
      title: `没有 ${README_NAME}`,
      detail: '交付包至少要有一句话：双击哪个文件、数据存在哪儿。',
    });
  } else {
    const problems = readmeProblems(readmeText);
    if (problems.length > 0) {
      findings.push({
        id: 'readme-stale',
        level: 'warn',
        title: `${README_NAME} 和这份交付包对不上`,
        detail: problems.map((p) => `· ${p}`).join('\n'),
      });
    }
  }

  return findings;
}

/** `--fix` 的动作清单（纯函数：给 findings 就能算，测试里好钉）。 */
export function planFixes(findings, root, stamp) {
  const actions = [];
  for (const f of findings) {
    if (!f.fix) continue;
    if (f.fix.kind === 'move-out') {
      actions.push({
        kind: 'move-out',
        from: path.join(root, f.fix.name),
        to: path.join(root, '..', `${REMOVED_DIR_PREFIX}-${stamp}`, f.fix.name),
        why: f.title,
      });
    }
  }
  return actions;
}

/** 从交付夹名字里取版本（`荣盈魔方U盘交付-0.0.24` → `0.0.24`）；取不到 null。 */
export function versionFromFolderName(folderName) {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s*$/.exec(String(folderName ?? ''));
  return m ? m[1] : null;
}
