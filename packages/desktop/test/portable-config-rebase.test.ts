/**
 * 换盘重写（config rebase）—— **按键名**深度重写，而不是逐字段列举。
 *
 * 缺陷（2026-10-15，C2 深度重写）：`rebasePortableConfig` 只列举了
 * `agents.*.workspace|agentDir`、`session.store`、`cron.store`、`skills.load.extraDirs`。
 * `plugins.load.paths` **不在名单里** —— 换盘符后 stateDir 变了而它没变，而它正是
 * 三个承重插件的**唯一**加载入口（收件箱只读守卫 / 联网搜索 provider / 重试守卫），
 * 且恰好落在 stateDir 之下。少重写一个字段 = 网关照常起、插件静默失效、
 * 一条日志都不打（`state-config.ts` 的注释已实测记录过这个形态）。
 *
 * 本文件是**行为**测试：全部通过 `rebasePortableConfig` 这个公开出口断言，因此
 * 在修复前会红（RED），修复后全绿（GREEN），不依赖内部函数名。
 *
 * 判据两层（缺一层要么误伤用户数据、要么漏改）：
 *   ① 值层：字符串 + 绝对路径 + 落在旧 workspacePath/stateDir 之下 ⇒ 才重写；
 *   ② 键层：键名像路径（精确名单 + 后缀）⇒ 才参与；`prompt/title/note` 这类
 *      文本字段**即使值长得像路径也不许改**。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPathKey, rebaseConfigPaths } from '../src/main/runtime/config-rebase.js';
import { preparePortableState, rebasePortableConfig } from '../src/main/runtime/portable-state-migration.js';

/** 与生产一致的插件目录（`<stateDir>/<族>/<插件 id>`）。 */
const INBOX_GUARD_DIR = 'policies\\rongying-inbox-readonly';
const SEARCH_PROVIDER_DIR = 'providers\\rongying-search';
const RETRY_GUARD_DIR = 'policies\\rongying-retry-guard';

const OLD_STATE = 'E:\\app-data\\state\\identity';
const OLD_WORKSPACE = 'E:\\workspace';
const NEW_STATE = 'F:\\app-data\\state\\identity';
const NEW_WORKSPACE = 'F:\\workspace';

const OLD = { stateDir: OLD_STATE, workspacePath: OLD_WORKSPACE };
const NEW = { stateDir: NEW_STATE, workspacePath: NEW_WORKSPACE };

const pluginLoadPaths = (config: unknown): unknown[] => {
  const plugins = (config as { plugins: { load: { paths: unknown[] } } }).plugins;
  return plugins.load.paths;
};

