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
 * 本轮落地的是 deny 通道的加法（`@clawwork/core` 的能力注册表是唯一真源）：
 *   · 图片/视频生成（image_generate / video_generate）本轮不接入 ⇒ 进 `tools.deny`；
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

it('mergeToolsDefaults：图片/视频生成进 deny，且原有四个默认名一个不少', () => {
  const deny = mergeToolsDefaults(null).deny as string[];
  expect(deny).toEqual(expect.arrayContaining(['memory_search', 'memory_get', 'canvas', 'web_search', 'web_fetch']));
  expect(deny).toEqual(expect.arrayContaining([...plannerDeniedToolIds()]));
  expect(deny).toContain('image_generate');
  expect(deny).toContain('video_generate');
  // 幂等：再并一次不多出重复项
  const again = mergeToolsDefaults({ tools: mergeToolsDefaults(null) }).deny as string[];
  expect(new Set(again).size).toBe(again.length);
});

it('自愈判据认识新名字：只有旧 deny 集合的配置判「未就绪」（迫使走合并回写）', () => {
  const legacy = {
    tools: { deny: ['memory_search', 'memory_get', 'canvas', 'web_search', 'web_fetch'] },
  };
  expect(hasMemoryToolsDenied(legacy)).toBe(false);
  expect(hasMemoryToolsDenied({ tools: mergeToolsDefaults(null) })).toBe(true);
});

it('⭐ 存量用户（token/memory/deny 都早就对了）启动一次就自动补上新 deny', () => {
  const userDataDir = tempUserData();
  const stateDir = stateDirFor(userDataDir);
  fs.mkdirSync(stateDir, { recursive: true });
  // 模拟"这一版之前写下的文件"：四个旧默认名都在，但没有能力注册表带来的新名字。
  fs.writeFileSync(
    stateConfigPath(stateDir),
    JSON.stringify({
      gateway: { auth: { mode: 'token', token: 'stale-but-consistent' } },
      memory: { search: { provider: 'none' } },
      tools: {
        deny: ['memory_search', 'memory_get', 'canvas', 'web_search', 'web_fetch'],
        fs: { workspaceOnly: true },
        exec: { mode: 'ask' },
        elevated: { enabled: false },
      },
    }),
  );

  ensureStateConfig(userDataDir);

  const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
  expect(raw.tools.deny).toEqual(expect.arrayContaining(['image_generate', 'video_generate']));
  expect(raw.tools.deny).toEqual(expect.arrayContaining(['memory_search', 'web_search']));
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
