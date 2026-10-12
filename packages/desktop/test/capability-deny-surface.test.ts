import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { plannerDeniedToolIds } from '@clawwork/core';

vi.mock('electron', () => ({
  app: { getPath: () => os.tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (buf: Buffer) => buf.toString(),
  },
}));

import {
  DORMANT_TOOLS_DENIED,
  GOAL_TOOLS_DENIED,
  OPS_SURFACE_TOOLS_DENIED,
  PAIRED_NODE_TOOLS_DENIED,
  UNWIRED_TOOLS_DENIED,
  WORKSHOP_TOOLS_DENIED,
  defaultDeniedToolNames,
  ensureStateConfig,
  hasMemoryToolsDenied,
  mergeToolsDefaults,
  stateConfigPath,
  stateDirFor,
} from '../src/main/runtime/state-config';
import { ensureBundledWorkflowTools } from '../src/main/runtime/workflow-tools';

/**
 * BUG-043 · Planner 边界：`unavailable` 的能力**不得出现在模型可见的工具面**。
 *
 * 本文件覆盖两条线：
 * ① 能力注册表线（BUG-043）：图片/视频/音乐生成（image_generate / video_generate /
 *    music_generate）+ file_fetch 本轮不接入 ⇒ 进 `tools.deny`（真源在 `@clawwork/core`）；
 * ② deny v2 线（BUG-061，2026-10-08）：配对节点族 / 运营面族 / 无接线族 / 目标族 /
 *    休眠零依赖族 / skill_workshop 六个名单进同一并集（用户拍板 + 三路证据，
 *    逐族理由见 state-config.ts 各常量注释）。
 *
 * 共同契约：
 *   · 存量用户必须**自愈**（提前返回判据里必须带上新名字，否则他永远拿不到）；
 *   · `workflow-tools` 的"系统默认工具策略"判据必须认识新名字
 *     （不认识的后果：默认策略被当成"用户显式策略"，lobster 授权静默跳过）。
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function tempUserData(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-deny-'));
  roots.push(root);
  return root;
}

it('mergeToolsDefaults：默认 deny = 旧名单 + deny v2 六族 + 能力注册表，且在役正路一名不伤', () => {
  const deny = mergeToolsDefaults(null).deny as string[];
  expect(deny).toEqual(expect.arrayContaining(['memory_search', 'memory_get', 'canvas', 'web_fetch']));
  // 2026-10-12 联网搜索接入：web_search 从 deny 恢复（博查经 relay 接线，且内核补丁
  // 在 provider 未就绪时让工具根本不出现——fail-closed，不再有"重复搜索失败"）。
  expect(deny).not.toContain('web_search');
  expect(deny).toEqual(expect.arrayContaining([...plannerDeniedToolIds()]));
  expect(deny).toContain('image_generate');
  expect(deny).toContain('video_generate');
  expect(deny).toContain('music_generate');
  // deny v2（BUG-061）：六族代表逐名在名单里（typo / 漏并防线）
  expect(deny).toEqual(
    expect.arrayContaining(['automations', 'nodes', 'computer', 'skill_workshop', 'create_goal', 'sessions_list']),
  );
  // 误伤防线：产品正路 + 在役载体（lobster=随包工作流插件的授权工具名）
  // + 待决策项（sessions_spawn/send 须与合同文本同批）
  for (const keep of [
    'read',
    'write',
    'edit',
    'ls',
    'exec',
    'browser',
    'apply_patch',
    'process',
    'ask_user',
    'sessions_spawn',
    'sessions_send',
    'lobster',
  ]) {
    expect(deny).not.toContain(keep);
  }
  // 幂等：再并一次不多出重复项
  const again = mergeToolsDefaults({ tools: mergeToolsDefaults(null) }).deny as string[];
  expect(new Set(again).size).toBe(again.length);
});

it('deny v2：六个新家族名单逐名进入并集（常量全量为期望）', () => {
  const deny = mergeToolsDefaults(null).deny as string[];
  expect(deny).toEqual(
    expect.arrayContaining([
      ...PAIRED_NODE_TOOLS_DENIED,
      ...OPS_SURFACE_TOOLS_DENIED,
      ...UNWIRED_TOOLS_DENIED,
      ...GOAL_TOOLS_DENIED,
      ...DORMANT_TOOLS_DENIED,
      ...WORKSHOP_TOOLS_DENIED,
    ]),
  );
  // 首跑 config 的 deny 与聚合名单完全一致（不多不少）
  expect([...new Set(deny)].sort()).toEqual([...defaultDeniedToolNames()].sort());
});

it('自愈判据认识新名字：上一版（deny v2 之前）的完整 deny 集合也判「未就绪」', () => {
  // 上一版落盘的完整集合 = 旧七名 + 能力注册表三位（不含 deny v2 六族）
  const legacy = {
    tools: {
      deny: [
        'memory_search',
        'memory_get',
        'canvas',
        'web_search',
        'web_fetch',
        'view_image',
        'image_generate',
        'video_generate',
        'file_fetch',
      ],
    },
  };
  expect(hasMemoryToolsDenied(legacy)).toBe(false);
  expect(hasMemoryToolsDenied({ tools: mergeToolsDefaults(null) })).toBe(true);
});

it('退休名单驱动自愈：连"当前全量 deny + 退休名 web_search"也判「未就绪」并会在合并中被清掉', () => {
  const withRetired = { tools: { deny: [...defaultDeniedToolNames(), 'web_search'] } };
  // 判据必须否 —— 否则存量盘（名单全 + 历史 web_search）会被提前返回永远锁着。
  expect(hasMemoryToolsDenied(withRetired)).toBe(false);
  const cleaned = mergeToolsDefaults(withRetired).deny as string[];
  expect(cleaned).not.toContain('web_search');
  // 清完之后判据转真（不会每次启动都白写一遍）。
  expect(hasMemoryToolsDenied({ tools: { deny: cleaned } })).toBe(true);
});

it('⭐ 存量用户（token/memory/deny 都早就对了）启动一次就自动补上新 deny', () => {
  const userDataDir = tempUserData();
  const stateDir = stateDirFor(userDataDir);
  fs.mkdirSync(stateDir, { recursive: true });
  // 模拟"deny v2 之前写下的文件"：上一版全量 deny 都在，但没有六族新名字。
  fs.writeFileSync(
    stateConfigPath(stateDir),
    JSON.stringify({
      gateway: { auth: { mode: 'token', token: 'stale-but-consistent' } },
      memory: { search: { provider: 'none' } },
      tools: {
        deny: [
          'memory_search',
          'memory_get',
          'canvas',
          'web_search',
          'web_fetch',
          'view_image',
          'image_generate',
          'video_generate',
          'file_fetch',
        ],
        fs: { workspaceOnly: true },
        exec: { mode: 'ask' },
        elevated: { enabled: false },
      },
    }),
  );

  ensureStateConfig(userDataDir);

  const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
  expect(raw.tools.deny).toEqual(expect.arrayContaining(['image_generate', 'video_generate']));
  expect(raw.tools.deny).toEqual(expect.arrayContaining(['memory_search', 'web_fetch']));
  // ⭐ 退休名单清除（2026-10-12）：老盘 deny 里的 web_search 必须被清掉——
  //    只并集不清除的话，搜索只对新用户恢复、对存量用户永远被挡（本测试就是那根钉子）。
  expect(raw.tools.deny).not.toContain('web_search');
  // deny v2：六族名字在同一次启动内补齐（存量盘自愈）
  expect(raw.tools.deny).toEqual(
    expect.arrayContaining(['automations', 'nodes', 'computer', 'skill_workshop', 'sessions_list']),
  );
});

it('workflow-tools：带新 deny 的默认策略仍被认作「系统默认」（lobster 授权不被静默跳过）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'capability-deny-wf-'));
  roots.push(root);
  const stateDir = path.join(root, 'state');
  const plugin = path.join(root, 'node_modules/openclaw/dist/extensions/lobster');
  fs.mkdirSync(stateDir);
  fs.mkdirSync(path.join(plugin, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'manifest.json'),
    JSON.stringify({ runtimes: [{ patches: ['official-lobster-2026.9.3', 'rongying-lobster-windows-state-v1'] }] }),
  );
  fs.writeFileSync(
    path.join(plugin, 'package.json'),
    JSON.stringify({ name: '@openclaw/lobster', version: '2026.9.3' }),
  );
  fs.writeFileSync(
    path.join(plugin, 'openclaw.plugin.json'),
    JSON.stringify({ id: 'lobster', contracts: { tools: ['lobster'] } }),
  );
  fs.writeFileSync(path.join(plugin, 'dist/index.js'), 'compiled plugin');
  const configPath = path.join(stateDir, 'openclaw.json');
  fs.writeFileSync(configPath, JSON.stringify({ tools: mergeToolsDefaults(null) }));

  expect(ensureBundledWorkflowTools(root, stateDir)).toBe(true);
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  expect(raw.agents.entries.main.tools).toEqual({ alsoAllow: ['lobster'] });
});
