/**
 * 修复项 #5 · 诊断包导出（SPEC 二·MVP 5）。
 *
 * 「收集最近日志（脱敏）+ 配置快照（脱敏 apiKey）+ 版本/磁盘信息 → 打包 zip 到盘根
 *   （客服收件用）」。
 *
 * ## 脱敏是这一项的**核心**，不是附属功能
 *
 * 这个包会被用户**主动发出去**（微信/邮件），所以它一旦漏了凭据，就是一次主动泄露。
 * 两层：
 *   ① **键名白名单式抹除**：JSON 走结构化遍历，命中 `token|apiKey|password|secret|
 *      pairingCode|authorization|cookie` 的键一律换成 `"<redacted>"`（连键名一起留，
 *      这样客服还看得见"这里本来有个 apiKey"）。
 *   ② **日志文本按模式抹**：`rly_…` / `sk-…` / `Bearer …` / `"token":"…"`。
 * 抹不干净的部分如实写在 `meta.json` 的 `redaction` 段里，不假装完整。
 *
 * ## 不自动上传（SPEC 三·5「零外联」）
 *
 * 本模块**只落盘**。发不发出去是用户的事 —— 全流程零网络请求。
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildZip, type ZipEntry } from '../zip-write.js';
import { STATE_CONFIG_FILE, type RepairTargets } from '../targets.js';

/** 凭据类键名（命中的值一律抹掉）。 */
const SECRET_KEY_PATTERN = /(token|apikey|api_key|password|secret|pairingcode|authorization|cookie)/iu;
const REDACTED = '<redacted>';

/** 日志文本里要抹掉的模式（按序应用）。 */
const TEXT_REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\brly_[A-Za-z0-9_-]{8,}/gu, '<redacted-relay-key>'],
  [/\bsk-[A-Za-z0-9_-]{8,}/gu, '<redacted-api-key>'],
  [/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gu, 'Bearer <redacted>'],
  [/("(?:token|apiKey|api_key|password|secret)"\s*:\s*")[^"]{4,}(")/giu, `$1${REDACTED}$2`],
];

/** 单个日志文件最多带多少字节（超出保留**尾部** —— 出问题的总在最后）。 */
export const MAX_LOG_FILE_BYTES = 512 * 1024;
/** 一次最多带多少日志文件。 */
export const MAX_LOG_FILES = 20;

/** 结构化脱敏（**纯函数**）：任意 JSON 值 → 同形状、凭据位已抹。 */
export function redactJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => redactJson(item));
  if (typeof value !== 'object' || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactJson(item);
  }
  return out;
}

/** 文本脱敏（**纯函数**）。 */
export function redactText(text: string): string {
  let out = text;
  for (const [pattern, replacement] of TEXT_REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

export interface DiagnosticsInput {
  targets: RepairTargets;
  appVersion: string;
  /** 扫描报告（原样进包，客服据此对号）。 */
  scan: unknown;
  now: Date;
  /** 盘根/数据根下的落点由调用方给（盘上形态 = 盘根）。 */
  outputDir: string;
}

/** 诊断包文件名（不含目录）。 */
export function diagnosticsFileName(stamp: string): string {
  return `Partner-W-诊断包-${stamp}.zip`;
}

function readJsonSafe(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** 最近的日志文件（按修改时间倒序、有界）。 */
export function collectLogs(logsRoot: string): Array<{ name: string; data: Buffer }> {
  let names: string[];
  try {
    names = fs.readdirSync(logsRoot);
  } catch {
    return [];
  }
  const files: Array<{ file: string; mtime: number }> = [];
  for (const name of names) {
    const file = path.join(logsRoot, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      // 修复工具自己那轮的备份目录不进诊断包（否则每导一次就多一层自己）
      if (name.startsWith('repair-')) continue;
      files.push({ file, mtime: stat.mtimeMs });
    } catch {
      continue;
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);

  const out: Array<{ name: string; data: Buffer }> = [];
  for (const entry of files.slice(0, MAX_LOG_FILES)) {
    try {
      const raw = fs.readFileSync(entry.file);
      const slice = raw.length > MAX_LOG_FILE_BYTES ? raw.subarray(raw.length - MAX_LOG_FILE_BYTES) : raw;
      out.push({ name: path.basename(entry.file), data: Buffer.from(redactText(slice.toString('utf8')), 'utf8') });
    } catch {
      continue;
    }
  }
  return out;
}

/**
 * 组包并落盘。返回 zip 的绝对路径；**永不抛**（失败返回 `null` 由调用方如实报）。
 */
export function writeDiagnosticsPack(input: DiagnosticsInput, stamp: string): string | null {
  const { targets } = input;
  const entries: ZipEntry[] = [];

  const meta = {
    generatedAt: input.now.toISOString(),
    appVersion: input.appVersion,
    platform: process.platform,
    arch: process.arch,
    portable: targets.portable,
    volumeRoot: targets.volumeRoot,
    programDir: targets.programDir,
    dataRoot: targets.dataRoot,
    stateDirs: targets.stateDirs,
    candidateStateRoots: targets.candidateStateRoots,
    exePath: process.execPath,
    redaction: {
      jsonKeys: SECRET_KEY_PATTERN.source,
      textPatterns: TEXT_REDACTIONS.map(([pattern]) => pattern.source),
      note: 'redaction is best-effort; review before sharing',
    },
  };
  entries.push({ name: 'meta.json', data: Buffer.from(JSON.stringify(meta, null, 2), 'utf8') });

  entries.push({ name: 'scan.json', data: Buffer.from(JSON.stringify(redactJson(input.scan), null, 2), 'utf8') });

  targets.stateDirs.forEach((stateDir, index) => {
    const config = readJsonSafe(path.join(stateDir, STATE_CONFIG_FILE));
    if (config === null) return;
    entries.push({
      name: `state/${index + 1}/openclaw.json`,
      data: Buffer.from(JSON.stringify(redactJson(config), null, 2), 'utf8'),
    });
  });

  for (const log of collectLogs(targets.logsRoot)) {
    entries.push({ name: `logs/${log.name}`, data: log.data });
  }

  try {
    const outDir = input.outputDir;
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(outDir, diagnosticsFileName(stamp));
    fs.writeFileSync(target, buildZip(entries, input.now));
    return target;
  } catch {
    return null;
  }
}