describe('portable config rebase — plugins.load.paths（C2 深度重写）', () => {
  it('🔴 rewrites every plugins.load.paths entry that lives under the old state directory', () => {
    const config = {
      plugins: {
        load: {
          paths: [
            `${OLD_STATE}\\${INBOX_GUARD_DIR}`,
            `${OLD_STATE}\\${SEARCH_PROVIDER_DIR}`,
            `${OLD_STATE}\\${RETRY_GUARD_DIR}`,
          ],
        },
      },
    };
    const result = rebasePortableConfig(config, OLD, NEW);
    // 三个插件目录同时在场 ⇒ 三个都必须落到新 stateDir（少一个 = 那个插件静默失效）
    expect(pluginLoadPaths(result)).toEqual([
      `${NEW_STATE}\\${INBOX_GUARD_DIR}`,
      `${NEW_STATE}\\${SEARCH_PROVIDER_DIR}`,
      `${NEW_STATE}\\${RETRY_GUARD_DIR}`,
    ]);
  });

  it('🔴 rewrites path-shaped keys nested under plugins.entries (per-plugin config)', () => {
    const result = rebasePortableConfig(
      {
        plugins: {
          load: { paths: [`${OLD_STATE}\\${SEARCH_PROVIDER_DIR}`] },
          entries: {
            'rongying-search': {
              enabled: true,
              config: {
                webSearch: {
                  baseUrl: 'https://relay.example.test',
                  apiKey: 'rly_should_not_change',
                  cacheDir: `${OLD_STATE}\\cache\\search`,
                },
              },
            },
          },
        },
      },
      OLD,
      NEW,
    );
    const entries = (result.plugins as { entries: Record<string, Record<string, unknown>> }).entries;
    const entry = entries['rongying-search'];
    expect(entry.enabled).toBe(true);
    const webSearch = (entry.config as { webSearch: Record<string, unknown> }).webSearch;
    expect(webSearch.cacheDir).toBe(`${NEW_STATE}\\cache\\search`);
    expect(webSearch.baseUrl).toBe('https://relay.example.test');
    expect(webSearch.apiKey).toBe('rly_should_not_change');
  });

  it('🔴 rewrites sessionFile-style path keys anywhere in the tree', () => {
    const result = rebasePortableConfig(
      { sessions: { index: [{ sessionFile: `${OLD_STATE}\\agents\\main\\sessions\\a.json` }] } },
      OLD,
      NEW,
    );
    expect(result).toEqual({
      sessions: { index: [{ sessionFile: `${NEW_STATE}\\agents\\main\\sessions\\a.json` }] },
    });
  });

  it('🔴 rewrites `*File` path fields nested under channels (BUG-096: channels.telegram.tokenFile)', () => {
    // 反例（2026-10-16 审计）：`tokenFile` 不在精确名单、后缀正则也不含 `file`
    // ⇒ 换盘后仍指向旧盘的令牌文件；旧盘一消失，网关就读不到 token。
    // 这不是虚构字段：随包 OpenClaw 2026.9.3 的 config schema 里
    // `channels.telegram.tokenFile: string().optional()`，且明示从该文件读 token。
    const { config, changed } = rebaseConfigPaths(
      { channels: { telegram: { tokenFile: `${OLD_STATE}\\telegram.token` } } },
      OLD,
      NEW,
    );
    expect((config.channels as { telegram: { tokenFile: string } }).telegram.tokenFile).toBe(
      `${NEW_STATE}\\telegram.token`,
    );
    expect(changed).toEqual(['/channels/telegram/tokenFile']);
  });

  it('🔴 `*File` 判据是"词"而不是后缀 —— `profile` 这类整体小写词不许被卷进来', () => {
    // `profile` 的后四个字符**也是** `file`。用后缀正则的写法会把它（以及
    // `userProfile`）当成路径键 ⇒ 值层一旦命中旧根就会改写画像字段。
    expect(isPathKey('tokenFile'), 'tokenFile').toBe(true);
    expect(isPathKey('tokenFiles')).toBe(true);
    expect(isPathKey('session_file')).toBe(true);
    expect(isPathKey('token-file')).toBe(true);
    expect(isPathKey('profile'), '`profile` 不是路径键').toBe(false);
    expect(isPathKey('userProfile')).toBe(false);
    expect(isPathKey('Profile')).toBe(false);

    const result = rebasePortableConfig(
      // 值层判据全部命中（绝对路径 + 落在旧根之下），只有键层能挡住
      { profile: `${OLD_STATE}\\looks-like-a-path`, userProfile: `${OLD_WORKSPACE}\\agents\\x` },
      OLD,
      NEW,
    );
    expect(result.profile).toBe(`${OLD_STATE}\\looks-like-a-path`);
    expect(result.userProfile).toBe(`${OLD_WORKSPACE}\\agents\\x`);
  });

  it('🔴 rewrites stateDir-rooted plugin paths even when only the state directory moved', () => {
    const result = rebasePortableConfig({ plugins: { load: { paths: [`${OLD_STATE}\\${RETRY_GUARD_DIR}`] } } }, OLD, {
      stateDir: 'G:\\other\\state',
      workspacePath: NEW_WORKSPACE,
    });
    expect(pluginLoadPaths(result)).toEqual([`G:\\other\\state\\${RETRY_GUARD_DIR}`]);
  });

  it('keeps the previously enumerated fields working (regression: agents/session/cron/skills)', () => {
    const result = rebasePortableConfig(
      {
        agents: {
          defaults: { workspace: OLD_WORKSPACE, agentDir: `${OLD_STATE}\\agents\\defaults\\agent` },
          entries: { analyst: { workspace: `${OLD_WORKSPACE}\\agents\\analyst` } },
          list: [{ workspace: `${OLD_WORKSPACE}\\agents\\listed` }],
        },
        session: { store: `${OLD_STATE}\\sessions` },
        cron: { store: `${OLD_STATE}\\cron` },
        skills: { load: { extraDirs: [`${OLD_STATE}\\skills`] } },
      },
      OLD,
      NEW,
    );
    expect(result).toEqual({
      agents: {
        defaults: { workspace: NEW_WORKSPACE, agentDir: `${NEW_STATE}\\agents\\defaults\\agent` },
        entries: { analyst: { workspace: `${NEW_WORKSPACE}\\agents\\analyst` } },
        list: [{ workspace: `${NEW_WORKSPACE}\\agents\\listed` }],
      },
      session: { store: `${NEW_STATE}\\sessions` },
      cron: { store: `${NEW_STATE}\\cron` },
      skills: { load: { extraDirs: [`${NEW_STATE}\\skills`] } },
    });
  });
});

