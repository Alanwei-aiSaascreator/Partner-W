import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  RETRY_GUARD_PLUGIN_ID,
  ensureRetryGuardPolicy,
  retryGuardPolicyDir,
} from '../src/main/runtime/deterministic-retry-guard.js';

/**
 * 确定性重复失败守卫（2026-10-13 集中整改 E 包 · BUG-060(c) + BUG-032 稳定身份子项）。
 *
 * ⚠️ 测的就是**会真跑的那份插件代码**：`ensureRetryGuardPolicy` 写出的 `index.mjs`
 *    被原样 `import()` 回来，注册进假 api，再按内核 2026.9.3 的钩子信封驱动
 *    （before/after_tool_call 的字段形状实读 `hook-runner-global-DZetem8r.d.ts`）。
 *    逻辑漂了这里必红——不复制一份判定来对拍。
 *
 * 驱动模型（与内核语义对齐）：
 *   before_tool_call ⇒ 返回 {block,blockReason} 即**执行器不得被调用**（计数不加）；
 *   after_tool_call  ⇒ 仅在真实执行后由宿主回调（此处显式模拟），失败用 error 字符串。
 */

interface ToolContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolKind?: string;
  toolInputKind?: string;
}

interface BeforeEvent {
  toolName: string;
  params: Record<string, unknown>;
}

interface AfterEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  error?: string;
  result?: unknown;
}

type Decision = { block?: boolean; blockReason?: string } | undefined;

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function loadGuard(): Promise<{
  before: (event: BeforeEvent, ctx: ToolContext) => Decision;
  after: (event: AfterEvent, ctx: ToolContext) => unknown;
  pluginDir: string;
  registered: string[];
}> {
  const stateDir = tempDir('retry-guard-policy-');
  const pluginDir = ensureRetryGuardPolicy(stateDir);
  const module = (await import(pathToFileURL(path.join(pluginDir, 'index.mjs')).href)) as {
    default: { id: string; register: (api: { on: (name: string, handler: unknown) => void }) => void };
  };
  let before: ((event: BeforeEvent, ctx: ToolContext) => Decision) | null = null;
  let after: ((event: AfterEvent, ctx: ToolContext) => unknown) | null = null;
  const registered: string[] = [];
  module.default.register({
    on: (name, candidate) => {
      registered.push(name);
      if (name === 'before_tool_call') before = candidate as (event: BeforeEvent, ctx: ToolContext) => Decision;
      if (name === 'after_tool_call') after = candidate as (event: AfterEvent, ctx: ToolContext) => unknown;
    },
  });
  expect(before, 'must register before_tool_call').not.toBeNull();
  expect(after, 'must register after_tool_call').not.toBeNull();
  return { before: before!, after: after!, pluginDir, registered };
}

/** 会话驱动器：before 先判；只有放行才"真实执行"并回调 after（与内核语义一致）。 */
class Session {
  executions = 0;

  constructor(
    private readonly before: (event: BeforeEvent, ctx: ToolContext) => Decision,
    private readonly after: (event: AfterEvent, ctx: ToolContext) => unknown,
    private ctx: ToolContext,
  ) {}

  setRun(runId: string): void {
    this.ctx = { ...this.ctx, runId };
  }

  setToolIdentity(toolKind: string | undefined): void {
    this.ctx = { ...this.ctx, toolKind };
  }

  call(
    toolName: string,
    params: Record<string, unknown>,
    outcome: { error: string } | { result: unknown } | { ok: true },
  ): { blocked: boolean; reason?: string } {
    const decision = this.before({ toolName, params }, this.ctx);
    if (decision?.block) return { blocked: true, reason: decision.blockReason };
    this.executions += 1;
    const toolCallId = `call-${this.executions}`;
    if ('error' in outcome)
      this.after({ toolName, params, runId: this.ctx.runId, toolCallId, error: outcome.error }, this.ctx);
    if ('result' in outcome)
      this.after({ toolName, params, runId: this.ctx.runId, toolCallId, result: outcome.result }, this.ctx);
    return { blocked: false };
  }
}

const READ_MISSING_PATH =
  'Missing required parameter: path (received: action, name). Supply correct parameters before retrying.';
const NAME_INVALID = 'Skill name must contain at least one letter or number.';
const PROPOSAL_NOT_FOUND = 'Skill proposal not found: skill-20261014-abcdef0123';

