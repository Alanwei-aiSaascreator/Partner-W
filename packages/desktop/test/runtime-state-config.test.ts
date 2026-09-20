import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GATEWAY_WS_PORT } from '@clawwork/shared';

/**
 * 状态目录配置 + 客户端 gateway 条目。
 *
 * ⚠️ **令牌漂移是最隐蔽的故障**：state 文件被清掉而客户端 config 里还留着旧 token
 * ⇒ WS 连上去 1008 ⇒ 界面上看着就是"网关没起来"，日志里只有一句 1008。
 * 所以三处（state 文件 / config / 进程 env）以 **state 文件为唯一真相源**。
 *
 * ⚠️ 会话安全：只在 mkdtemp 里建删文件，绝不触碰真实 `%APPDATA%`。
 */

const electronMock = vi.hoisted(() => {
  const state = { userData: '', encrypted: new Map<string, string>() };
  return {
    state,
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return state.userData;
      throw new Error(`unexpected app path: ${name}`);
    }),
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((value: string) => {
      const enc = Buffer.from(`enc(${value})`);
      state.encrypted.set(enc.toString('base64'), value);
      return enc;
    }),
    decryptString: vi.fn((buf: Buffer) => {
      const raw = buf.toString();
      return raw.startsWith('enc(') ? raw.slice(4, -1) : raw;
    }),
  };
});

vi.mock('electron', () => ({
  app: { getPath: electronMock.getPath },
  safeStorage: {
    isEncryptionAvailable: electronMock.isEncryptionAvailable,
    encryptString: electronMock.encryptString,
    decryptString: electronMock.decryptString,
  },
}));

import { CONFIG_FILE_NAME } from '@clawwork/shared';
import {
  LOCAL_GATEWAY_ID,
  STATE_CONFIG_FILE,
  STATE_DIR_NAME,
  ensureClientGatewayEntry,
  ensureStateConfig,
  minimalGatewayConfig,
  stateConfigPath,
  stateDirFor,
} from '../src/main/runtime/state-config.js';

let tmpRoot: string;
let userDataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-state-'));
  userDataDir = path.join(tmpRoot, 'userdata');
  fs.mkdirSync(userDataDir, { recursive: true });
  electronMock.state.userData = userDataDir;
  electronMock.state.encrypted.clear();
});

