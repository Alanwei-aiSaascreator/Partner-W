#!/usr/bin/env node
/**
 * U 盘交付包体检 / 整理（发版前跑一次）。
 *
 * 用法：
 *   node scripts/udisk-delivery.mjs <交付包目录>          # 只看，不动文件
 *   node scripts/udisk-delivery.mjs <交付包目录> --fix     # 顺手把该搬走的搬走
 *
 * 例：node scripts/udisk-delivery.mjs "D:\\Desktop\\荣盈魔方U盘交付-0.0.25"
 *
 * 退出码：0 = 没有 error（warn 也会打印，但放行）；1 = 有 error，别发这个包。
 *
 * ⚠️ `--fix` **只搬不删**：移走的东西放到交付包**外面**的
 *    `<父目录>\_U盘交付-已移除-<时间戳>\`，原样保留（发出去之前你自己确认一遍）。
 * ⚠️ 这个脚本**不打任何包**，只检查/整理已经打好的交付夹（发版那条线仍然人工跑）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { auditDelivery, planFixes, versionFromFolderName } from './lib/udisk-delivery.mjs';

const io = {
  exists: (p) => fs.existsSync(p),
  listNames: (dir) => fs.readdirSync(dir),
  walkNames: (root) => {
    const names = [];
    const walk = (directory, prefix) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        names.push(relative);
        if (entry.isDirectory() && !entry.isSymbolicLink()) walk(path.join(directory, entry.name), relative);
      }
    };
    walk(root, '');
    return names;
  },
  readFile: (p) => {
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  },
};

const USAGE = [
  '用法：node scripts/udisk-delivery.mjs <交付包目录> [--fix]',
  '  <交付包目录>  形如 D:\\Desktop\\荣盈魔方U盘交付-0.0.25（里面是 荣盈魔方\\ + 使用说明.txt）',
  '  --fix         把该搬走的（比如那个 .bat）搬到交付包外的 _U盘交付-已移除-<时间戳>\\',
].join('\n');

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function report(root, findings, { afterFix } = {}) {
  const errs = findings.filter((f) => f.level === 'error');
  const warns = findings.filter((f) => f.level === 'warn');
  const version = versionFromFolderName(path.basename(root));

  console.log(`交付包：${root}${version ? `（版本 ${version}）` : '（夹名里没看出版本号，自己核一下）'}`);
  if (afterFix) console.log('（下面是 --fix 之后的复检结果）');
  console.log('');

  if (findings.length === 0) {
    console.log('✅ 这份交付包通过机检：用户入口是盘根的 荣盈魔方启动器.exe。');
    return 0;
  }

  for (const f of errs) {
    console.log(`❌ ${f.title}`);
    console.log(`   ${f.detail.split('\n').join('\n   ')}`);
    console.log('');
  }
  for (const f of warns) {
    console.log(`⚠️  ${f.title}`);
    console.log(`   ${f.detail.split('\n').join('\n   ')}`);
    console.log('');
  }

  console.log(`小计：${errs.length} 个错误、${warns.length} 个提醒。`);
  if (errs.length > 0) {
    console.log('错误没清掉之前别发 —— 用户那边就是这样变成"双击了没反应"的。');
    return 1;
  }
  console.log('没有错误，可以发（上面那些提醒请人工确认一遍）。');
  return 0;
}

function main(argv) {
  const args = argv.filter((a) => a !== '--fix');
  const root = args[0];
  const doFix = argv.includes('--fix');

  if (!root) {
    console.log(USAGE);
    return 2;
  }
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    console.log(`不是个目录：${root}`);
    console.log(USAGE);
    return 2;
  }

  let findings = auditDelivery(io, root);
  const code = report(root, findings);
  if (!doFix) return code;

  const actions = planFixes(findings, root, stamp());
  if (actions.length === 0) {
    console.log('\n--fix：没有需要搬走的东西。');
    return code;
  }

  console.log('\n--fix：');
  for (const a of actions) {
    try {
      fs.mkdirSync(path.dirname(a.to), { recursive: true });
      fs.renameSync(a.from, a.to);
      console.log(`   已搬走：${a.from}`);
      console.log(`        →  ${a.to}`);
    } catch (err) {
      console.log(`   搬不动（${err instanceof Error ? err.message : String(err)}）：${a.from}`);
    }
  }

  findings = auditDelivery(io, root);
  console.log('');
  return report(root, findings, { afterFix: true });
}

process.exit(main(process.argv.slice(2)));
