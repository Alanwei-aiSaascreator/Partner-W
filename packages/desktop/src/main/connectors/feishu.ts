import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cp, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * 「飞书连接器」的状态读取与扫码引导（P3-lite）。
 *
 * 产品边界（2026-10-17 用户要求）：把接入放进应用内的「连接器」，不再让用户
 * 去桌面双击一个 cmd。
 *
 * ⚠️ **这里只做"能不能用/怎么开始"，不做"已经连上了"的报告**：
 *    · 飞书通道跑在**网关进程**里（`@openclaw/feishu` 插件），长连接状态只有网关知道；
 *    · 桌面侧没有 `channels.status` 这条查询（内核未暴露给我们）。
 *    ⇒ 状态只报**可从盘上确认的两件事**：配置里有没有 `channels.feishu`、
 *      插件有没有落盘。界面文案必须按这个口径写，不许把"已配置"说成"已连接"。
 */

/** 配置里 `channels.feishu` 的可用投影。 */
export interface FeishuConfigSnapshot {
  /** 写进了 `channels.feishu` 且有 appId（= 扫码/手填至少成功过一次）。 */
  configured: boolean;
  appId: string | null;
  enabled: boolean;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 从 `openclaw.json` 的整份配置里取 `channels.feishu`（形状不对 = 未配置，不猜）。 */
export function readFeishuConfig(config: unknown): FeishuConfigSnapshot {
  const feishu = recordOf(recordOf(config)?.channels)?.['feishu'];
  const row = recordOf(feishu);
  if (!row) return { configured: false, appId: null, enabled: false };
  const appId = typeof row.appId === 'string' && row.appId.trim() ? row.appId.trim() : null;
  return {
    // `enabled: false` 也是"配置过"：用户主动关掉了，不该再提示他去扫码。
    configured: appId !== null,
    appId,
    enabled: row.enabled !== false,
  };
}

/** 读 `<stateDir>/openclaw.json` 并投影成 Feishu 状态；文件缺失/损坏 = 未配置。 */
export function readFeishuConfigAt(configPath: string): FeishuConfigSnapshot {
  try {
    if (!existsSync(configPath)) return { configured: false, appId: null, enabled: false };
    return readFeishuConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  } catch {
    return { configured: false, appId: null, enabled: false };
  }
}

/**
 * 插件是否已在盘上（离线可用）。
 *
 * 落点按**实测**（2026-10-17，用随包 tgz 在临时 state 真装了一遍）：
 *   · `<stateDir>/extensions/feishu` —— `plugins install <tgz>` 的真实落点（`plugins list` 同口径）；
 *   · `<stateDir>/npm/projects/*feishu*` —— 早期 npm 安装的旧形状，保留兼容。
 * 读不出来 ⇒ `false`（宁少勿多：说"没装"最多让用户多点一次安装，
 * 说"装了"会让他在没网时撞墙）。
 */
export function hasFeishuPlugin(stateDir: string): boolean {
  try {
    if (existsSync(path.join(stateDir, 'extensions', 'feishu'))) return true;
    const projectsDir = path.join(stateDir, 'npm', 'projects');
    if (!existsSync(projectsDir)) return false;
    return readdirSync(projectsDir).some((name) => /feishu/i.test(name));
  } catch {
    return false;
  }
}

/**
 * **主进程静默安装随包插件**（2026-10-17 用户：「用户直接使用」）。
 *
 * 现场：旧流程把"复制/解压"放进终端脚本里，用户看到一屏命令、失败后窗口一闪就没了。
 * ⇒ 安装这一步不归用户看：点击「接入飞书」时先在这里装好，终端**只负责出二维码**。
 *
 * 落点与内核 `plugins list` 同口径：`<state>/extensions/feishu`，并补
 * `node_modules/openclaw` → 运行时 openclaw 包的**目录联接**（插件的 peer 依赖）。
 * 已装过 ⇒ 幂等跳过；随包目录不在 ⇒ 具名失败（调用方退回联网安装）。
 */
export async function installBundledFeishu(input: {
  bundledDir: string;
  stateDir: string;
  /** 运行时 `node_modules/openclaw` 的绝对路径（联接目标）。 */
  openclawPackageDir: string;
}): Promise<{ ok: true; copied: boolean } | { ok: false; reason: 'bundled-missing' | 'install-failed' }> {
  const destination = path.join(input.stateDir, 'extensions', 'feishu');
  try {
    if (existsSync(path.join(destination, 'package.json'))) return { ok: true, copied: false };
    if (!existsSync(path.join(input.bundledDir, 'package.json'))) return { ok: false, reason: 'bundled-missing' };
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(input.bundledDir, destination, { recursive: true, force: true });
    const link = path.join(destination, 'node_modules', 'openclaw');
    await mkdir(path.dirname(link), { recursive: true });
    if (!existsSync(link)) {
      try {
        await symlink(input.openclawPackageDir, link, 'junction');
      } catch {
        // 联接失败不在这里判死：插件可能自带依赖；真起不来时登录窗口会如实报错。
      }
    }
    if (!existsSync(path.join(destination, 'package.json'))) return { ok: false, reason: 'install-failed' };
    return { ok: true, copied: true };
  } catch {
    return { ok: false, reason: 'install-failed' };
  }
}

/**
 * 生成接入脚本（Windows **PowerShell**）。
 *
 * 为什么不是 `.cmd`（2026-10-17 实机）：cmd 用系统代码页（GBK）解析批处理，而文件是
 * UTF-8 —— 中文 `echo` 行被拆坏成 `'窗口会给出结果。' is not recognized`。
 * PowerShell 认 UTF-8 BOM，一步到位。
 *
 * 为什么不再 `plugins install <tgz>`：内核的 tar 解压在 Windows 上 **120 秒超时**
 * （现场两次 "Extracting …" 后 `extract tar timed out`）。实测：同一份包用系统解压
 * 不到 1 秒，且**直接放进 `<state>/extensions/feishu` 后 `plugins list` 就认得**。
 * ⇒ 随包直接发**已解压目录**，脚本只做复制 + 补一个 `node_modules/openclaw` 目录联接。
 *
 * 脚本只含路径，不含任何密钥（appSecret 由扫码流程自己写入）。
 */
export function buildFeishuBootstrapScript(input: {
  nodePath: string;
  cliPath: string;
  stateDir: string;
  /** 随包**已解压**插件目录（`resources/connectors/feishu`）。没有则退回联网安装。 */
  bundledPluginDir?: string | null;
  /** 主进程已经把插件装好了 ⇒ 终端只做扫码登录（不让用户看复制过程）。 */
  pluginAlreadyInstalled?: boolean;
  pluginVersion?: string;
}): string {
  const version = input.pluginVersion?.trim() || '2026.9.3';
  const q = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const parts: string[] = [
    `$ErrorActionPreference='Continue'`,
    `$Host.UI.RawUI.WindowTitle='Partner-W · 接入飞书'`,
    `$state=${q(input.stateDir)}`,
    `$node=${q(input.nodePath)}`,
    `$cli=${q(input.cliPath)}`,
    `$openclawDir=Split-Path $cli -Parent`,
    `Write-Host 'Partner-W · 接入飞书'`,
    `Write-Host '----------------------------------------------'`,
    `Write-Host '这个窗口会准备飞书插件并拉起扫码登录，请用手机飞书扫码。'`,
  ];
  if (input.pluginAlreadyInstalled) {
    parts.push(`Write-Host '[1/3] 飞书插件已就绪（随包自带，无需下载）。'`);
  } else if (input.bundledPluginDir) {
    const dst = `(Join-Path $state 'extensions\feishu')`;
    parts.push(
      `if(Test-Path (Join-Path ${dst} 'package.json')){Write-Host '[1/3] 飞书插件已在本机，跳过复制。'}else{` +
        `Write-Host '[1/3] 正在把随包飞书插件复制到本机（首次约几十秒）...';` +
        `New-Item -ItemType Directory -Force -Path ${dst}|Out-Null;` +
        `robocopy ${q(input.bundledPluginDir)} ${dst} /E /NFL /NDL /NJH /NJS /NP|Out-Null;` +
        `$nm=Join-Path ${dst} 'node_modules';` +
        `New-Item -ItemType Directory -Force -Path $nm|Out-Null;` +
        `$link=Join-Path $nm 'openclaw';` +
        `if(-not(Test-Path $link)){New-Item -ItemType Junction -Path $link -Target $openclawDir|Out-Null};` +
        `if(-not(Test-Path (Join-Path ${dst} 'package.json'))){Write-Host '插件复制失败：请重试或联系客服。' -ForegroundColor Red;Read-Host '按回车关闭';exit 1}` +
        `}`,
    );
  } else {
    parts.push(
      `Write-Host '[1/3] 正在联网安装飞书插件（约 51MB）...'`,
      `& $node $cli plugins install @openclaw/feishu@${version} --accept-capabilities --acknowledge-install-policy-warning`,
      `if($LASTEXITCODE -ne 0){Write-Host '插件安装失败：请检查网络后重试。' -ForegroundColor Red;Read-Host '按回车关闭';exit 1}`,
    );
  }
  parts.push(
    `Write-Host '[2/3] 正在拉起扫码登录...'`,
    `& $node $cli channels login --channel feishu`,
    // ⭐ 2026-10-18 实机：飞书消息能收到、却全部 `AgentSelectionRequiredError`
    //（多个助手但飞书没有归属）⇒ 扫码完成后必须把飞书**绑到主罗盘**。
    // `agents bind` 幂等：已绑定时返回 `skipped`、退出码 0（已实测）。
    `Write-Host '[3/3] 正在把飞书绑定到主罗盘...'`,
    `& $node $cli agents bind --agent main --bind feishu`,
    `Write-Host ''`,
    `Write-Host '完成或失败都会停在这里；回到魔方点「刷新状态」即可。'`,
    `Read-Host '按回车关闭'`,
  );
  return parts.join(';');
}

/** 随包资源子目录名（与 electron-builder.yml 的 `to:` 一字不差）。 */
export const FEISHU_PLUGIN_DIR_NAME = 'connectors';
/** 随包**已解压**插件目录名（位于 `resources/connectors/` 下）。 */
export const FEISHU_PLUGIN_PACKAGE_DIR = 'feishu';

/**
 * 「自带安装」的资源定位：打包态 `<resources>/connectors/feishu`，开发态
 * `<appPath>/resources/connectors/feishu`。目录不在 ⇒ `undefined`（退回联网安装）。
 */
export function resolveBundledPluginPath(opts: {
  isPackaged: boolean;
  resourcesPath?: string;
  appPath?: string;
}): string | undefined {
  const root = opts.isPackaged
    ? opts.resourcesPath && path.join(opts.resourcesPath, FEISHU_PLUGIN_DIR_NAME)
    : opts.appPath && path.join(opts.appPath, 'resources', FEISHU_PLUGIN_DIR_NAME);
  if (!root) return undefined;
  const dir = path.join(root, FEISHU_PLUGIN_PACKAGE_DIR);
  return existsSync(path.join(dir, 'package.json')) ? dir : undefined;
}

/** 脚本里的路径必须真的存在才值得把用户引到一个必然失败的窗口前。 */
export function assertBootstrapInputs(input: {
  nodePath: string;
  cliPath: string;
  stateDir: string;
}): { ok: true } | { ok: false; reason: 'runtime-missing' | 'state-missing' } {
  if (!existsSync(input.nodePath) || !existsSync(input.cliPath)) return { ok: false, reason: 'runtime-missing' };
  if (!existsSync(input.stateDir)) return { ok: false, reason: 'state-missing' };
  return { ok: true };
}