afterEach(() => {
  if (tmpRoot && tmpRoot.includes(path.join(os.tmpdir(), 'clawwork-state-'))) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const configPath = (): string => path.join(userDataDir, CONFIG_FILE_NAME);
const readConfigRaw = (): Record<string, unknown> => JSON.parse(fs.readFileSync(configPath(), 'utf-8'));

describe('minimalGatewayConfig', () => {
  it('⭐ 只写 gateway.auth，**不写** gateway.mode / gateway.port', () => {
    const cfg = minimalGatewayConfig('tok-123');
    expect(cfg).toEqual({ gateway: { auth: { mode: 'token', token: 'tok-123' } } });

    // 不写 mode 正是 `--allow-unconfigured` 必需的原因；port 归 `--port` 参数
    expect(Object.keys(cfg.gateway)).toEqual(['auth']);
  });
});

describe('ensureStateConfig', () => {
  it('首跑：建 openclaw.json，token 是 32 字节的 base64url', () => {
    const res = ensureStateConfig(userDataDir);

    expect(res.created).toBe(true);
    expect(fs.existsSync(stateConfigPath(stateDirFor(userDataDir)))).toBe(true);

    const raw = JSON.parse(fs.readFileSync(res.configPath, 'utf-8'));
    expect(raw).toEqual({
      gateway: { auth: { mode: 'token', token: res.token } },
      memory: { search: { provider: 'none' } },
      tools: { deny: ['memory_search', 'memory_get'] },
    });
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 字节 → 43 个 base64url 字符
  });

  it('⭐ 二跑：**沿用同一个 token**，不重新生成（否则线上所有客户端立刻掉线）', () => {
    const first = ensureStateConfig(userDataDir);
    const second = ensureStateConfig(userDataDir);

    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it('⭐ 已有配置里的其它字段被尊重（openclaw 自己也会往这个目录写东西）', () => {
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      stateConfigPath(stateDir),
      JSON.stringify({ gateway: { auth: { mode: 'token', token: 'existing-token' }, logLevel: 'debug' }, other: 1 }),
    );

    const res = ensureStateConfig(userDataDir);
    expect(res.token).toBe('existing-token');

    const raw = JSON.parse(fs.readFileSync(res.configPath, 'utf-8'));
    expect(raw.other).toBe(1);
    expect(raw.gateway.logLevel).toBe('debug');
  });

  it('⭐ 显式选 FTS-only（memory.search.provider="none"）—— 否则 memory_search 卡 15 秒再失败', () => {
    // 现场（2026-09-18，用户机器）：模型调 `memory_search` ⇒ 整整 15.0 秒 ⇒ error ⇒
    // 再接着调别的工具（ls / ask_user 都正常）。根因：`memory.search.provider` 默认
    // **openai**，而我们从不出嵌入凭据 ⇒ 每次调用都去够 OpenAI 直到超时；
    // openclaw 文档写明"显式远端 provider 不可达时 fail closed"。
    // `provider: "none"` 是有意的本地全文检索模式：recall 仍可用、不出网、不需要凭据。
    // 将来 T6b 接上自己的嵌入通道时，把这里改成对应 provider 即可。
    const res = ensureStateConfig(userDataDir);

    const raw = JSON.parse(fs.readFileSync(res.configPath, 'utf-8'));
    expect(raw.memory?.search?.provider).toBe('none');
  });

  it('老配置（没有 memory 段）⇒ 补上这条默认；用户/将来版本设过的 provider 不覆盖', () => {
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    // ① 老配置：只有 gateway ⇒ 补齐
    fs.writeFileSync(stateConfigPath(stateDir), JSON.stringify({ gateway: { logLevel: 'debug' } }));
    ensureStateConfig(userDataDir);
    let raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.memory.search.provider).toBe('none');
    expect(raw.gateway.logLevel).toBe('debug');

    // ② 已经设过（将来接了嵌入通道会写成别的）⇒ 一个字都不改
    fs.writeFileSync(
      stateConfigPath(stateDir),
      JSON.stringify({
        gateway: { auth: { mode: 'token', token: 't' } },
        memory: { search: { provider: 'local', model: 'bge-small-zh-v1.5' } },
      }),
    );
    ensureStateConfig(userDataDir);
    raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.memory.search).toEqual({ provider: 'local', model: 'bge-small-zh-v1.5' });
  });

  it('⭐ 存量用户（token 本来就对）也必须补上 memory 默认值 —— 提前返回不能只看 token', () => {
    // 这条是这次修复最容易被写漏的地方：`ensureStateConfig` 里"已经一致就一个字节都不写"
    // 那条提前返回，**存量用户每次启动都从它出去**（他们的 token 本来就是对的）。
    // 只在"新建"路径上补默认值 ⇒ 对用户那台机器完全无效 —— 症状原样还在。
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    // 先建一次，拿到"正确的" token（模拟用户机器上早就存在的状态文件）
    const first = ensureStateConfig(userDataDir);

    // 再把 memory 段摘掉，模拟修复前写下的那份文件（token 是对的、没有 memory 段）
    const cfg = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    delete cfg.memory;
    fs.writeFileSync(stateConfigPath(stateDir), JSON.stringify(cfg));

    const res = ensureStateConfig(userDataDir);

    expect(res.token).toBe(first.token); // token 一个字节没动
    const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.memory.search.provider).toBe('none');
  });

  it('已有配置但**没有** token ⇒ 补一个，但不覆盖别的字段', () => {
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateConfigPath(stateDir), JSON.stringify({ gateway: { logLevel: 'debug' } }));

    const res = ensureStateConfig(userDataDir);
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const raw = JSON.parse(fs.readFileSync(res.configPath, 'utf-8'));
    expect(raw.gateway.auth).toEqual({ mode: 'token', token: res.token });
    expect(raw.gateway.logLevel).toBe('debug');
  });

  it('配置文件是半截 JSON（掉电）⇒ 当成"没有"，重建而不是崩', () => {
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(stateConfigPath(stateDir), '{ "gateway": { "auth"');

    const res = ensureStateConfig(userDataDir);
    expect(res.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => JSON.parse(fs.readFileSync(res.configPath, 'utf-8'))).not.toThrow();
  });

  it('state 目录名固定在 <userData>/openclaw-state（不是随手一个临时目录）', () => {
    expect(stateDirFor(userDataDir)).toBe(path.join(userDataDir, STATE_DIR_NAME));
    expect(STATE_CONFIG_FILE).toBe('openclaw.json');
  });
});

