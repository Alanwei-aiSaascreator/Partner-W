import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => 'unused-profile'), getVersion: vi.fn(() => '0.0.0') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}));

const {
  isLocalGatewayShuttingDown,
  shutdownLocalGatewayRuntime,
  stopLocalGatewayForMaintenance,
} = await import('../src/main/runtime/index.js');

/**
 * 维护性停机 vs 退出停机（2026-10-19 BUG-171 自审）。
 *
 * `restartLocalGatewayRuntime()` 见到"正在退出"哨兵会直接返回 null。安装飞书插件前
 * 需要先停网关，如果照搬退出用的 `shutdownLocalGatewayRuntime()`，网关就再也起不来。
 * 这组钉住：退出停机置位；维护性停机清位。
 */
describe('stopLocalGatewayForMaintenance', () => {
  it('⭐ 退出停机置位哨兵；维护性停机清位（否则后续 restart 是空操作）', async () => {
    await shutdownLocalGatewayRuntime();
    expect(isLocalGatewayShuttingDown()).toBe(true);

    await stopLocalGatewayForMaintenance();
    expect(isLocalGatewayShuttingDown()).toBe(false);
  });

  /**
   * ⭐ 2026-10-19 r52 实测：维护停机后若 reset 监督者，正在退出的网关会被
   * **2 秒后重新拉起**（日志 `gateway-supervisor-respawn attempt:1 delayMs:2000`），
   * 装机 CLI 随即报 `config changed since last load`。
   * 监督者只能由真正要拉起网关的 restart 路径 reset。
   */
  it('⭐ 维护停机不许 reset 监督者（源码契约）', async () => {
    const { readFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const here = dirname(fileURLToPath(import.meta.url));
    const source = readFileSync(join(here, '..', 'src', 'main', 'runtime', 'index.ts'), 'utf8');
    const start = source.indexOf('export async function stopLocalGatewayForMaintenance');
    const end = source.indexOf('export async function shutdownLocalGatewayRuntime');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    // 只看可执行语句（注释里允许解释为什么不能 reset）。
    expect(source.slice(start, end)).not.toMatch(/^\s*gatewaySupervisor\?\.reset\(\);/mu);
  });
});
