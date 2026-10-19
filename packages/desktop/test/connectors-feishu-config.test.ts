import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyFeishuCredentials,
  buildFeishuBindingPatch,
  buildFeishuChannelPatch,
  hardenFeishuGroupPolicy,
  readFeishuRouteBindingIds,
  readFeishuRouteBindingsAt,
  setFeishuChannelEnabled,
  setFeishuRouteBinding,
  verifyFeishuBindingApplied,
  verifyFeishuChannelApplied,
} from '../src/main/connectors/feishu-config.js';

/**
 * 飞书写配置（2026-10-18）：形状、绑定增删、回读校验、乐观锁重试。
 * 全部用**假网关**（`{hash, config}` 快照 + 深合并 patch），不启动任何进程。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 与网关 `config.patch` 同语义的最小深合并（对象递归、数组整段替换）。 */
function deepMerge(target: Json, patch: Json): Json {
  const next: Json = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (isRecord(value)) {
      const base = isRecord(next[key]) ? (next[key] as Json) : {};
      next[key] = deepMerge(base, value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function createFakeGateway(initial: Json, options?: { failPatchOnce?: string; ignorePatch?: boolean }) {
  let config = structuredClone(initial);
  let hash = 'hash-1';
  let version = 1;
  const patches: Array<{ raw: string; replacePaths?: string[] }> = [];
  let pendingFailure = options?.failPatchOnce ?? null;

  const gateway = {
    async getConfig(): Promise<unknown> {
      return { hash, config: structuredClone(config) };
    },
    async patchConfig(params: { baseHash: string; raw: string; replacePaths?: string[] }): Promise<unknown> {
      if (pendingFailure) {
        const message = pendingFailure;
        pendingFailure = null;
        throw new Error(message);
      }
      if (params.baseHash !== hash) throw new Error('config changed since last load');
      patches.push({ raw: params.raw, ...(params.replacePaths ? { replacePaths: params.replacePaths } : {}) });
      if (!options?.ignorePatch) {
        config = deepMerge(config, JSON.parse(params.raw) as Json);
        version += 1;
        hash = `hash-${version}`;
      }
      return { ok: true };
    },
  };
  return {
    gateway,
    patches,
    get config(): Json {
      return structuredClone(config);
    },
  };
}

describe('buildFeishuChannelPatch（现场可工作的形状）', () => {
  it('⭐ 写入 channels.feishu + 启用插件条目（群聊默认 allowlist，不是 open）', () => {
    const patch = buildFeishuChannelPatch({ appId: 'cli_x', appSecret: 'sec', openId: 'ou_1' });
    expect(patch).toEqual({
      channels: {
        feishu: {
          enabled: true,
          dmPolicy: 'allowlist',
          appId: 'cli_x',
          appSecret: 'sec',
          allowFrom: ['ou_1'],
          groupPolicy: 'allowlist',
          requireMention: true,
        },
      },
      plugins: { entries: { feishu: { enabled: true } } },
    });
  });

  it('没有 open_id ⇒ 不写 dmPolicy/allowFrom（空名单会把机主私聊也拦掉）', () => {
    const patch = buildFeishuChannelPatch({ appId: 'cli_x', appSecret: 'sec', openId: null });
    const channels = patch['channels'] as { feishu: Record<string, unknown> };
    expect('allowFrom' in channels.feishu).toBe(false);
    expect('dmPolicy' in channels.feishu).toBe(false);
    expect(channels.feishu['groupPolicy']).toBe('allowlist');
  });
});

describe('readFeishuRouteBindingIds', () => {
  it('认字符串与数组两种 match.channel；忽略非 route 与非飞书', () => {
    const config = {
      bindings: [
        { type: 'route', agentId: 'main', match: { channel: 'feishu' } },
        { type: 'route', agentId: 'writer', match: { channel: ['feishu', 'telegram'] } },
        { type: 'route', agentId: 'other', match: { channel: 'telegram' } },
        { type: 'mention', agentId: 'ignored', match: { channel: 'feishu' } },
        { type: 'route', agentId: '', match: { channel: 'feishu' } },
        'nonsense',
      ],
    };
    expect(readFeishuRouteBindingIds(config)).toEqual(['main', 'writer']);
  });

  it('形状不对 ⇒ 空数组，不猜', () => {
    expect(readFeishuRouteBindingIds(null)).toEqual([]);
    expect(readFeishuRouteBindingIds({ bindings: {} })).toEqual([]);
  });
});

describe('buildFeishuBindingPatch', () => {
  it('⭐ 没有既有绑定 ⇒ 绑到指定助手（默认 main），数组整段替换', () => {
    const patch = buildFeishuBindingPatch({}, 'main');
    expect(patch).toEqual({
      patch: { bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }] },
      replacePaths: ['bindings'],
    });
  });

  it('保留其它绑定，只替换飞书这一条', () => {
    const config = {
      bindings: [
        { type: 'route', agentId: 'main', match: { channel: 'feishu' } },
        { type: 'route', agentId: 'x', match: { channel: 'telegram' } },
      ],
    };
    const patch = buildFeishuBindingPatch(config, 'writer');
    expect(patch?.patch).toEqual({
      bindings: [
        { type: 'route', agentId: 'x', match: { channel: 'telegram' } },
        { type: 'route', agentId: 'writer', match: { channel: 'feishu' } },
      ],
    });
  });

  it('已经是同一个助手 ⇒ 不需要写（幂等）', () => {
    const config = { bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }] };
    expect(buildFeishuBindingPatch(config, 'main')).toBeNull();
  });

  it('agentId=null ⇒ 删除全部飞书绑定，其它绑定保留', () => {
    const config = {
      bindings: [
        { type: 'route', agentId: 'main', match: { channel: 'feishu' } },
        { type: 'route', agentId: 'x', match: { channel: 'telegram' } },
      ],
    };
    expect(buildFeishuBindingPatch(config, null)?.patch).toEqual({
      bindings: [{ type: 'route', agentId: 'x', match: { channel: 'telegram' } }],
    });
    expect(buildFeishuBindingPatch({ bindings: [] }, null)).toBeNull();
  });
});