describe('deterministic-retry-guard plugin', () => {
  let guard: Awaited<ReturnType<typeof loadGuard>>;

  beforeEach(async () => {
    guard = await loadGuard();
  });

  afterEach(() => {
    tempDirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
  });

  function newSession(runId = 'run-1'): Session {
    return new Session(guard.before, guard.after, { agentId: 'main', sessionKey: 'agent:main:web', runId });
  }

  it('插件三件套齐全：manifest 带 activation.onStartup，package.json 指入口；注册 before+after', () => {
    const dir = guard.pluginDir;
    const manifest = JSON.parse(readFileSync(path.join(dir, 'openclaw.plugin.json'), 'utf-8')) as {
      id: string;
      activation?: { onStartup?: boolean };
      configSchema?: unknown;
    };
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf-8')) as {
      type?: string;
      openclaw?: { extensions?: string[] };
    };
    expect(manifest.id).toBe(RETRY_GUARD_PLUGIN_ID);
    expect(manifest.activation?.onStartup).toBe(true);
    expect(manifest.configSchema).toBeTruthy();
    expect(pkg.type).toBe('module');
    expect(pkg.openclaw?.extensions).toEqual(['./index.mjs']);
    expect(guard.registered).toEqual(['before_tool_call', 'after_tool_call']);
  });

  it('内容没变不重写；被改坏会自愈回正确内容', () => {
    const stateDir = tempDir('retry-guard-heal-');
    const dir = retryGuardPolicyDir(stateDir);
    ensureRetryGuardPolicy(stateDir);
    const entryPath = path.join(dir, 'index.mjs');
    const good = readFileSync(entryPath, 'utf-8');
    writeFileSync(entryPath, `${good}\n// tampered\n`, 'utf-8');
    ensureRetryGuardPolicy(stateDir);
    expect(readFileSync(entryPath, 'utf-8')).toBe(good);
  });

  it('⭐ 同参确定失败：第 1 次真实执行，第 2/3 次执行前拦下且不增加执行计数', () => {
    const session = newSession();
    const params = { action: 'read', name: '网页交付' };
    expect(session.call('read', params, { error: READ_MISSING_PATH })).toEqual({ blocked: false });
    expect(session.executions).toBe(1);

    const second = session.call('read', params, { error: READ_MISSING_PATH });
    expect(second.blocked).toBe(true);
    expect(session.executions).toBe(1);

    const third = session.call('read', params, { error: READ_MISSING_PATH });
    expect(third.blocked).toBe(true);
    expect(session.executions).toBe(1);

    // 拦截文案是"可行动的具名结果"：类别 + 原始错误 + 下一步建议 + 本守卫标记
    expect(second.reason).toContain('parameter-validation');
    expect(second.reason).toContain('Missing required parameter: path');
    expect(second.reason).toContain('read 需要 path');
    expect(second.reason).toContain('[荣盈重试保护]');
  });

  it('变参放行：改了任意参数就是另一次调用', () => {
    const session = newSession();
    const first = { action: 'read', name: '甲' };
    session.call('read', first, { error: READ_MISSING_PATH });
    expect(session.call('read', { action: 'read', name: '乙' }, { error: READ_MISSING_PATH }).blocked).toBe(false);
    expect(session.executions).toBe(2);
  });

  it('新 run 放行：作用域含 runId，换 run 一切重新开始', () => {
    const session = newSession('run-a');
    const params = { action: 'read', name: '甲' };
    session.call('read', params, { error: READ_MISSING_PATH });
    session.setRun('run-b');
    expect(session.call('read', params, { error: READ_MISSING_PATH }).blocked).toBe(false);
    expect(session.executions).toBe(2);
  });

  it('⭐ 先拒后授权：权限拒绝/审批拒绝不在白名单 —— 授权后同参可真实执行', () => {
    const session = newSession();
    const params = { command: 'npm run build' };
    session.call('exec', params, { error: 'Command denied: user denied the approval request.' });
    expect(session.call('exec', params, { error: 'Command denied: user denied the approval request.' }).blocked).toBe(
      false,
    );
    expect(session.executions).toBe(2);
  });

  it('审批 pending 与网络临时失败都不误杀', () => {
    const session = newSession();
    const execParams = { command: 'ping example.com' };
    session.call('exec', execParams, {
      result: { isError: false, details: { status: 'approval-pending', reason: 'needs approval' } },
    });
    expect(session.call('exec', execParams, { error: 'connect ECONNREFUSED 127.0.0.1:443' }).blocked).toBe(false);
    expect(session.call('exec', execParams, { error: 'connect ECONNREFUSED 127.0.0.1:443' }).blocked).toBe(false);
    expect(session.executions).toBe(3);
  });

  it('参数规范化：对象键序无关判同参；数组顺序/字符串/类型区分判变参', () => {
    const session = newSession();
    session.call('t', { a: 1, b: [1, 2] }, { error: READ_MISSING_PATH });
    // 键序不同 = 同一调用 ⇒ 拦
    expect(session.call('t', { b: [1, 2], a: 1 }, { error: READ_MISSING_PATH }).blocked).toBe(true);
    // 数组顺序不同 = 不同调用 ⇒ 放行
    expect(session.call('t', { a: 1, b: [2, 1] }, { error: READ_MISSING_PATH }).blocked).toBe(false);
    // 类型不同（"1" vs 1）⇒ 放行
    expect(session.call('t', { a: '1', b: [1, 2] }, { error: READ_MISSING_PATH }).blocked).toBe(false);
    expect(session.executions).toBe(3);
  });

  it('并行正常工具与其他会话不受影响', () => {
    const session = newSession();
    const params = { action: 'read', name: '甲' };
    session.call('read', params, { error: READ_MISSING_PATH });
    // 另一个工具同参 ⇒ 不拦
    expect(session.call('write', params, { ok: true }).blocked).toBe(false);
    // 另一个会话（不同 sessionKey）⇒ 不拦
    const other = new Session(guard.before, guard.after, {
      agentId: 'main',
      sessionKey: 'agent:main:other',
      runId: 'run-1',
    });
    expect(other.call('read', params, { error: READ_MISSING_PATH }).blocked).toBe(false);
    expect(other.executions).toBe(1);
  });

  it('⭐ 稳定身份：同一 proposal_id 失败后，纯换名重投被拦；另一合法候选不受影响', () => {
    const session = newSession();
    const failing = { action: 'revise', proposal_id: 'prop-1', name: '甲方案', proposal_content: 'x' };
    expect(session.call('skill_workshop', failing, { error: PROPOSAL_NOT_FOUND })).toEqual({ blocked: false });

    // 纯换名（proposal_id 不变）⇒ 拦，且文案点名 proposal_id
    const renamed = { action: 'revise', proposal_id: 'prop-1', name: '乙方案', proposal_content: 'y' };
    const blocked = session.call('skill_workshop', renamed, { error: PROPOSAL_NOT_FOUND });
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toContain('prop-1');
    expect(session.executions).toBe(1);

    // 另一合法候选 ⇒ 放行
    expect(
      session.call(
        'skill_workshop',
        { action: 'revise', proposal_id: 'prop-2', name: '丙方案' },
        { error: PROPOSAL_NOT_FOUND },
      ).blocked,
    ).toBe(false);
    expect(session.executions).toBe(2);

    // 换 run 后同一 proposal_id 重新尝试 ⇒ 放行
    session.setRun('run-2');
    expect(session.call('skill_workshop', renamed, { error: PROPOSAL_NOT_FOUND }).blocked).toBe(false);
  });

  it('无稳定身份：create 纯符号名同参重投拦，改名重投放行（不声称识别同一候选）', () => {
    const session = newSession();
    const bad = { action: 'create', name: '---', proposal_content: 'x' };
    session.call('skill_workshop', bad, { error: NAME_INVALID });
    expect(session.call('skill_workshop', bad, { error: NAME_INVALID }).blocked).toBe(true);
    // 改名 ⇒ 不同参数且无 proposal_id 稳定身份 ⇒ 不拦（该场景由索引/合同面负责）
    expect(session.call('skill_workshop', { ...bad, name: '推广方案' }, { error: NAME_INVALID }).blocked).toBe(false);
  });

  it('工具身份（toolKind）变化即失效：宿主给出的工具面变了，旧记录不再命中', () => {
    const session = newSession();
    const params = { action: 'read', name: '甲' };
    session.call('read', params, { error: READ_MISSING_PATH });
    expect(session.call('read', params, { error: READ_MISSING_PATH }).blocked).toBe(true);
    session.setToolIdentity('other-kind');
    expect(session.call('read', params, { error: READ_MISSING_PATH }).blocked).toBe(false);
  });

  it('守卫自身的拦截结果不会再被当失败记录（标记过滤，无自反馈）', () => {
    const session = newSession();
    const params = { action: 'read', name: '甲' };
    session.call('read', params, { error: READ_MISSING_PATH });
    const blocked = session.call('read', params, { error: READ_MISSING_PATH });
    expect(blocked.blocked).toBe(true);
    // 宿主把 blockReason 作为该次调用的 error 回调（某些路径会这样）——不得再记录/抛
    guard.after(
      { toolName: 'read', params, runId: 'run-1', toolCallId: 'call-x', error: blocked.reason },
      { agentId: 'main', sessionKey: 'agent:main:web', runId: 'run-1' },
    );
    expect(session.call('read', params, { error: READ_MISSING_PATH }).blocked).toBe(true);
  });

  it('容量有界：记录数封顶 256，最早的记录被淘汰（随后同参可再次真实执行）', async () => {
    const local = await loadGuard();
    const session = new Session(local.before, local.after, { agentId: 'main', sessionKey: 's', runId: 'r' });
    // 第 1 条：将被淘汰
    session.call('t0', { i: 0 }, { error: READ_MISSING_PATH });
    for (let i = 1; i <= 260; i += 1) session.call(`t${i}`, { i }, { error: READ_MISSING_PATH });
    // 最早的已被淘汰 ⇒ 不拦（真实执行）
    expect(session.call('t0', { i: 0 }, { error: READ_MISSING_PATH }).blocked).toBe(false);
    // 最新的仍在 ⇒ 拦
    const before = session.executions;
    expect(session.call('t260', { i: 260 }, { error: READ_MISSING_PATH }).blocked).toBe(true);
    expect(session.executions).toBe(before);
  });

  it('坏事件 fail-open：不抛、不拦', () => {
    expect(guard.before(undefined as unknown as BeforeEvent, {} as ToolContext)).toBeUndefined();
    expect(guard.before({ toolName: 'read', params: null as unknown as Record<string, unknown> }, {})).toBeUndefined();
    expect(guard.after(undefined as unknown as AfterEvent, {} as ToolContext)).toBeUndefined();
    expect(guard.after({ toolName: 'read', params: {} }, {})).toBeUndefined();
  });
});
