import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「连接器 → 飞书」（2026-10-17，P3-lite）。
 *
 * 验三件事：
 *  ① 状态只从**盘上可确认的事实**推（配置 / 插件目录），形状不对一律当"没有"，不猜；
 *  ② 扫码脚本只含路径、不含密钥，且顺序是「先确认插件，再登录」；
 *  ③ 运行时不可用时**明确报错**，不开一个必然失败的窗口。
 */

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn);
    },
  },
}));

const {
  readFeishuConfig,
  readFeishuConfigAt,
  hasFeishuPlugin,
  buildFeishuBootstrapScript,
  assertBootstrapInputs,
  resolveBundledPluginPath,
} = await import('../src/main/connectors/feishu.js');
const { registerConnectorHandlers, resolveStateDir, readFeishuStatus } = await import(
  '../src/main/ipc/connector-handlers.js'
);

let root = '';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clawwork-connectors-'));
  mocks.handlers.clear();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('readFeishuConfig', () => {
  it('没有 channels.feishu ⇒ 未配置', () => {
    expect(readFeishuConfig({})).toEqual({ configured: false, appId: null, enabled: false });
    expect(readFeishuConfig({ channels: {} })).toEqual({ configured: false, appId: null, enabled: false });
  });

  it('有 appId ⇒ 已配置；enabled:false 仍算"配置过"（用户主动关的）', () => {
    expect(readFeishuConfig({ channels: { feishu: { appId: 'cli_abc', enabled: true } } })).toEqual({
      configured: true,
      appId: 'cli_abc',
      enabled: true,
    });
    expect(readFeishuConfig({ channels: { feishu: { appId: 'cli_abc', enabled: false } } })).toEqual({
      configured: true,
      appId: 'cli_abc',
      enabled: false,
    });
  });

  it('形状不对（数组 / 空 appId）⇒ 未配置，不猜', () => {
    expect(readFeishuConfig({ channels: { feishu: [] } }).configured).toBe(false);
    expect(readFeishuConfig({ channels: { feishu: { appId: '   ' } } }).configured).toBe(false);
  });

  it('配置文件缺失或坏 JSON ⇒ 未配置（不抛）', () => {
    const missing = join(root, 'nope.json');
    expect(readFeishuConfigAt(missing).configured).toBe(false);
    const broken = join(root, 'openclaw.json');
    writeFileSync(broken, '{ not json', 'utf8');
    expect(readFeishuConfigAt(broken).configured).toBe(false);
  });
});

describe('hasFeishuPlugin', () => {
  it('⭐ extensions/feishu（plugins install 的真实落点）⇒ true', () => {
    const stateDir = join(root, 'state');
    mkdirSync(join(stateDir, 'extensions', 'feishu'), { recursive: true });
    expect(hasFeishuPlugin(stateDir)).toBe(true);
    expect(hasFeishuPlugin(join(root, 'other-state'))).toBe(false);
  });

  it('旧形状 npm/projects 下有 feishu 包目录 ⇒ 也认', () => {
    const stateDir = join(root, 'state-legacy');
    mkdirSync(join(stateDir, 'npm', 'projects', 'openclaw-feishu-abc123'), { recursive: true });
    expect(hasFeishuPlugin(stateDir)).toBe(true);
  });

  it('目录存在但没有 feishu ⇒ false', () => {
    const stateDir = join(root, 'state2');
    mkdirSync(join(stateDir, 'npm', 'projects', 'openclaw-other'), { recursive: true });
    expect(hasFeishuPlugin(stateDir)).toBe(false);
  });
});