describe('tools.deny —— 摘掉那两个会必然失败的 memory 工具', () => {
  /**
   * 为什么摘：模型每轮都可能调 `memory_search`，而在 `provider: "none"` 下
   * `corpus=sessions` **必然失败**（`Session transcript search is not enabled.`）。
   * 用户原话（2026-09-20）：「我不希望每次对话就有这个报错，用户会认为卡了」。
   *
   * ⚠️ **两个都要摘**：只摘 `memory_search` 的话，记忆提示段会换成 `memory_get` 版本，
   *    "强制回忆"的指令还在（`memory-tool-contract-*.mjs` 的 `hasMemoryGet` 分支）。
   * ⚠️ **不用** `memory.search.enabled: false`：那会**静默关掉 "## Project Memory" 注入**，
   *    是个看不见的损失。
   */
  it('⭐ 首跑就带上：两个名字都在，且不多不少', () => {
    const res = ensureStateConfig(userDataDir);
    const raw = JSON.parse(fs.readFileSync(res.configPath, 'utf-8'));

    expect(raw.tools.deny).toEqual(['memory_search', 'memory_get']);
  });

  it('⭐ 存量用户（token 与 memory 段都早就对了）也必须补上 —— 提前返回不能漏了它', () => {
    // 与 memory 那条同源的坑：`ensureStateConfig` 的提前返回是**存量用户每次启动的必经之路**。
    // 守卫里只加 `tools` 这一项，否则用户那台机器上这个报错原样还在。
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    const first = ensureStateConfig(userDataDir);

    // 摘掉 tools 段，模拟"这一版修复之前写下的文件"（token 对、memory 也设过）
    const cfg = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    delete cfg.tools;
    fs.writeFileSync(stateConfigPath(stateDir), JSON.stringify(cfg));

    const res = ensureStateConfig(userDataDir);

    expect(res.token).toBe(first.token);
    const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.tools.deny).toEqual(['memory_search', 'memory_get']);
  });

  it('用户/将来版本已经设过别的 deny ⇒ 并集，不动他原有的项', () => {
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      stateConfigPath(stateDir),
      JSON.stringify({
        gateway: { auth: { mode: 'token', token: 'existing-token' } },
        memory: { search: { provider: 'none' } },
        tools: { deny: ['some_other_tool'] },
      }),
    );

    ensureStateConfig(userDataDir);

    const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.tools.deny).toContain('some_other_tool');
    expect(raw.tools.deny).toContain('memory_search');
    expect(raw.tools.deny).toContain('memory_get');
  });

  it('⭐ 查重：已经有 `memory_search` 时补 `memory_get`，**不能把它追加成两条**', () => {
    // ⚠️ 这条**必须**从"只 deny 了一个"起步。若从空配置起步，第一次跑完就满足了
    //    `hasMemoryToolsDenied` ⇒ 后续启动走**提前返回**，根本到不了查重那一行 ——
    //    那样测的其实是提前返回（变异验证实测：去掉 `new Set` 照样全绿）。
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      stateConfigPath(stateDir),
      JSON.stringify({
        gateway: { auth: { mode: 'token', token: 'existing-token' } },
        memory: { search: { provider: 'none' } },
        tools: { deny: ['memory_search'] },
      }),
    );

    ensureStateConfig(userDataDir);
    ensureStateConfig(userDataDir);

    const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.tools.deny).toEqual(['memory_search', 'memory_get']);
    expect(raw.tools.deny.filter((n: string) => n === 'memory_search')).toHaveLength(1);
  });
});

