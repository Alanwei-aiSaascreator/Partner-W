import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MANAGED_NPM_LINK_SEGMENTS,
  MANAGED_NPM_PROJECTS_SEGMENTS,
  PLUGIN_SKILLS_DIR_NAME,
  STATE_LINK_KINDS,
  classifyStateLink,
  isBrokenStateLink,
  type LinkProbeFacts,
} from '../src/main/runtime/state-links-selfcheck.js';

/**
 * 守卫「客户端」与「给同事那支只读诊断工具」**共用同一套链接判据**这件事。
 *
 * 为什么需要：链接分类（悬空/指到别处/真目录/没建过…）在两边各写了一份 ——
 * 客户端那份在 `src/main/runtime/state-links-selfcheck.ts`（启动自检要修链），
 * 工具那份在 `scripts/lib/udisk-diagnose.mjs`（给同事跑、回传 txt）。
 * `scripts/` 不在 tsconfig 的 include 里（main 进程不能 import 构建脚本），
 * ⇒ 两边没有编译期约束，而漂移的症状是**指着错的地方说"这里没问题"**。
 *
 * ⚠️ 这里**真的去 import 那支工具**做**行为对拍**（不只是读文本比字面量）：
 *    同一批夹具喂给两边，逐条比 `kind`。文本比对只能发现"词表变了"，
 *    对拍能发现"分支顺序/条件变了"（比如把 needed 判在 lstat 之前）。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');
const TOOL_LIB = 'scripts/lib/udisk-diagnose.mjs';
const TOOL_CLI = 'scripts/udisk-diagnose.mjs';

interface ToolLinkInput extends LinkProbeFacts {
  expectedRoot: string;
  needed: boolean | null | undefined;
}
interface ToolModule {
  classifyLink: (input: ToolLinkInput) => { kind: string };
  isBrokenLink: (kind: string) => boolean;
  bucketOf: (kind: string) => string;
}

let cached: ToolModule | undefined;
async function loadTool(): Promise<ToolModule> {
  if (!cached) {
    cached = (await import(pathToFileURL(path.join(REPO_ROOT, TOOL_LIB)).href)) as ToolModule;
  }
  return cached;
}

function readRepoFile(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
}

const expectedRoot = 'C:\\u\\runtime\\deployed\\KEY2';
const target = (suffix: string) => path.join(expectedRoot, suffix);

/** 夹具矩阵：覆盖每一种 kind + 两条**容易写错**的边界。 */
const CASES: Array<{ name: string; facts: LinkProbeFacts; needed: boolean | null | undefined }> = [
  {
    name: 'ok（活链、在当前运行时下）',
    facts: {
      lstat: { exists: true, symlink: true, dir: false },
      readlink: target('node_modules\\openclaw'),
      stat: { ok: true, dir: true },
    },
    needed: true,
  },
  {
    name: 'dangling（悬空）',
    facts: {
      lstat: { exists: true, symlink: true, dir: false },
      readlink: 'C:\\u\\runtime\\deployed\\KEY1\\node_modules\\openclaw',
      stat: { ok: false, code: 'ENOENT' },
    },
    needed: true,
  },
  {
    name: 'elsewhere（活着但指到别处）',
    facts: {
      lstat: { exists: true, symlink: true, dir: false },
      readlink: 'C:\\u\\runtime\\deployed\\KEY1\\node_modules\\openclaw',
      stat: { ok: true, dir: true },
    },
    needed: true,
  },
  {
    name: 'real-dir（真目录占了位置）',
    facts: { lstat: { exists: true, symlink: false, dir: true }, readlink: null, stat: { ok: true, dir: true } },
    needed: true,
  },
  {
    name: 'real-file（是个文件）',
    facts: { lstat: { exists: true, symlink: false, dir: false }, readlink: null, stat: { ok: true, dir: false } },
    needed: true,
  },
  {
    name: 'real-file（链接指向的不是目录）',
    facts: {
      lstat: { exists: true, symlink: true, dir: false },
      readlink: 'C:\\u\\some\\file.txt',
      stat: { ok: true, dir: false },
    },
    needed: true,
  },
  { name: 'not-created（该有、还没建）', facts: emptyFacts(), needed: true },
  { name: 'not-needed（没声明 openclaw 依赖）', facts: emptyFacts(), needed: false },
  { name: 'unknown（读不出 manifest）', facts: emptyFacts(), needed: null },
  {
    name: '⚠️ 边界：前缀陷阱（…KEY2x 不算在 …KEY2 里）',
    facts: {
      lstat: { exists: true, symlink: true, dir: false },
      readlink: 'C:\\u\\runtime\\deployed\\KEY2x\\node_modules\\openclaw',
      stat: { ok: true, dir: true },
    },
    needed: true,
  },
  {
    name: '⚠️ 边界：大小写不同（Windows 上算同一条）',
    facts: {
      lstat: { exists: true, symlink: true, dir: false },
      readlink: 'c:\\u\\runtime\\deployed\\key2\\node_modules\\openclaw',
      stat: { ok: true, dir: true },
    },
    needed: true,
  },
  {
    name: '⚠️ 边界：读不出目标串（readlink 失败）',
    facts: {
      lstat: { exists: true, symlink: true, dir: false },
      readlink: null,
      stat: { ok: false, code: 'ENOENT' },
    },
    needed: true,
  },
];