describe('applyFeishuCredentials', () => {
  it('⭐ 扫码成功：写凭证；原本没有绑定 ⇒ 自动绑 main（现场 AgentSelectionRequiredError 的修法）', async () => {
    const fake = createFakeGateway({ gateway: { auth: { mode: 'token', token: 't' } } });
    const result = await applyFeishuCredentials(fake.gateway, {
      appId: 'cli_new',
      appSecret: 'sec_new',
      openId: 'ou_user',
    });

    expect(result).toEqual({ ok: true, verified: true, appId: 'cli_new', boundAgentId: 'main' });
    expect(verifyFeishuChannelApplied({ config: fake.config }, 'cli_new')).toBe(true);
    expect(verifyFeishuBindingApplied({ config: fake.config }, 'main')).toBe(true);
    expect(fake.patches[0]!.replacePaths).toEqual(['bindings']);
    expect(fake.config['gateway']).toEqual({ auth: { mode: 'token', token: 't' } });
  });

  it('原本已有绑定（例如制作师）⇒ 原样保留，不抢回 main', async () => {
    const fake = createFakeGateway({
      bindings: [{ type: 'route', agentId: 'rongying-video', match: { channel: 'feishu' } }],
    });
    const result = await applyFeishuCredentials(fake.gateway, {
      appId: 'cli_new',
      appSecret: 'sec_new',
      openId: 'ou_user',
    });
    expect(result).toEqual({ ok: true, verified: true, appId: 'cli_new', boundAgentId: 'rongying-video' });
    expect(fake.patches[0]!.replacePaths).toBeUndefined();
    expect(readFeishuRouteBindingIds(fake.config)).toEqual(['rongying-video']);
  });

  it('⭐ 重新扫码换了账号：base 里有旧 allowFrom ⇒ 声明「整段替换」再写', async () => {
    const fake = createFakeGateway({
      channels: { feishu: { enabled: true, appId: 'cli_old', appSecret: 'old', allowFrom: ['ou_old'] } },
      bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }],
    });
    const result = await applyFeishuCredentials(fake.gateway, {
      appId: 'cli_new',
      appSecret: 'sec_new',
      openId: 'ou_new',
    });
    expect(result.ok).toBe(true);
    expect(fake.patches[0]!.replacePaths).toEqual(['channels.feishu.allowFrom']);
    const feishu = (fake.config['channels'] as Json)['feishu'] as Json;
    expect(feishu['allowFrom']).toEqual(['ou_new']);
    expect(feishu['appId']).toBe('cli_new');
  });

  it('乐观锁冲突（hash）⇒ 重读快照后重试一次即成功', async () => {
    const fake = createFakeGateway({}, { failPatchOnce: 'config changed since last load' });
    const result = await applyFeishuCredentials(fake.gateway, {
      appId: 'cli_x',
      appSecret: 's',
      openId: null,
    });
    expect(result.ok).toBe(true);
    expect(fake.patches).toHaveLength(1);
  });

  it('schema 拒绝 ⇒ rejected（不重试）', async () => {
    const fake = createFakeGateway({}, { failPatchOnce: 'Config write rejected: unknown key' });
    const result = await applyFeishuCredentials(fake.gateway, { appId: 'cli_x', appSecret: 's', openId: null });
    expect(result).toEqual({ ok: false, reason: 'rejected', message: 'Config write rejected: unknown key' });
    expect(fake.patches).toHaveLength(0);
  });

  it('写成功但回读不一致 ⇒ verify-failed（不假装成功）', async () => {
    const fake = createFakeGateway({}, { ignorePatch: true });
    const result = await applyFeishuCredentials(fake.gateway, { appId: 'cli_x', appSecret: 's', openId: null });
    expect(result).toEqual({ ok: false, reason: 'verify-failed' });
  });
});

