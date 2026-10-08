import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  INBOX_READONLY_BLOCK_REASON,
  INBOX_READONLY_PLUGIN_ID,
  ensureInboxReadonlyPolicy,
  inboxReadonlyPolicyDir,
} from '../src/main/guard/inbox-readonly.js';

/**
 * 导入收件箱只读守卫（BUG-030 / P3-1）—— **测的是会真跑的那份插件代码**。
 *
 * ⚠️ 这里不复制一份判定逻辑来测：`ensureInboxReadonlyPolicy` 写出的 `index.mjs`
 *    被原样 `import()` 回来，注册进一个假 api，再用工具调用的**真实信封形状**
 *    驱动它（write `{path,content}` / edit `{path,edits}` / apply_patch `{input}`，
 *    形状取自随包运行时 2026.9.3 的工具 schema）。逻辑漂了，这里必红。
 *
 * ⚠️ "拒绝且文件未变"用 `runThroughGuard` 表达：守卫说 block ⇒ 执行器**不得被调用**；
 *    唯一的真文件用例会读回内容确认还是原样（拒绝不是嘴上说说）。
 */

interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  derivedPaths?: string[];
}

type PolicyDecision = { block?: boolean; blockReason?: string } | undefined;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadGuardHandler(): Promise<(event: BeforeToolCallEvent) => PolicyDecision> {
  const stateDir = tempDir('inbox-guard-policy-');
  const pluginDir = ensureInboxReadonlyPolicy(stateDir);
  const module = (await import(pathToFileURL(path.join(pluginDir, 'index.mjs')).href)) as {
    default: { id: string; register: (api: { on: (name: string, handler: unknown) => void }) => void };
  };
  let handler: ((event: BeforeToolCallEvent) => PolicyDecision) | null = null;
  module.default.register({
    on: (name, candidate) => {
      if (name === 'before_tool_call') handler = candidate as (event: BeforeToolCallEvent) => PolicyDecision;
    },
  });
  expect(handler, 'policy must register a before_tool_call handler').not.toBeNull();
  return handler!;
}

/** 按运行时的契约驱动一次"工具调用"：block ⇒ 不执行；否则执行。 */
function runThroughGuard(
  handler: (event: BeforeToolCallEvent) => PolicyDecision,
  event: BeforeToolCallEvent,
  execute: () => void,
): { blocked: boolean; reason?: string } {
  const decision = handler(event);
  if (decision?.block) return { blocked: true, reason: decision.blockReason };
  execute();
  return { blocked: false };
}