function emptyFacts(): LinkProbeFacts {
  return { lstat: { exists: false }, readlink: null, stat: { ok: false, code: 'ENOENT' } };
}

describe('与诊断工具的链接判据一致性（scripts/ 与客户端没有编译期约束，只能靠这里）', () => {
  it('⭐ 行为对拍：同一批夹具喂给两边，`kind` 逐条相同', async () => {
    const tool = await loadTool();
    expect(CASES.length, '夹具太少了 —— 矩阵本身要有意义').toBeGreaterThanOrEqual(10);

    const diffs: string[] = [];
    for (const c of CASES) {
      const mine = classifyStateLink(c.facts, { expectedRoot, needed: c.needed }).kind;
      const theirs = tool.classifyLink({ ...c.facts, expectedRoot, needed: c.needed }).kind;
      if (mine !== theirs) diffs.push(`${c.name}: 客户端=${mine} 工具=${theirs}`);
    }
    expect(diffs, '两边判据漂了（客户端改了就同步工具，反之亦然）').toEqual([]);
  });

  it('⭐ 坏链集合一致：哪几种算"坏"，两边一定是同一批', async () => {
    const tool = await loadTool();
    const mine = STATE_LINK_KINDS.filter((k) => isBrokenStateLink(k));
    const theirs = STATE_LINK_KINDS.filter((k) => tool.isBrokenLink(k));
    expect(mine.sort()).toEqual(theirs.sort());
    // 值本身也钉一下（防止两边一起被改错）
    expect([...mine].sort()).toEqual(['dangling', 'elsewhere', 'real-dir', 'real-file']);
    // 分桶（工具报告里分四桶数数）也要对得上
    expect(tool.bucketOf('not-created')).toBe('absent');
    expect(tool.bucketOf('unknown')).toBe('unjudged');
    expect(tool.bucketOf('not-needed')).toBe('ok');
  });

  it('⭐ 工具的 `kind` 字面量不许有我们不认识的新值（反向守卫）', () => {
    const source = readRepoFile(TOOL_LIB);
    const seen = new Set([...source.matchAll(/kind:\s*'([a-z-]+)'/g)].map((m) => m[1]));
    expect(seen.size, '一个 kind 都没抠出来 ⇒ 抠法过期了（工具改了写法？）').toBeGreaterThanOrEqual(8);
    const unknown = [...seen].filter((k) => !(STATE_LINK_KINDS as readonly string[]).includes(k));
    expect(unknown, '工具新增了 kind，客户端这份词表得跟上').toEqual([]);
    // 我们的词表也全都在工具里出现过（防止我们凭空造一种）
    const missing = STATE_LINK_KINDS.filter((k) => !seen.has(k));
    expect(missing).toEqual([]);
  });

  it('链接所在的位置常量两边一致（改名只改一边 ⇒ 自检会去探一个空目录）', () => {
    const cli = readRepoFile(TOOL_CLI);
    expect(cli).toContain(PLUGIN_SKILLS_DIR_NAME);
    expect(MANAGED_NPM_PROJECTS_SEGMENTS.every((s) => cli.includes(s))).toBe(true);
    expect(MANAGED_NPM_LINK_SEGMENTS.every((s) => cli.includes(s))).toBe(true);
    // 值本身（防止两边一起漂）
    expect(PLUGIN_SKILLS_DIR_NAME).toBe('plugin-skills');
    expect([...MANAGED_NPM_PROJECTS_SEGMENTS]).toEqual(['npm', 'projects']);
    expect([...MANAGED_NPM_LINK_SEGMENTS]).toEqual(['node_modules', 'openclaw']);
  });
});
