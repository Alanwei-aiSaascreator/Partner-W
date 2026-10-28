/**
 * E2E 临时目录盘点 / 清理工具。
 *
 * 跑法：
 *   node scripts/e2e-temp-audit.ts              # **只盘点，不删任何东西**（默认）
 *   node scripts/e2e-temp-audit.ts --sweep      # 按保留策略清理
 *   node scripts/e2e-temp-audit.ts --root <dir> # 换一个根
 *
 * ⚠️ 默认**只读**。删除必须显式 `--sweep`，且走 `e2e/helpers/temp-root.ts` 的
 * junction-safe 实现 —— 绝不 `rm -rf`，绝不跟进 reparse point。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  dirSizeBytes,
  findReparsePoints,
  isProfileName,
  listProfiles,
  profilesInUse,
  purgeProfiles,
  type ProfileEntry,
  resolveE2ETempRoot,
  sweepStaleProfiles,
} from '../e2e/helpers/temp-root.ts';

const GIB = 1024 ** 3;

function fmtBytes(n: number): string {
  if (n >= GIB) return `${(n / GIB).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function main(): void {
  const argv = process.argv.slice(2);
  const sweep = argv.includes('--sweep');
  const purge = argv.includes('--purge');
  const keepIdx = argv.indexOf('--keep');
  const keepNewest = keepIdx >= 0 && argv[keepIdx + 1] ? Number(argv[keepIdx + 1]) : 5;
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 && argv[rootIdx + 1] ? path.resolve(argv[rootIdx + 1] as string) : resolveE2ETempRoot();

  console.log(`根目录 : ${root}`);
  console.log(`TEMP   : ${os.tmpdir()}`);
  console.log('');

  // 两个位置都要看：历史上全都堆在 %TEMP%
  const roots = [root];
  const tempRoot = os.tmpdir();
  if (path.resolve(tempRoot) !== path.resolve(root)) roots.push(tempRoot);

  // ⚠️ 每个根的 profile 列表**只算一次**（每次 listProfiles 都要走一遍全部字节，
  //    262 个目录 70GB 走三遍要十几分钟 —— 实测踩过）。
  const profilesByRoot: Record<string, ProfileEntry[]> = {};

  for (const r of roots) {
    let names: string[];
    try {
      names = fs.readdirSync(r);
    } catch {
      console.log(`--- ${r}: 不存在或不可读 ---\n`);
      continue;
    }
    const profiles = names.filter(isProfileName).sort();
    if (profiles.length === 0) {
      console.log(`--- ${r}: 没有 clawwork-* 目录 ---\n`);
      continue;
    }

    console.log(`--- ${r} : ${profiles.length} 个 clawwork-* 目录 ---`);

    // 按前缀归类（看清各自是谁产生的）
    const byPrefix = new Map<string, number>();
    for (const name of profiles) {
      const m = name.match(/^clawwork-([a-z0-9]+)/i);
      const key = m ? m[1] : '(other)';
      byPrefix.set(key, (byPrefix.get(key) ?? 0) + 1);
    }
    for (const [k, v] of [...byPrefix.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(v).padStart(4)}  clawwork-${k}*`);
    }
    console.log('');

    // ⚠️ `--purge` 时**不要**量字节：那是 5 百多万次 stat，实测十几分钟，
    //    而腾空间只需要"删掉多少个"。
    const entries = listProfiles(r, !purge);
    profilesByRoot[r] = entries;
    const total = entries.reduce((s, p) => s + p.bytes, 0);
    const inUse = profilesInUse(entries.map((p) => p.path));
    const now = Date.now();

    console.log(`    合计占用 : ${fmtBytes(total)}`);
    console.log(`    在用中   : ${inUse.size}`);
    console.log('');
    console.log('    === 最大的 20 个 ===');
    for (const p of [...entries].sort((a, b) => b.bytes - a.bytes).slice(0, 20)) {
      const ageH = ((now - p.mtimeMs) / 3_600_000).toFixed(1);
      console.log(`      ${fmtBytes(p.bytes).padStart(10)}  ${ageH.padStart(7)}h  ${path.basename(p.path)}`);
    }

    const stale = entries.filter((p) => (now - p.mtimeMs) / 3_600_000 > 24);
    console.log('');
    console.log(`    超过 24h 的 : ${stale.length} 个（合计 ${fmtBytes(stale.reduce((s, p) => s + p.bytes, 0))}）`);
    console.log('');
  }

  // reparse point 审计 —— ⚠️ 必须扫**真的有 profile 的那个根**（历史遗留都在 %TEMP%）
  console.log('=== reparse point 审计 ===');
  const scanned = new Set<string>();
  for (const r of roots) {
    const all = profilesByRoot[r] ?? [];
    if (all.length === 0) continue;
    // 抽查最大的若干 + 最老的若干（老的更可能是早期版本建的，形状可能不同）
    const bySize = [...all].sort((a, b) => b.bytes - a.bytes).slice(0, 15);
    const byAge = [...all].sort((a, b) => a.mtimeMs - b.mtimeMs).slice(0, 5);
    for (const p of [...bySize, ...byAge]) {
      if (scanned.has(p.path)) continue;
      scanned.add(p.path);
      const links = findReparsePoints(p.path, 40);
      if (links.length === 0) {
        console.log(`  ${path.basename(p.path)}: 无 reparse point`);
      } else {
        console.log(`  ${path.basename(p.path)}: ${links.length} 个`);
        for (const l of links.slice(0, 10)) {
          console.log(`      ${l.path.replace(r, '<root>')}`);
          console.log(`        → ${l.target}`);
        }
      }
    }
  }
  console.log('');

  // 删除候选预估（不执行）
  const allProfiles = roots.flatMap((r) => profilesByRoot[r] ?? []);
  const ranked = [...allProfiles].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const wouldDelete = ranked.slice(keepNewest);
  const wouldFree = wouldDelete.reduce((s, p) => s + p.bytes, 0);
  console.log(`=== 若按「保留最新 ${keepNewest} 个」清理 ===`);
  console.log(`    会删除 : ${wouldDelete.length} 个`);
  console.log(`    可释放 : ${fmtBytes(wouldFree)}`);
  console.log(
    `    会保留 : ${ranked
      .slice(0, keepNewest)
      .map((p) => path.basename(p.path))
      .join(', ')}`,
  );
  console.log('');

  if (!sweep && !purge) {
    console.log('（只盘点，未删除任何东西。要清理：--sweep=保守清旧 / --purge --keep N=只留最新 N 个）');
    return;
  }

  // ⚠️ **每个根都要清**：默认根是给以后用的新位置（D:），而历史遗留全在 %TEMP%。
  //    只对着 `root` 清会"删 0 个"还显示成功（实测踩过）。
  let totalRemoved = 0;
  let totalFreed = 0;
  let totalKept = 0;
  for (const r of roots) {
    if ((profilesByRoot[r] ?? []).length === 0) continue;
    const res = purge
      ? purgeProfiles({ root: r, keepNewest, measureBytes: false, log: (m) => console.log('   ' + m) })
      : sweepStaleProfiles({ root: r, log: (m) => console.log('   ' + m) });
    console.log(`--- ${r}: 删除 ${res.removed.length} 个，保留 ${res.kept.length} 个`);
    for (const d of res.removed) console.log(`   - ${path.basename(d)}`);
    totalRemoved += res.removed.length;
    totalFreed += res.freedBytes;
    totalKept += res.kept.length;
  }
  console.log(`=== ${purge ? 'purge' : 'sweep'} 完成 ===`);
  console.log(`合计删除 ${totalRemoved} 个，释放 ${fmtBytes(totalFreed)}，保留 ${totalKept} 个`);
}

main();