describe('buildFeishuBootstrapScript（PowerShell 内联命令）', () => {
  it('⭐ 有随包目录 ⇒ 复制 + 建 Junction + 扫码；不再走 tar/npm', () => {
    const cmd = buildFeishuBootstrapScript({
      nodePath: 'C:\rt\node.exe',
      cliPath: 'C:\rt\node_modules\openclaw\openclaw.mjs',
      stateDir: 'C:\data\openclaw-state',
      bundledPluginDir: 'C:\app\resources\connectors\feishu',
    });
    expect(cmd).toContain("robocopy 'C:\app\resources\connectors\feishu'");
    expect(cmd).toContain('New-Item -ItemType Junction');
    expect(cmd).toContain('channels login --channel feishu');
    // 复制在扫码之前
    expect(cmd.indexOf('robocopy')).toBeLessThan(cmd.indexOf('channels login'));
    // 不联网、不碰执行策略
    expect(cmd).not.toContain('plugins install @openclaw');
    expect(cmd).not.toContain('ExecutionPolicy');
    // 单引号字符串里没有双引号（外层要包一层）
    expect(cmd).not.toContain('"');
  });

  it('⭐ 主进程已装好 ⇒ 终端只剩扫码（不再让用户看复制/解压）', () => {
    const cmd = buildFeishuBootstrapScript({
      nodePath: 'C:\rt\node.exe',
      cliPath: 'C:\rt\node_modules\openclaw\openclaw.mjs',
      stateDir: 'C:\data\openclaw-state',
      bundledPluginDir: 'C:\app\resources\connectors\feishu',
      pluginAlreadyInstalled: true,
    });
    expect(cmd).toContain('飞书插件已就绪');
    expect(cmd).not.toContain('robocopy');
    expect(cmd).not.toContain('plugins install');
    expect(cmd).toContain('channels login --channel feishu');
  });

  it('没有随包目录 ⇒ 退回联网安装（并给出失败提示）', () => {
    const cmd = buildFeishuBootstrapScript({
      nodePath: 'n',
      cliPath: 'c',
      stateDir: 's',
      bundledPluginDir: null,
    });
    expect(cmd).toContain('plugins install @openclaw/feishu@2026.9.3');
    expect(cmd).toContain('插件安装失败');
  });

  it('路径里的单引号会被转义（PowerShell 规则：两个单引号）', () => {
    const cmd = buildFeishuBootstrapScript({
      nodePath: "C:\it's\node.exe",
      cliPath: 'c',
      stateDir: 's',
      bundledPluginDir: null,
    });
    expect(cmd).toContain("'C:\it''s\node.exe'");
  });
});

describe('resolveBundledPluginPath（自带安装的资源定位）', () => {
  it('开发态：<appPath>/resources/connectors/feishu（要有 package.json）；打包态同理', async () => {
    const { FEISHU_PLUGIN_PACKAGE_DIR } = await import('../src/main/connectors/feishu.js');
    const devApp = join(root, 'app');
    const devDir = join(devApp, 'resources', 'connectors', FEISHU_PLUGIN_PACKAGE_DIR);
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(devDir, 'package.json'), '{"name":"@openclaw/feishu"}', 'utf8');
    expect(resolveBundledPluginPath({ isPackaged: false, appPath: devApp })).toBe(devDir);

    const resources = join(root, 'packed-resources');
    const packedDir = join(resources, 'connectors', FEISHU_PLUGIN_PACKAGE_DIR);
    mkdirSync(packedDir, { recursive: true });
    writeFileSync(join(packedDir, 'package.json'), '{"name":"@openclaw/feishu"}', 'utf8');
    expect(resolveBundledPluginPath({ isPackaged: true, resourcesPath: resources, appPath: devApp })).toBe(packedDir);

    // 目录缺 package.json ⇒ undefined（退回联网安装，不假装自带）
    const empty = join(root, 'empty-resources', 'connectors', FEISHU_PLUGIN_PACKAGE_DIR);
    mkdirSync(empty, { recursive: true });
    expect(
      resolveBundledPluginPath({ isPackaged: true, resourcesPath: join(root, 'empty-resources') }),
    ).toBeUndefined();
  });
});

describe('installBundledFeishu（主进程静默安装，2026-10-17 用户："用户直接使用"）', () => {
  async function fixture() {
    const { installBundledFeishu } = await import('../src/main/connectors/feishu.js');
    const bundled = join(root, 'resources', 'connectors', 'feishu');
    mkdirSync(join(bundled, 'dist'), { recursive: true });
    writeFileSync(join(bundled, 'package.json'), '{"name":"@openclaw/feishu"}', 'utf8');
    writeFileSync(join(bundled, 'dist', 'index.js'), 'module.exports={}', 'utf8');
    const runtime = join(root, 'runtime', 'node_modules', 'openclaw');
    mkdirSync(runtime, { recursive: true });
    writeFileSync(join(runtime, 'openclaw.mjs'), '', 'utf8');
    const state = join(root, 'state');
    mkdirSync(state, { recursive: true });
    return { installBundledFeishu, bundled, runtime, state };
  }

  it('把随包目录复制到 <state>/extensions/feishu 并补 openclaw 目录联接（装完即可被识别）', async () => {
    const { installBundledFeishu, bundled, runtime, state } = await fixture();
    const result = await installBundledFeishu({ bundledDir: bundled, stateDir: state, openclawPackageDir: runtime });

    expect(result).toEqual({ ok: true, copied: true });
    expect(hasFeishuPlugin(state)).toBe(true);
    expect(existsSync(join(state, 'extensions', 'feishu', 'package.json'))).toBe(true);
    expect(existsSync(join(state, 'extensions', 'feishu', 'dist', 'index.js'))).toBe(true);
    const link = join(state, 'extensions', 'feishu', 'node_modules', 'openclaw');
    expect(realpathSync(link)).toBe(realpathSync(runtime));
  });

  it('已装过 ⇒ 幂等跳过（不重复复制）', async () => {
    const { installBundledFeishu, bundled, runtime, state } = await fixture();
    expect(await installBundledFeishu({ bundledDir: bundled, stateDir: state, openclawPackageDir: runtime })).toEqual({
      ok: true,
      copied: true,
    });
    expect(await installBundledFeishu({ bundledDir: bundled, stateDir: state, openclawPackageDir: runtime })).toEqual({
      ok: true,
      copied: false,
    });
  });

  it('随包目录缺失/形状不对 ⇒ 具名失败，不建目录（不假装装好了）', async () => {
    const { installBundledFeishu, runtime, state } = await fixture();
    const missing = join(root, 'nope');
    expect(await installBundledFeishu({ bundledDir: missing, stateDir: state, openclawPackageDir: runtime })).toEqual({
      ok: false,
      reason: 'bundled-missing',
    });
    expect(existsSync(join(state, 'extensions', 'feishu'))).toBe(false);
  });
});