describe('portable config rebase — 控制项（不许误改）', () => {
  it('① keeps absolute paths the user pointed at somewhere else', () => {
    const result = rebasePortableConfig(
      {
        agents: { entries: { main: { workspace: `${OLD_WORKSPACE}\\ok`, agentDir: 'D:\\user\\external\\agent' } } },
        plugins: {
          load: { paths: ['D:\\user\\my-plugins', 'C:\\Program Files\\other', `${OLD_STATE}\\policies\\p`] },
        },
      },
      OLD,
      NEW,
    );
    const main = (result.agents as { entries: Record<string, Record<string, unknown>> }).entries.main;
    expect(main.agentDir).toBe('D:\\user\\external\\agent');
    expect(pluginLoadPaths(result)).toEqual([
      'D:\\user\\my-plugins',
      'C:\\Program Files\\other',
      `${NEW_STATE}\\policies\\p`,
    ]);
  });

  it('② never rewrites prose fields whose value merely looks like a path', () => {
    const prose = `${OLD_WORKSPACE}\\agents\\analyst`;
    const result = rebasePortableConfig(
      {
        prompt: prose,
        title: prose,
        description: prose,
        note: `${OLD_STATE}\\policies\\x`,
        systemPrompt: prose,
        instructions: prose,
        messages: [{ content: prose }],
        agents: { entries: { main: { workspace: OLD_WORKSPACE, prompt: prose, label: prose } } },
      },
      OLD,
      NEW,
    );
    expect(result.prompt).toBe(prose);
    expect(result.title).toBe(prose);
    expect(result.description).toBe(prose);
    expect(result.note).toBe(`${OLD_STATE}\\policies\\x`);
    expect(result.systemPrompt).toBe(prose);
    expect(result.instructions).toBe(prose);
    expect(result.messages).toEqual([{ content: prose }]);
    const main = (result.agents as { entries: Record<string, Record<string, unknown>> }).entries.main;
    expect(main.workspace).toBe(NEW_WORKSPACE);
    expect(main.prompt).toBe(prose);
    expect(main.label).toBe(prose);
  });

  it('③ boundary: casing / trailing separator / forward slashes', () => {
    const result = rebasePortableConfig(
      {
        agents: {
          entries: {
            // 大小写不敏感（Windows 盘符/目录名）
            casing: { workspace: `${OLD_WORKSPACE.toUpperCase()}\\agents\\x` },
            // 尾分隔符
            trailing: { workspace: `${OLD_WORKSPACE}\\` },
            // 正斜杠写法
            slashes: { workspace: `${OLD_WORKSPACE.replaceAll('\\', '/')}/agents/y` },
          },
        },
        session: { store: `${OLD_WORKSPACE.slice(2)}\\sessions` },
      },
      OLD,
      NEW,
    );
    const entries = (result.agents as { entries: Record<string, Record<string, unknown>> }).entries;
    expect(entries.casing.workspace).toBe(`${NEW_WORKSPACE}\\agents\\x`);
    expect(path.win32.normalize(entries.trailing.workspace as string)).toBe(path.win32.normalize(NEW_WORKSPACE));
    expect(entries.slashes.workspace).toBe(`${NEW_WORKSPACE}\\agents\\y`);
    // 相对路径一律不动（不是绝对路径）
    expect(result.session).toEqual({ store: `${OLD_WORKSPACE.slice(2)}\\sessions` });
  });

  it('③b boundary: sibling prefix is not "under" the old root (workspace and plugins)', () => {
    const result = rebasePortableConfig(
      {
        agents: { entries: { sibling: { workspace: `${OLD_WORKSPACE}-other` } } },
        plugins: { load: { paths: [`${OLD_STATE}\\policies`, `${OLD_STATE}-backup\\policies`] } },
      },
      OLD,
      NEW,
    );
    const sibling = (result.agents as { entries: Record<string, Record<string, unknown>> }).entries.sibling;
    expect(sibling.workspace).toBe(`${OLD_WORKSPACE}-other`);
    expect(pluginLoadPaths(result)).toEqual([`${NEW_STATE}\\policies`, `${OLD_STATE}-backup\\policies`]);
  });

  it('③c leaves relative paths, empty strings and non-string values alone', () => {
    const result = rebasePortableConfig(
      {
        agents: { entries: { main: { workspace: 'workspace\\relative', agentDir: '' } } },
        session: { store: '' },
        plugins: { load: { paths: ['relative\\plugins', 42, null, true] } },
      },
      OLD,
      NEW,
    );
    const main = (result.agents as { entries: Record<string, Record<string, unknown>> }).entries.main;
    expect(main.workspace).toBe('workspace\\relative');
    expect(main.agentDir).toBe('');
    expect(result.session).toEqual({ store: '' });
    expect(pluginLoadPaths(result)).toEqual(['relative\\plugins', 42, null, true]);
  });

  it('⑤ is idempotent: a second pass over the result changes nothing', () => {
    const config = {
      agents: { entries: { main: { workspace: OLD_WORKSPACE } } },
      plugins: {
        load: { paths: [`${OLD_STATE}\\${INBOX_GUARD_DIR}`, 'D:\\user\\mine'] },
        entries: { 'rongying-inbox-readonly': { enabled: true, config: { policyDir: `${OLD_STATE}\\policies` } } },
      },
    };
    const once = rebasePortableConfig(config, OLD, NEW);
    const twice = rebasePortableConfig(once, OLD, NEW);
    expect(twice).toEqual(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // 同盘（previous === next）= 空操作
    const same = { plugins: { load: { paths: [`${NEW_STATE}\\policies`] } } };
    expect(rebasePortableConfig(same, NEW, NEW)).toEqual(same);
  });

  it('does not mutate its input (structuredClone)', () => {
    const config = {
      plugins: { load: { paths: [`${OLD_STATE}\\${INBOX_GUARD_DIR}`] } },
      agents: { entries: { main: { workspace: OLD_WORKSPACE } } },
    };
    const snapshot = JSON.stringify(config);
    rebasePortableConfig(config, OLD, NEW);
    expect(JSON.stringify(config)).toBe(snapshot);
  });

  it('does not relax the workspace guard: another folder on the same drive is not remapped', () => {
    expect(
      rebasePortableConfig(
        {
          agents: { entries: { analyst: { workspace: 'E:\\old-project\\analyst' } } },
          plugins: { load: { paths: ['E:\\old-project\\plugins'] } },
        },
        { stateDir: 'E:\\data\\state\\identity', workspacePath: 'E:\\old-project' },
        { stateDir: 'E:\\data\\state\\identity', workspacePath: 'E:\\new-project' },
      ),
    ).toEqual({
      agents: { entries: { analyst: { workspace: 'E:\\old-project\\analyst' } } },
      plugins: { load: { paths: ['E:\\old-project\\plugins'] } },
    });
  });
});

describe('portable config rebase — 键名判据（第二层，防误改）', () => {
  it('treats production path field names as path keys', () => {
    for (const key of [
      'workspace',
      'agentDir',
      'paths',
      'path',
      'store',
      'extraDirs',
      'sessionFile',
      'workspacePath',
      'stateRoot',
      'allowedPaths',
      'cwd',
      'cacheDir',
      'policyDir',
      'templatePath',
      'tokenFile',
      'webhookCertPath',
    ])
      expect(isPathKey(key), key).toBe(true);
  });

  it('never treats prose/非路径 field names as path keys', () => {
    for (const key of [
      'prompt',
      'systemPrompt',
      'title',
      'note',
      'description',
      'instructions',
      'label',
      'content',
      'message',
      'text',
      'apiKey',
      'baseUrl',
      'model',
      'enabled',
      'name',
      'summary',
      'storage',
      'profile',
    ])
      expect(isPathKey(key), key).toBe(false);
  });

  it('known boundary: the suffix rule is literal (`restore` ends with `store`) — the value layer still guards it', () => {
    expect(isPathKey('restore')).toBe(true);
    // 键名宽进不会篡改数据：值层还要求"绝对路径且落在旧根之下"，其余一律原样返回
    const { config, changed } = rebaseConfigPaths(
      { restore: true, restorePoint: 'D:\\backups\\x', restorePrompt: '把 E:\\workspace 恢复一下' },
      OLD,
      NEW,
    );
    expect(changed).toEqual([]);
    expect(config).toEqual({
      restore: true,
      restorePoint: 'D:\\backups\\x',
      restorePrompt: '把 E:\\workspace 恢复一下',
    });
  });

  it('reports the changed pointers and touches nothing else in a realistic config', () => {
    const config = {
      gateway: { auth: { token: 'identity' } },
      agents: {
        defaults: { workspace: OLD_WORKSPACE, prompt: `整理 ${OLD_WORKSPACE} 里的文件` },
        entries: { main: { workspace: `${OLD_WORKSPACE}\\agents\\main`, agentDir: 'D:\\user\\external\\agent' } },
      },
      session: { store: `${OLD_STATE}\\sessions` },
      cron: { store: `${OLD_STATE}\\cron` },
      skills: { load: { extraDirs: [`${OLD_STATE}\\skills`, 'D:\\user\\my-skills'] } },
      plugins: {
        load: { paths: [`${OLD_STATE}\\${INBOX_GUARD_DIR}`, 'D:\\user\\my-plugins'] },
        entries: {
          'rongying-search': {
            enabled: true,
            config: { webSearch: { baseUrl: 'https://relay.example.test', apiKey: 'rly_x' } },
          },
        },
      },
      tools: { effective: [{ family: 'base-coding', note: `工作区在 ${OLD_WORKSPACE}` }] },
    };
    const { config: result, changed } = rebaseConfigPaths(config, OLD, NEW);
    // 只有"路径键 + 落在旧根之下"的值被改；其余（含长得像路径的文本）逐字不动
    expect(changed).toEqual([
      '/agents/defaults/workspace',
      '/agents/entries/main/workspace',
      '/session/store',
      '/cron/store',
      '/skills/load/extraDirs[0]',
      '/plugins/load/paths[0]',
    ]);
    expect(result.gateway).toEqual({ auth: { token: 'identity' } });
    expect(result.agents.defaults.prompt).toBe(`整理 ${OLD_WORKSPACE} 里的文件`);
    expect(result.agents.entries.main.agentDir).toBe('D:\\user\\external\\agent');
    expect(result.skills.load.extraDirs[1]).toBe('D:\\user\\my-skills');
    expect(pluginLoadPaths(result)).toEqual([`${NEW_STATE}\\${INBOX_GUARD_DIR}`, 'D:\\user\\my-plugins']);
    expect((result.tools as { effective: { note: string }[] }).effective[0].note).toBe(`工作区在 ${OLD_WORKSPACE}`);
  });

  it('keeps non-plain objects (Date/class instances) untouched while rebuilding plain records', () => {
    const stamp = new Date('2026-10-15T00:00:00.000Z');
    const { config: result } = rebaseConfigPaths(
      { meta: { stampedAt: stamp }, plugins: { load: { paths: [`${OLD_STATE}\\policies`] } } },
      OLD,
      NEW,
    );
    expect((result.meta as { stampedAt: Date }).stampedAt).toBeInstanceOf(Date);
    expect((result.meta as { stampedAt: Date }).stampedAt.getTime()).toBe(stamp.getTime());
    expect(pluginLoadPaths(result)).toEqual([`${NEW_STATE}\\policies`]);
  });

  it('returns zero changes when nothing is rebased (idempotent second pass over a real config)', () => {
    const config = {
      agents: { entries: { main: { workspace: OLD_WORKSPACE } } },
      plugins: { load: { paths: [`${OLD_STATE}\\policies`] } },
    };
    const once = rebaseConfigPaths(config, OLD, NEW);
    expect(once.changed).toHaveLength(2);
    const twice = rebaseConfigPaths(once.config, OLD, NEW);
    expect(twice.changed).toEqual([]);
    expect(twice.config).toEqual(once.config);
  });
});

describe('portable config rebase — 迁移链端到端（真文件）', () => {
  let root: string;
  let target: string;
  let source: string;
  const token = 'test-portable-identity';
  const OLD_STATE_ROOT = 'E:\\state';
  const OLD_WORKSPACE_ROOT = 'E:\\workspace';
  const readLease = async () => ({ assertHeld() {}, async release() {} });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-config-rebase-'));
    target = path.join(root, 'new-state');
    source = path.join(root, 'source-state');
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(source, { recursive: true });
    const snapshot = JSON.stringify(
      {
        gateway: { auth: { token } },
        agents: { entries: { main: { workspace: OLD_WORKSPACE_ROOT } } },
        plugins: {
          load: {
            paths: [
              `${OLD_STATE_ROOT}\\policies\\rongying-inbox-readonly`,
              `${OLD_STATE_ROOT}\\providers\\rongying-search`,
              `${OLD_STATE_ROOT}\\policies\\rongying-retry-guard`,
            ],
          },
        },
      },
      null,
      2,
    );
    fs.writeFileSync(path.join(target, 'openclaw.json'), snapshot);
    // 快照副本：`state-config.ts` 的换盘自愈只重写**活配置**，`.bak`/`.last-good`
    // 只有这一层（迁移 rebase）会改 —— 漏了它，用快照回滚就把旧盘符路径又请回来。
    fs.writeFileSync(path.join(target, 'openclaw.json.bak'), snapshot);
    fs.writeFileSync(
      path.join(target, '.clawwork-portable-state.json'),
      JSON.stringify({ version: 1, stateDir: OLD_STATE_ROOT, workspacePath: OLD_WORKSPACE_ROOT }),
    );
  });

  afterEach(() => {
    if (root.startsWith(path.join(os.tmpdir(), 'clawwork-config-rebase-')))
      fs.rmSync(root, { recursive: true, force: true });
  });

  it('🔴 a real migration leaves no old-drive plugin path in the rewritten config file', async () => {
    await preparePortableState({
      sourceDir: source,
      stateDir: target,
      workspacePath: path.join(root, 'workspace'),
      token,
      acquireLease: readLease,
    });
    const written = JSON.parse(fs.readFileSync(path.join(target, 'openclaw.json'), 'utf8')) as unknown;
    const resolved = path.resolve(target);
    expect(pluginLoadPaths(written)).toEqual([
      `${resolved}\\policies\\rongying-inbox-readonly`,
      `${resolved}\\providers\\rongying-search`,
      `${resolved}\\policies\\rongying-retry-guard`,
    ]);
    // 快照副本（.bak）同样不许留旧盘符路径
    const backup = JSON.parse(fs.readFileSync(path.join(target, 'openclaw.json.bak'), 'utf8')) as unknown;
    expect(pluginLoadPaths(backup)).toEqual([
      `${resolved}\\policies\\rongying-inbox-readonly`,
      `${resolved}\\providers\\rongying-search`,
      `${resolved}\\policies\\rongying-retry-guard`,
    ]);
    // 写回的 marker 也必须是新位置（既有行为，防回归）
    expect(
      JSON.parse(fs.readFileSync(path.join(target, '.clawwork-portable-state.json'), 'utf8')) as unknown,
    ).toMatchObject({ stateDir: resolved });
  });
});