describe('inbox-readonly policy plugin (BUG-030 P3-1)', () => {
  let handler: (event: BeforeToolCallEvent) => PolicyDecision;
  let stateDir: string;

  beforeEach(async () => {
    handler = await loadGuardHandler();
    stateDir = tempDir('inbox-guard-ws-');
  });

  afterEach(() => {
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  function writeFile(relative: string): string {
    const absolute = path.join(stateDir, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    return absolute;
  }

  it('插件三件套齐全：manifest 带 activation.onStartup，package.json 指入口', () => {
    const dir = inboxReadonlyPolicyDir(stateDir);
    ensureInboxReadonlyPolicy(stateDir);
    const manifest = JSON.parse(readFileSync(path.join(dir, 'openclaw.plugin.json'), 'utf-8')) as {
      id: string;
      activation?: { onStartup?: boolean };
      configSchema?: unknown;
    };
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
      type?: string;
      openclaw?: { extensions?: string[] };
    };
    // 少了任何一条，网关会**静默不加载**（实测：不给 activation.onStartup / 不给目录只给裸文件，
    // 都在启动插件名单里看不到它，且没有一条日志）。
    expect(manifest.id).toBe(INBOX_READONLY_PLUGIN_ID);
    expect(manifest.activation?.onStartup).toBe(true);
    expect(manifest.configSchema).toBeTruthy();
    expect(pkg.type).toBe('module');
    expect(pkg.openclaw?.extensions).toEqual(['./index.mjs']);
  });

  it('内容没变不重写；被改坏会自愈回正确内容', () => {
    const dir = inboxReadonlyPolicyDir(stateDir);
    ensureInboxReadonlyPolicy(stateDir);
    const entryPath = path.join(dir, 'index.mjs');
    const good = readFileSync(entryPath, 'utf-8');
    writeFileSync(entryPath, '// tampered\n', 'utf-8');
    ensureInboxReadonlyPolicy(stateDir);
    expect(readFileSync(entryPath, 'utf-8')).toBe(good);
  });

  it('⭐ write 指向 inbox 的**真文件**：拒绝，且文件一个字节都没变', () => {
    const inboxFile = writeFile(path.join('task-1', 'inbox', 'ref.docx'));
    writeFileSync(inboxFile, 'ORIGINAL', 'utf-8');

    const result = runThroughGuard(handler, { toolName: 'write', params: { path: inboxFile, content: 'HACKED' } }, () =>
      writeFileSync(inboxFile, 'HACKED', 'utf-8'),
    );

    expect(result.blocked).toBe(true);
    expect(result.reason).toBe(INBOX_READONLY_BLOCK_REASON);
    expect(readFileSync(inboxFile, 'utf-8')).toBe('ORIGINAL');
  });

  it('write 相对路径 `inbox/x` 与 `sub/../inbox/x` 都拒绝（不需要 cwd 也能判）', () => {
    for (const target of [
      'inbox/ref.docx',
      'inbox\\ref.docx',
      path.join('task-1', 'inbox', 'ref.docx'),
      'task-1/sub/../inbox/ref.docx',
    ]) {
      const result = runThroughGuard(handler, { toolName: 'write', params: { path: target, content: 'x' } }, () => {
        throw new Error(`must not execute: ${target}`);
      });
      expect(result.blocked, target).toBe(true);
    }
  });

  it('edit 信封（{path, edits[]}）按同一个目标判定', () => {
    const inboxFile = path.join(stateDir, 'task-1', 'inbox', 'ref.md');
    const result = runThroughGuard(
      handler,
      {
        toolName: 'edit',
        params: { path: inboxFile, edits: [{ oldText: 'a', newText: 'b' }] },
      },
      () => {
        throw new Error('must not execute');
      },
    );
    expect(result.blocked).toBe(true);
  });

  it('apply_patch 信封：Add / Update / Delete / Move 的 `***` 目标在 inbox 一律拒绝', () => {
    const inboxTarget = path.join(stateDir, 'task-1', 'inbox', 'ref.md');
    const markers = [
      `*** Begin Patch\n*** Update File: ${inboxTarget}\n@@\n-a\n+b\n*** End Patch`,
      `*** Begin Patch\n*** Add File: ${inboxTarget}\n+b\n*** End Patch`,
      `*** Begin Patch\n*** Delete File: ${inboxTarget}\n*** End Patch`,
      `*** Begin Patch\n*** Update File: ${path.join(stateDir, 'task-1', 'out.md')}\n*** Move to: ${inboxTarget}\n@@\n-a\n+b\n*** End Patch`,
    ];
    for (const input of markers) {
      const result = runThroughGuard(handler, { toolName: 'apply_patch', params: { input } }, () => {
        throw new Error(`must not execute: ${input.split('\n')[1]}`);
      });
      expect(result.blocked, input).toBe(true);
    }
  });

  it('apply_patch 无法解析时用 derivedPaths 兜底（host 提示也算数）', () => {
    const result = runThroughGuard(
      handler,
      {
        toolName: 'apply_patch',
        params: { input: '*** Begin Patch\n*** End Patch' },
        derivedPaths: [path.join(stateDir, 'task-2', 'inbox', 'x.txt')],
      },
      () => {
        throw new Error('must not execute');
      },
    );
    expect(result.blocked).toBe(true);
  });

  it('win32 大小写不敏感：TASK-1\\INBOX\\x 与 task-1\\Inbox\\x 同样拒绝', () => {
    const caseInsensitive = process.platform === 'win32';
    const variants = [
      path.join(stateDir, 'TASK-1', 'INBOX', 'x.docx'),
      path.join(stateDir, 'task-1', 'Inbox', 'x.docx'),
    ];
    for (const target of variants) {
      const result = runThroughGuard(handler, { toolName: 'write', params: { path: target, content: 'x' } }, () => {});
      expect(result.blocked, target).toBe(caseInsensitive);
    }
  });

  it('`inbox` 段必须精确匹配：inbox-archive / inbox.md 不拦', () => {
    for (const target of [
      path.join(stateDir, 'task-1', 'inbox-archive', 'x.docx'),
      path.join(stateDir, 'task-1', 'inbox.md'),
      'inboxx/ref.docx',
    ]) {
      const result = runThroughGuard(handler, { toolName: 'write', params: { path: target, content: 'x' } }, () => {});
      expect(result.blocked, target).toBe(false);
    }
  });

  it('canonical 折叠：`inbox/../report.md` 落到任务根 ⇒ 允许', () => {
    const result = runThroughGuard(
      handler,
      { toolName: 'write', params: { path: path.join(stateDir, 'task-1', 'inbox', '..', 'report.md'), content: 'x' } },
      () => {},
    );
    expect(result.blocked).toBe(false);
  });

  it('symlink 别名指向 inbox ⇒ 拒绝（canonical 判定，不是字面匹配）', () => {
    const inboxDir = path.join(stateDir, 'task-1', 'inbox');
    mkdirSync(inboxDir, { recursive: true });
    const linkPath = path.join(stateDir, 'task-1', 'ref-link');
    try {
      // junction 在 Windows 上无需管理员权限；POSIX 用普通 symlink。
      symlinkSync(inboxDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      return; // 环境不允许建链接时跳过（不假装通过：这里没有断言可失败）
    }
    const result = runThroughGuard(
      handler,
      { toolName: 'write', params: { path: path.join(linkPath, 'x.docx'), content: 'x' } },
      () => {
        throw new Error('must not execute');
      },
    );
    expect(result.blocked).toBe(true);
  });

  it('正常输出路径不被误伤：任务根 / out/ 子目录照常可写', () => {
    const targets = [
      path.join(stateDir, 'task-1', 'deck.md'),
      path.join(stateDir, 'task-1', 'out', 'deck.pptx'),
      path.join(stateDir, 'rongying-agents', 'rongying-content', 'notes.md'),
    ];
    for (const target of targets) {
      let executed = false;
      const result = runThroughGuard(handler, { toolName: 'write', params: { path: target, content: 'x' } }, () => {
        executed = true;
      });
      expect(result.blocked, target).toBe(false);
      expect(executed, target).toBe(true);
    }
  });

  it('只拦写：read / ls / exec 等工具一律放行', () => {
    const inboxFile = path.join(stateDir, 'task-1', 'inbox', 'ref.docx');
    for (const toolName of ['read', 'ls', 'exec', 'sessions_list']) {
      const result = runThroughGuard(
        handler,
        { toolName, params: { path: inboxFile, command: 'type inbox\\ref.docx' } },
        () => {},
      );
      expect(result.blocked, toolName).toBe(false);
    }
  });

  it('拒写文案是产品文案（zh、无路径、无英文样板）', () => {
    expect(INBOX_READONLY_BLOCK_REASON).toContain('只读参考材料');
    expect(INBOX_READONLY_BLOCK_REASON).not.toContain(stateDir);
    expect(INBOX_READONLY_BLOCK_REASON).not.toMatch(/ENOENT|Error|write_|tool_call|inbox\//);
  });
});
