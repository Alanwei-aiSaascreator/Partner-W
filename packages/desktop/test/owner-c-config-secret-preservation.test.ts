/**
 * Owner C / T16 —— 配置文件里的**凭据密文**解不开时先保留（RED→GREEN）。
 *
 * 合同依据：本轮 T16 硬红线「旧密文与身份**先保留**；**解不开不得无备份地删除**凭据」。
 *
 * ## 缺陷（修前）
 *
 * `workspace/config.ts` 的 `decryptField()` 在字段是 `enc:` 密文而当前作用域
 * **解不开**（换 Windows 用户 / 换机器 ⇒ DPAPI 作用域变了，或密文坏掉）时返回
 * `undefined`；`writeConfig()` 再把整份 config 序列化回盘 —— `JSON.stringify`
 * 丢掉 `undefined` 键 ⇒ **旧密文被抹掉**。
 *
 * 触发面极窄而常见：启动路径上 `updateConfig({ portableSetupPending: false })`、
 * `updateConfig({ workspaceId })`、`updateConfig({ workspacePath })` 任意一次落盘
 * 都会把网关卡里那份解不开的 token/password 冲掉。DPAPI 是按 Windows 用户加密的，
 * 用户切回原账户时它**本来解得开** —— 前提是它还在。
 *
 * ## 修法（语义）
 *
 * 「调用方**没给值**（`undefined`）」且「盘上那份是 `enc:` 且**当前解不开**」
 * ⇒ 原样带回旧密文，不落盘时抹掉。
 *
 * ⚠️ **显式值优先**：`''` 或新值都照写（用户清空/换 token 的意图不被吞）——
 *    只有"我们读不出来"才保留。
 *
 * ⚠️ 只在 mkdtemp 里建删文件，绝不触碰真实 `%APPDATA%`。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_FILE_NAME } from '@clawwork/shared';

const mocks = vi.hoisted(() => ({
  userDataDir: '',
  encryptionAvailable: true,
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => mocks.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(`ENC(${s})`, 'utf8'),
    // 严格（与真实 DPAPI 同形）：只认自己写的 `ENC(...)`，别的密文一律抛。
    decryptString: (b: Buffer) => {
      const match = /^ENC\(([\s\S]*)\)$/u.exec(b.toString('utf8'));
      if (!match) throw new Error('BAD_DECRYPT');
      return match[1];
    },
  },
}));

const { readConfig, updateConfig, writeConfig } = await import('../src/main/workspace/config.js');

/** 真机上"换 Windows 用户后解不开"的密文（不是本进程的 `ENC(...)` 包装）。 */
const FOREIGN_CIPHERTEXT = 'enc:Zm9yZWlnbi11c2VyLXRva2Vu';

let dir: string;

function configPath(): string {
  return join(dir, CONFIG_FILE_NAME);
}

function readRaw(): Record<string, unknown> {
  return JSON.parse(readFileSync(configPath(), 'utf8')) as Record<string, unknown>;
}

function seedConfig(raw: Record<string, unknown>): void {
  writeFileSync(configPath(), `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'owner-c-config-secret-'));
  mocks.userDataDir = dir;
  mocks.encryptionAvailable = true;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function rawWithEncryptedToken(tokenValue: string): Record<string, unknown> {
  return {
    workspacePath: 'C:\\ws',
    gateways: [{ id: 'gw-1', name: 'Local', url: 'ws://127.0.0.1:18789', token: tokenValue, authMode: 'token' }],
    defaultGatewayId: 'gw-1',
  };
}

describe('T16 · 配置里的凭据密文解不开 ⇒ 先保留', () => {
  it('⭐ 环境变化（加密不可用）：更新别的字段不得抹掉旧 token 密文', () => {
    seedConfig(rawWithEncryptedToken(FOREIGN_CIPHERTEXT));
    mocks.encryptionAvailable = false;

    // 启动路径上真实会发生的落盘
    updateConfig({ theme: 'dark' });

    const raw = readRaw();
    const gateways = raw.gateways as Array<Record<string, unknown>>;
    expect(gateways[0].token, '解不开的旧密文不许无备份消失').toBe(FOREIGN_CIPHERTEXT);
    expect(raw.theme, '本次要写的字段照常写入').toBe('dark');
  });

  it('⭐ 坏密文（密钥/dpapi 作用域变了、解一下抛）：同样保留', () => {
    seedConfig(rawWithEncryptedToken(FOREIGN_CIPHERTEXT));
    mocks.encryptionAvailable = true; // 可加密，但这份密文不是我们的

    updateConfig({ theme: 'light' });

    const gateways = readRaw().gateways as Array<Record<string, unknown>>;
    expect(gateways[0].token).toBe(FOREIGN_CIPHERTEXT);
  });

  it('⭐ 别的加密字段（bootstrapToken / password）同样保留', () => {
    seedConfig({ workspacePath: 'C:\\ws', gateways: [], bootstrapToken: FOREIGN_CIPHERTEXT, password: FOREIGN_CIPHERTEXT });
    mocks.encryptionAvailable = false;

    updateConfig({ theme: 'dark' });

    const raw = readRaw();
    expect(raw.bootstrapToken).toBe(FOREIGN_CIPHERTEXT);
    expect(raw.password).toBe(FOREIGN_CIPHERTEXT);
  });

  it('对照（用户意图优先）：显式给空串清空 token 仍然生效', () => {
    seedConfig(rawWithEncryptedToken(FOREIGN_CIPHERTEXT));
    mocks.encryptionAvailable = false;

    const current = readConfig();
    expect(current, '前置：配置要能读出来').toBeTruthy();
    updateConfig({
      gateways: [{ id: 'gw-1', name: 'Local', url: 'ws://127.0.0.1:18789', token: '', authMode: 'token' }],
    });

    const gateways = readRaw().gateways as Array<Record<string, unknown>>;
    expect(gateways[0].token, '显式空串 = 用户清空，不许复活').toBe('');
  });

  it('边界（如实记录）：整条网关被移除时，条目连同密文一起消失（不是"复活"）', () => {
    seedConfig(rawWithEncryptedToken(FOREIGN_CIPHERTEXT));
    mocks.encryptionAvailable = false;

    updateConfig({ gateways: [] });

    expect(readRaw().gateways).toEqual([]);
  });

  it('对照（无噪音）：解得开的 token 正常往返，不重复套一层 enc:', () => {
    mocks.encryptionAvailable = true;
    writeConfig({ workspacePath: 'C:\\ws', gateways: [{ id: 'gw-1', name: 'Local', url: 'u', token: 'plain-token', authMode: 'token' }] } as never);

    expect(readConfig()?.gateways[0].token, '解回来还是明文').toBe('plain-token');

    updateConfig({ theme: 'dark' });

    const gateways = readRaw().gateways as Array<Record<string, unknown>>;
    expect(String(gateways[0].token).startsWith('enc:')).toBe(true);
    expect(String(gateways[0].token).match(/enc:/g)?.length, '只有一层 enc:').toBe(1);
    expect(readConfig()?.gateways[0].token, '再读仍是同一把').toBe('plain-token');
  });

  it('对照：配置里根本解不开的字段，如果调用方给了新值 ⇒ 照写新值', () => {
    seedConfig(rawWithEncryptedToken(FOREIGN_CIPHERTEXT));
    mocks.encryptionAvailable = true;

    updateConfig({
      gateways: [{ id: 'gw-1', name: 'Local', url: 'u', token: 'brand-new-token', authMode: 'token' }],
    });

    expect(readConfig()?.gateways[0].token, '新 token 必须落地（重新认证后自动重连）').toBe('brand-new-token');
  });
});