describe('setFeishuRouteBinding / setFeishuChannelEnabled', () => {
  it('更换绑定与取消绑定都走 bindings 整段替换', async () => {
    const fake = createFakeGateway({
      bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }],
    });
    expect(await setFeishuRouteBinding(fake.gateway, 'writer')).toEqual({
      ok: true,
      verified: true,
      boundAgentId: 'writer',
    });
    expect(readFeishuRouteBindingIds(fake.config)).toEqual(['writer']);

    expect(await setFeishuRouteBinding(fake.gateway, null)).toEqual({
      ok: true,
      verified: true,
      boundAgentId: null,
    });
    expect(readFeishuRouteBindingIds(fake.config)).toEqual([]);
  });

  it('绑定已是目标值 ⇒ 不写（幂等）', async () => {
    const fake = createFakeGateway({
      bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }],
    });
    expect(await setFeishuRouteBinding(fake.gateway, 'main')).toEqual({
      ok: true,
      verified: true,
      boundAgentId: 'main',
    });
    expect(fake.patches).toHaveLength(0);
  });

  it('⭐ 关闭通道只写 enabled=false，不删凭证/绑定', async () => {
    const fake = createFakeGateway({
      channels: { feishu: { enabled: true, appId: 'cli_x', appSecret: 's', allowFrom: ['ou_1'] } },
      bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }],
    });
    expect(await setFeishuChannelEnabled(fake.gateway, false)).toEqual({
      ok: true,
      verified: true,
      appId: 'cli_x',
    });
    const feishu = (fake.config['channels'] as Json)['feishu'] as Json;
    expect(feishu['enabled']).toBe(false);
    expect(feishu['appId']).toBe('cli_x');
    expect(feishu['appSecret']).toBe('s');
    expect(readFeishuRouteBindingIds(fake.config)).toEqual(['main']);

    expect(await setFeishuChannelEnabled(fake.gateway, true)).toEqual({ ok: true, verified: true, appId: 'cli_x' });
    expect(((fake.config['channels'] as Json)['feishu'] as Json)['enabled']).toBe(true);
  });

  it('还没接入过 ⇒ not-configured（不写一个空 feishu 段）', async () => {
    const fake = createFakeGateway({});
    expect(await setFeishuChannelEnabled(fake.gateway, false)).toEqual({ ok: false, reason: 'not-configured' });
    expect(fake.patches).toHaveLength(0);
  });
});

describe('readFeishuRouteBindingsAt（盘上只读回退）', () => {
  let root = '';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'clawwork-feishu-bind-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('读 openclaw.json 的 bindings；缺失/坏 JSON ⇒ 空数组', () => {
    const configPath = join(root, 'openclaw.json');
    writeFileSync(
      configPath,
      JSON.stringify({ bindings: [{ type: 'route', agentId: 'main', match: { channel: 'feishu' } }] }),
      'utf8',
    );
    expect(readFeishuRouteBindingsAt(configPath)).toEqual(['main']);
    expect(readFeishuRouteBindingsAt(join(root, 'missing.json'))).toEqual([]);

    const broken = join(root, 'broken.json');
    writeFileSync(broken, '{ nope', 'utf8');
    expect(readFeishuRouteBindingsAt(broken)).toEqual([]);
  });
});

describe('hardenFeishuGroupPolicy（老配置迁移）', () => {
  it('⭐ groupPolicy=open ⇒ 收紧到 allowlist；重复调用不再写', async () => {
    const fake = createFakeGateway({ channels: { feishu: { appId: 'cli_x', groupPolicy: 'open' } } });
    expect(await hardenFeishuGroupPolicy(fake.gateway)).toEqual({ ok: true, changed: true });
    expect((fake.config['channels'] as Json)['feishu']).toMatchObject({ groupPolicy: 'allowlist' });
    expect(fake.patches).toHaveLength(1);

    expect(await hardenFeishuGroupPolicy(fake.gateway)).toEqual({ ok: true, changed: false });
    expect(fake.patches).toHaveLength(1);
  });

  it('没有 feishu 配置 / 已经是 allowlist ⇒ 不改', async () => {
    const none = createFakeGateway({});
    expect(await hardenFeishuGroupPolicy(none.gateway)).toEqual({ ok: true, changed: false });
    const safe = createFakeGateway({ channels: { feishu: { appId: 'cli_x', groupPolicy: 'allowlist' } } });
    expect(await hardenFeishuGroupPolicy(safe.gateway)).toEqual({ ok: true, changed: false });
    expect(safe.patches).toHaveLength(0);
  });
});