describe('assertBootstrapInputs', () => {
  it('运行时或状态目录缺失 ⇒ 具名原因', () => {
    expect(assertBootstrapInputs({ nodePath: join(root, 'n'), cliPath: join(root, 'c'), stateDir: root })).toEqual({
      ok: false,
      reason: 'runtime-missing',
    });
    const nodePath = join(root, 'node.exe');
    const cliPath = join(root, 'cli.mjs');
    writeFileSync(nodePath, '', 'utf8');
    writeFileSync(cliPath, '', 'utf8');
    expect(assertBootstrapInputs({ nodePath, cliPath, stateDir: join(root, 'gone') })).toEqual({
      ok: false,
      reason: 'state-missing',
    });
    expect(assertBootstrapInputs({ nodePath, cliPath, stateDir: root })).toEqual({ ok: true });
  });
});

describe('状态 IPC', () => {
  it('resolveStateDir：env 优先，缺了退回 userData 推导', () => {
    expect(resolveStateDir('C:\\ud', ' C:\\state ')).toBe('C:\\state');
    expect(resolveStateDir('C:\\ud', '')).toContain('openclaw-state');
  });

  it('readFeishuStatus：配置 + 插件目录 + 运行时三件分别报，不把它们混成一个"已连接"', () => {
    const stateDir = join(root, 'state');
    mkdirSync(join(stateDir, 'npm', 'projects', 'openclaw-feishu-x'), { recursive: true });
    writeFileSync(
      join(stateDir, 'openclaw.json'),
      JSON.stringify({ channels: { feishu: { appId: 'cli_x', enabled: true } } }),
      'utf8',
    );
    const status = readFeishuStatus(stateDir, join(root, 'user-data'));
    expect(status.configured).toBe(true);
    expect(status.appId).toBe('cli_x');
    expect(status.pluginInstalled).toBe(true);
    // 没有部署指针 ⇒ 运行时不可用
    expect(status.runtimeReady).toBe(false);
  });

  it('connectors:status 走注入的状态函数（不碰真盘也能测接线）', async () => {
    registerConnectorHandlers({
      userDataDir: root,
      stateDir: join(root, 'state'),
      readStatus: () => ({
        id: 'feishu',
        configured: false,
        appId: null,
        enabled: false,
        pluginInstalled: false,
        runtimeReady: true,
      }),
    });
    const handler = mocks.handlers.get('connectors:status');
    expect(handler).toBeTruthy();
    const result = (await handler!()) as { ok: boolean; result: { connectors: Array<{ id: string }> } };
    expect(result.ok).toBe(true);
    expect(result.result.connectors[0]?.id).toBe('feishu');
  });

  it('运行时不可用 ⇒ feishu-login 明确报 runtime-missing，且不调用 launch', async () => {
    let launched = 0;
    registerConnectorHandlers({
      userDataDir: join(root, 'user-data'),
      stateDir: join(root, 'state'),
      launch: () => {
        launched += 1;
      },
    });
    const handler = mocks.handlers.get('connectors:feishu-login');
    const result = (await handler!()) as { ok: boolean; error?: string };
    expect(result.ok).toBe(false);
    expect(result.error).toBe('runtime-missing');
    expect(launched).toBe(0);
  });
});