describe('ensureClientGatewayEntry', () => {
  it('⭐ 首次：config 里恰好一条 gateway，id 稳定、url 指向本机端口', async () => {
    const res = await ensureClientGatewayEntry({ userDataDir });

    const cfg = readConfigRaw();
    const gateways = cfg.gateways as Array<Record<string, unknown>>;
    expect(gateways).toHaveLength(1);
    expect(gateways[0].id).toBe(LOCAL_GATEWAY_ID);
    expect(gateways[0].url).toBe(`ws://127.0.0.1:${GATEWAY_WS_PORT}`);
    expect(gateways[0].authMode).toBe('token');
    expect(cfg.defaultGatewayId).toBe(LOCAL_GATEWAY_ID);
    expect(res.changed).toBe(true);
  });

  it('⭐ 落盘的 token 是 `enc:` 密文（走 writeConfig 就自动加密，别绕过它）', async () => {
    const res = await ensureClientGatewayEntry({ userDataDir });
    const raw = fs.readFileSync(configPath(), 'utf-8');

    expect(raw).toContain('enc:');
    // ⚠️ 明文绝不能落盘 —— 这里比的必须是**解析出来的** token。
    //    （早先写成 `res.token` 而 res 是 Promise ⇒ 实际在断言 `not.toContain(undefined)`，
    //     永远通过、什么也没验到。tsc 把它抓出来了。）
    expect(res.token.length).toBeGreaterThan(20);
    expect(raw).not.toContain(res.token);
  });

  it('⭐ 二跑幂等：**不新增第二条**网关，token 也不变', async () => {
    const first = await ensureClientGatewayEntry({ userDataDir });
    const second = await ensureClientGatewayEntry({ userDataDir });

    expect(second.token).toBe(first.token);
    expect(second.changed).toBe(false);
    expect(readConfigRaw().gateways).toHaveLength(1);
  });

  it('⭐ 令牌漂移：**客户端 config** 与 store 不一致 ⇒ 以 store 为准改写 + 报告漂移', async () => {
    const first = await ensureClientGatewayEntry({ userDataDir });

    // 绕过对齐，直接往 config 里塞一个旧 token
    const raw = readConfigRaw();
    (raw.gateways as Array<Record<string, unknown>>)[0].token = 'stale-token';
    fs.writeFileSync(configPath(), JSON.stringify(raw));

    const res = await ensureClientGatewayEntry({ userDataDir });

    expect(res.drifted).toBe(true);
    expect(res.changed).toBe(true);
    expect(res.token).toBe(first.token); // ⭐ store 胜出，不是 stale-token
    expect(readConfigRaw().gateways).toHaveLength(1);
  });

  it('⭐ state 文件里的 token 被改掉 ⇒ 以 store 为准**改写回来**，token 不漂移', async () => {
    const first = await ensureClientGatewayEntry({ userDataDir });

    const stateDir = stateDirFor(userDataDir);
    const stateCfg = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    stateCfg.gateway.auth.token = 'brand-new-token';
    fs.writeFileSync(stateConfigPath(stateDir), JSON.stringify(stateCfg));

    const res = await ensureClientGatewayEntry({ userDataDir });
    const onDisk = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));

    expect(res.token).toBe(first.token);
    expect(res.token).not.toBe('brand-new-token');
    expect(onDisk.gateway.auth.token).toBe(first.token);
  });

  it('⭐ 配置文件被整个删掉（openclaw 搬走/被别人清掉）⇒ **不重新生成**，照用 store 那个', async () => {
    const first = await ensureClientGatewayEntry({ userDataDir });
    fs.rmSync(stateConfigPath(stateDirFor(userDataDir)));

    const res = await ensureClientGatewayEntry({ userDataDir });
    const rewritten = JSON.parse(fs.readFileSync(stateConfigPath(stateDirFor(userDataDir)), 'utf-8'));

    expect(res.token).toBe(first.token); // 这就是 E2E 启动 2 的精确回归
    expect(rewritten.gateway.auth.token).toBe(first.token);
  });

  it('⭐ 整个 state 目录被清空 ⇒ 仍然用同一个 token 重新 bootstrap（不换 token）', async () => {
    const first = await ensureClientGatewayEntry({ userDataDir });
    fs.rmSync(stateDirFor(userDataDir), { recursive: true, force: true });

    const res = await ensureClientGatewayEntry({ userDataDir });

    expect(res.token).toBe(first.token);
    expect(fs.existsSync(stateConfigPath(stateDirFor(userDataDir)))).toBe(true);
  });

  it('⭐ 清理 0.0.25 向导写下的空令牌本机伪网关，并恢复真正的 local-runtime 为默认', async () => {
    const { writeConfig } = await import('../src/main/workspace/config.js');
    writeConfig({
      workspacePath: '/w',
      gateways: [
        {
          id: 'legacy-setup-gateway',
          name: 'Default Gateway',
          url: 'ws://127.0.0.1:' + GATEWAY_WS_PORT,
          authMode: 'token',
          isDefault: true,
        },
      ],
      defaultGatewayId: 'legacy-setup-gateway',
    });

    const result = await ensureClientGatewayEntry({ userDataDir });

    const config = readConfigRaw();
    const gateways = config.gateways as Array<Record<string, unknown>>;
    expect(result.changed).toBe(true);
    expect(gateways).toHaveLength(1);
    expect(gateways[0].id).toBe(LOCAL_GATEWAY_ID);
    expect(gateways[0].isDefault).toBe(true);
    expect(config.defaultGatewayId).toBe(LOCAL_GATEWAY_ID);
  });

  it('用户自己配的其它网关**原封不动**（我们只 upsert 自己那一条）', async () => {
    const { writeConfig } = await import('../src/main/workspace/config.js');
    writeConfig({
      workspacePath: '/w',
      gateways: [{ id: 'user-gateway', name: 'Mine', url: 'ws://192.168.1.9:18789' }],
    });

    await ensureClientGatewayEntry({ userDataDir });

    const gateways = readConfigRaw().gateways as Array<Record<string, unknown>>;
    expect(gateways).toHaveLength(2);
    expect(gateways.map((g) => g.id)).toContain('user-gateway');
    expect(gateways.map((g) => g.id)).toContain(LOCAL_GATEWAY_ID);
  });

  it('状态目录写在 <userData>/openclaw-state（media/resolve 读的就是它）', async () => {
    await ensureClientGatewayEntry({ userDataDir });
    expect(fs.existsSync(path.join(userDataDir, STATE_DIR_NAME, STATE_CONFIG_FILE))).toBe(true);
  });
});
