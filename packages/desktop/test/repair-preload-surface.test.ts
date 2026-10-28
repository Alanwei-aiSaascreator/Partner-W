import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * preload 是**唯一的桥**。这里用源码文本断言盯着「方法名 ↔ 通道名 ↔ 类型声明」三处不许漂
 * （与 `analytics-preload-surface.test.ts` / `growth-preload-surface.test.ts` 同款）。
 *
 * ⚠️ 为什么修复工具也要这一条：它跨两个入口（`--repair` 独立窗口 / 设置页嵌入），
 *    而两条入口都只能通过 `window.clawwork` 说话。名字漂了的表现是**面板一直转**
 *    （invoke 没人应答），而不是报错 —— 现场极难查。
 */
const preload = readFileSync(join(__dirname, '../src/preload/index.ts'), 'utf8');
const types = readFileSync(join(__dirname, '../src/preload/clawwork.d.ts'), 'utf8');
const handlers = readFileSync(join(__dirname, '../src/main/ipc/repair-handlers.ts'), 'utf8');
const entry = readFileSync(join(__dirname, '../src/main/entry.ts'), 'utf8');
const repairMain = readFileSync(join(__dirname, '../src/main/repair/main.ts'), 'utf8');

const SURFACE: ReadonlyArray<[method: string, channel: string]> = [
  ['repairBootstrap', 'repair:bootstrap'],
  ['repairScan', 'repair:scan'],
  ['repairApply', 'repair:apply'],
  ['repairReveal', 'repair:reveal'],
  ['repairRestore', 'repair:restore'],
];

describe('preload 暴露的修复接口（FEAT-03）', () => {
  it.each(SURFACE)('%s → %s（preload / 主进程 / 类型声明三处都在）', (method, channel) => {
    expect(preload).toContain(method);
    expect(preload).toContain(channel);
    expect(handlers).toContain(channel);
    expect(types).toContain(`${method}:`);
  });

  it('payload 原样透传给 IPC（渲染层不做二次加工）', () => {
    expect(preload).toMatch(/repairApply:[\s\S]{0,200}?invoke\(\s*'repair:apply',\s*[A-Za-z_$][\w$]*\s*\)/);
    expect(preload).toMatch(/repairReveal:[\s\S]{0,200}?invoke\(\s*'repair:reveal',\s*[A-Za-z_$][\w$]*\s*\)/);
  });

  it('引擎单真源：两条入口都走同一组通道，通道里没有入口分支', () => {
    // 主进程只注册这四条；`--repair` 窗口与设置页拿到的是同一个 session。
    expect(handlers).toMatch(/ipcMain\.handle\(\s*REPAIR_CHANNELS\.bootstrap/);
    expect(handlers).toMatch(/ipcMain\.handle\(\s*REPAIR_CHANNELS\.scan/);
    expect(handlers).toMatch(/ipcMain\.handle\(\s*REPAIR_CHANNELS\.apply/);
  });
});

describe('`--repair` 入口（SPEC 一·形态）', () => {
  it('复用同一个二进制的入口分派：`--repair` 走修复模式，**不**走正常启动', () => {
    expect(entry).toContain("process.argv.includes('--repair')");
    // 修复分支排在 `./index.js` 之前 —— 并且修复模式下不 import 它
    const repairIndex = entry.indexOf("import('./repair/main.js')");
    const normalIndex = entry.indexOf("import('./index.js')");
    expect(repairIndex).toBeGreaterThan(-1);
    expect(normalIndex).toBeGreaterThan(-1);
    expect(repairIndex).toBeLessThan(normalIndex);
  });

  it('⭐ 修复模块**动态** import（顶层静态会打挂别的测试的 electron mock）', () => {
    // 实测事故：静态 import 让 `slidegen-command-entry.test.ts` 的两条用例在 link 期
    // 报 `Named export 'BrowserWindow' not found`（它的 electron mock 只给了 app/session）。
    expect(entry).not.toMatch(/^\s*import\s+\{[^}]*\}\s+from\s+['"]\.\/repair\/main\.js['"]/m);
    expect(entry).toMatch(/await\s+import\(\s*'\.\/repair\/main\.js'\s*\)/);
  });

  it('修复模式不抢单实例锁、不起网关、不建托盘/快捷键/埋点', () => {
    expect(repairMain).toContain('runRepairMode');
    expect(repairMain).not.toContain('requestSingleInstanceLock');
    expect(repairMain).not.toContain('bootstrapLocalGatewayRuntime');
    expect(repairMain).not.toContain('initAllGateways');
    expect(repairMain).not.toContain('initTray');
    expect(repairMain).not.toContain('setupAnalytics');
    expect(repairMain).not.toContain("from '../index.js'");
  });

  it('修复模式的窗口只加载 repair.html', () => {
    expect(repairMain).toContain('/repair.html');
  });

  it('⭐ 设置页嵌入入口在**正常启动**里也注册了同一组通道（否则设置里那块一直转）', () => {
    const indexSource = readFileSync(join(__dirname, '../src/main/index.ts'), 'utf8');
    expect(indexSource).toContain('registerRepairHandlers(');
    expect(indexSource).toContain('createSessionForHost(');
    // 只读纪律：语言走 `readPersistedLanguage()`（纯读）—— 不用 `readConfig()`，
    // 后者在配置损坏时会**当场改名隔离**，那是一次没经用户确认的写动作。
    expect(indexSource).toMatch(/language:\s*readPersistedLanguage\(/);
  });
});
