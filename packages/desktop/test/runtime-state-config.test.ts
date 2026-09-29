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
 * 所以三处（store / state 镜像 / 客户端 config）以 **U 盘 token store 为唯一真相源**。
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

/**
 * `writeJsonAtomic` 的探针：用来钉住"已经一致 ⇒ **一个字节都不写**"这条契约。
 *
 * ⚠️ 工厂必须**代理真实现**（`...actual` + 委托）：这个模块也被 `updateConfig` 用，
 *    换掉真实现会把别的用例静默改掉。
 * ⚠️ 用它的那条用例必须**先证明钉子活着**（第一跑断言调用次数），否则"第二跑没写"
 *    在探针失效时会**恒真**。
 */
const jsonFileMock = vi.hoisted(() => ({
  writeJsonAtomic: vi.fn<(target: string, value: unknown) => void>(),
}));

vi.mock('../src/main/util/json-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/util/json-file.js')>();
  jsonFileMock.writeJsonAtomic.mockImplementation(actual.writeJsonAtomic);
  return { ...actual, writeJsonAtomic: jsonFileMock.writeJsonAtomic };
});

import { CONFIG_FILE_NAME } from '@clawwork/shared';
import {
  LOCAL_GATEWAY_ID,
  hasMemoryToolsDenied,
  hasStaleExecKeys,
  hasToolGuard,
  readMemorySearchProvider,
  STATE_CONFIG_FILE,
  STATE_DIR_NAME,
  ensureClientGatewayEntry,
  ensureStateConfig,
  minimalGatewayConfig,
  portableStateDirFor,
  stateConfigPath,
  stateDirFor,
} from '../src/main/runtime/state-config.js';
import { authStorePath } from '../src/main/runtime/token-store.js';

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
  it('keeps portable state token-scoped when state and app data share the portable root', () => {
    const result = ensureStateConfig(userDataDir, userDataDir, path.join(tmpRoot, 'workspace'));

    expect(result.stateDir).toBe(portableStateDirFor(userDataDir, result.token));
    expect(fs.existsSync(stateDirFor(userDataDir))).toBe(false);
  });

  it('首跑：建 openclaw.json，token 是 32 字节的 base64url', () => {
    const res = ensureStateConfig(userDataDir);

    expect(res.created).toBe(true);
    expect(fs.existsSync(stateConfigPath(stateDirFor(userDataDir)))).toBe(true);

    const raw = JSON.parse(fs.readFileSync(res.configPath, 'utf-8'));
    expect(raw).toEqual({
      gateway: { auth: { mode: 'token', token: res.token } },
      memory: { search: { provider: 'none' } },
      tools: {
        deny: ['memory_search', 'memory_get'],
        fs: { workspaceOnly: true },
        exec: { mode: 'ask' },
        elevated: { enabled: false },
      },
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

describe('红线：工具闸门（写不出工作区 + 工作区外先问）', () => {
  /**
   * 用户 2026-09-22 拍的红线：中间产物落工作区/临时目录，绝不落桌面；外面写必须先问。
   * 运行时的三个闸门在 2026.9.3 实测**默认都不设防**：
   *   - tools.fs.workspaceOnly 默认 false（且它是 FsToolsConfig 的唯一子键，读写一起锁）
   *   - tools.exec 默认 security:"full" + ask:"off"（等于无审批）
   *   - tools.elevated 未关
   */
  it('首跑就带上三个闸门，且不写 legacy security/ask', () => {
    const res = ensureStateConfig(userDataDir);
    const raw = JSON.parse(fs.readFileSync(res.configPath, 'utf-8'));

    expect(raw.tools.fs).toEqual({ workspaceOnly: true });
    expect(raw.tools.exec).toEqual({ mode: 'ask' });
    expect(raw.tools.elevated).toEqual({ enabled: false });
  });

  it('⭐ 存量用户（token/memory/deny 都早就对了）也必须补上 —— 提前返回不能漏了它', () => {
    // 与 memory / deny 那两条同源的坑：这条提前返回是**存量用户每次启动的必经之路**。
    // 判据里漏了闸门 ⇒ token 本来就对的用户（包括用户那块 U 盘）**永远拿不到**。
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    const first = ensureStateConfig(userDataDir);

    // 模拟"这一版修复之前写下的文件"：token 对、memory 与 deny 都设过，但没有闸门
    const cfg = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    delete cfg.tools.fs;
    delete cfg.tools.exec;
    delete cfg.tools.elevated;
    fs.writeFileSync(stateConfigPath(stateDir), JSON.stringify(cfg));

    ensureStateConfig(userDataDir);

    const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.gateway.auth.token).toBe(first.token); // token 不许漂
    expect(raw.tools.fs).toEqual({ workspaceOnly: true });
    expect(raw.tools.exec.mode).toBe('ask');
    expect(raw.tools.elevated.enabled).toBe(false);
  });

  it('用户自己的其它 tools/exec 键不被覆盖', () => {
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      stateConfigPath(stateDir),
      JSON.stringify({
        gateway: { auth: { mode: 'token', token: 'existing-token' } },
        memory: { search: { provider: 'none' } },
        tools: {
          deny: ['some_other_tool', 'memory_search', 'memory_get'],
          profile: 'coding',
          exec: { strictInlineEval: true },
        },
      }),
    );

    ensureStateConfig(userDataDir);

    const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.tools.deny).toContain('some_other_tool');
    expect(raw.tools.profile).toBe('coding');
    expect(raw.tools.exec.strictInlineEval).toBe(true);
    expect(raw.tools.exec.mode).toBe('ask');
  });

  it('用户显式设过 false/"full" ⇒ 被改回红线值（always-ensure，不是 only-fill）', () => {
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      stateConfigPath(stateDir),
      JSON.stringify({
        gateway: { auth: { mode: 'token', token: 'existing-token' } },
        memory: { search: { provider: 'none' } },
        tools: {
          deny: ['memory_search', 'memory_get'],
          fs: { workspaceOnly: false },
          exec: { mode: 'full' },
          elevated: { enabled: true },
        },
      }),
    );

    ensureStateConfig(userDataDir);

    const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.tools.fs.workspaceOnly).toBe(true);
    expect(raw.tools.exec.mode).toBe('ask');
    expect(raw.tools.elevated.enabled).toBe(false);
  });

  it('已有 legacy security/ask ⇒ 写 mode 时移除它们（混合策略会被运行时拒绝）', () => {
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      stateConfigPath(stateDir),
      JSON.stringify({
        gateway: { auth: { mode: 'token', token: 'existing-token' } },
        memory: { search: { provider: 'none' } },
        tools: {
          deny: ['memory_search', 'memory_get'],
          exec: { security: 'full', ask: 'off', strictInlineEval: true },
        },
      }),
    );

    ensureStateConfig(userDataDir);

    const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.tools.exec).toEqual({ strictInlineEval: true, mode: 'ask' });
    expect(raw.tools.exec.security).toBeUndefined();
    expect(raw.tools.exec.ask).toBeUndefined();
  });

  it('文件里带着运行时**不认的** askFallback ⇒ 跑一次就清掉（提前返回不能把它锁死）', () => {
    // 实测：`tools.exec.askFallback` 不在 openclaw.json 的 schema 里 ⇒ 整份配置被判非法、网关起不来。
    // 若提前返回只看三个闸门的值，带着这个键的文件会**永远**走提前返回 ⇒ 自愈路径被堵死。
    const stateDir = stateDirFor(userDataDir);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      stateConfigPath(stateDir),
      JSON.stringify({
        gateway: { auth: { mode: 'token', token: 'existing-token' } },
        memory: { search: { provider: 'none' } },
        tools: {
          deny: ['memory_search', 'memory_get'],
          fs: { workspaceOnly: true },
          exec: { mode: 'ask', askFallback: 'deny' },
          elevated: { enabled: false },
        },
      }),
    );

    ensureStateConfig(userDataDir);

    const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
    expect(raw.tools.exec.askFallback).toBeUndefined();
    expect(raw.tools.exec.mode).toBe('ask');
  });

  it('幂等：第二跑对这份文件**一次写盘都没有**（字节相同区分不了"提前返回"与"每次重写"）', () => {
    // ⚠️ 这条的钉子是**写盘调用**，不是字节：把合并重算一遍会得到逐字节相同的文件，
    //    所以"字节不变"在"每次都重写"的世界里同样成立（复核者实测过：重建后的字节与磁盘相同），
    //    而 `created === false` 只看文件在不在盘上、恒为真。
    const writesTo = (target: string): number =>
      jsonFileMock.writeJsonAtomic.mock.calls.filter(([p]) => p === target).length;

    jsonFileMock.writeJsonAtomic.mockClear();
    const first = ensureStateConfig(userDataDir);
    expect(writesTo(first.configPath)).toBe(1); // ← 先证明钉子活着（否则下面那条恒真）

    const bytes = fs.readFileSync(first.configPath, 'utf-8');
    const afterFirst = JSON.parse(bytes);
    // 诊断：四个谓词各自是什么读数（提前返回要**全真**才成立）
    expect({
      memoryProvider: readMemorySearchProvider(afterFirst) !== null,
      deny: hasMemoryToolsDenied(afterFirst),
      guard: hasToolGuard(afterFirst),
      noStale: !hasStaleExecKeys(afterFirst),
    }).toEqual({ memoryProvider: true, deny: true, guard: true, noStale: true });
    // ⚠️ 计数是累积的：第二跑之前**必须**清一次，否则读到的还是第一跑那次写盘
    //    （第一版就是这么读错的：把"1"当成了"第二跑也写了"）。
    jsonFileMock.writeJsonAtomic.mockClear();
    const second = ensureStateConfig(userDataDir);

    expect(second.created).toBe(false);
    expect(writesTo(first.configPath)).toBe(0);
    expect(fs.readFileSync(first.configPath, 'utf-8')).toBe(bytes);
  });
});

describe('portable heartbeat defaults', () => {
  it('disables an unconfigured portable heartbeat using the runtime-supported cadence', () => {
    const stateRoot = path.join(tmpRoot, 'heartbeat-state');
    const first = ensureStateConfig(userDataDir, stateRoot);
    const config = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
    expect(config.agents.defaults.heartbeat).toEqual({ every: '0m' });
    const bytes = fs.readFileSync(first.configPath, 'utf8');
    ensureStateConfig(userDataDir, stateRoot);
    expect(fs.readFileSync(first.configPath, 'utf8')).toBe(bytes);
  });

  it('repairs legacy owner-only heartbeat defaults while retaining the owner', () => {
    const stateRoot = path.join(tmpRoot, 'heartbeat-state');
    const first = ensureStateConfig(userDataDir, stateRoot);
    const config = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
    config.agents.defaults.heartbeat = { agentId: 'main' };
    fs.writeFileSync(first.configPath, JSON.stringify(config));
    ensureStateConfig(userDataDir, stateRoot);
    expect(JSON.parse(fs.readFileSync(first.configPath, 'utf8')).agents.defaults.heartbeat).toEqual({
      agentId: 'main',
      every: '0m',
    });
  });

  it.each([
    { every: '45m' },
    { target: 'last' },
    { to: 'owner-channel' },
    { activeHours: { start: '09:00', end: '18:00' } },
    { prompt: 'Check scheduled work.' },
    { model: 'clawrouter/custom' },
    { session: 'agent:main:custom' },
    { lightContext: false },
  ])('preserves explicit heartbeat configuration %j', (heartbeat) => {
    const stateRoot = path.join(tmpRoot, 'heartbeat-state');
    const first = ensureStateConfig(userDataDir, stateRoot);
    const config = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
    config.agents.defaults.heartbeat = heartbeat;
    fs.writeFileSync(first.configPath, JSON.stringify(config));
    ensureStateConfig(userDataDir, stateRoot);
    expect(JSON.parse(fs.readFileSync(first.configPath, 'utf8')).agents.defaults.heartbeat).toEqual(heartbeat);
  });

  it('does not disable a gateway with configured delivery channels', () => {
    const stateRoot = path.join(tmpRoot, 'heartbeat-state');
    const first = ensureStateConfig(userDataDir, stateRoot);
    const config = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
    config.agents.defaults.heartbeat = { agentId: 'main' };
    config.channels = { telegram: { enabled: true } };
    fs.writeFileSync(first.configPath, JSON.stringify(config));
    ensureStateConfig(userDataDir, stateRoot);
    expect(JSON.parse(fs.readFileSync(first.configPath, 'utf8')).agents.defaults.heartbeat).toEqual({
      agentId: 'main',
    });
  });

  it.each(['entries', 'list'])('preserves explicit per-agent heartbeat settings under %s', (shape) => {
    const stateRoot = path.join(tmpRoot, 'heartbeat-state');
    const first = ensureStateConfig(userDataDir, stateRoot);
    const config = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
    config.agents.defaults.heartbeat = { agentId: 'main' };
    const worker = { id: 'worker', heartbeat: { target: 'last' } };
    config.agents[shape] = shape === 'list' ? [worker] : { worker };
    fs.writeFileSync(first.configPath, JSON.stringify(config));
    ensureStateConfig(userDataDir, stateRoot);
    expect(JSON.parse(fs.readFileSync(first.configPath, 'utf8')).agents.defaults.heartbeat).toEqual({
      agentId: 'main',
    });
  });

  it.each(['entries', 'list'])('preserves explicit per-agent default-cadence enrollment under %s', (shape) => {
    const stateRoot = path.join(tmpRoot, 'heartbeat-state');
    const first = ensureStateConfig(userDataDir, stateRoot);
    const config = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
    config.agents.defaults.heartbeat = { agentId: 'main' };
    const worker = { id: 'worker', heartbeat: {} };
    config.agents[shape] = shape === 'list' ? [worker] : { worker };
    fs.writeFileSync(first.configPath, JSON.stringify(config));
    ensureStateConfig(userDataDir, stateRoot);
    const rewritten = JSON.parse(fs.readFileSync(first.configPath, 'utf8'));
    expect(rewritten.agents.defaults.heartbeat).toEqual({ agentId: 'main' });
    expect(shape === 'list' ? rewritten.agents.list[0].heartbeat : rewritten.agents.entries.worker.heartbeat).toEqual(
      {},
    );
  });

  it('does not change installed-mode heartbeat defaults', () => {
    const result = ensureStateConfig(userDataDir);
    const config = JSON.parse(fs.readFileSync(result.configPath, 'utf8'));
    expect(config.agents?.defaults?.heartbeat).toBeUndefined();
  });
});

describe('ensureClientGatewayEntry', () => {
  it.runIf(process.platform === 'win32')(
    'migrates the matching legacy token tree before creating portable config',
    async () => {
      const localData = path.join(tmpRoot, 'legacy-local');
      const legacy = ensureStateConfig(userDataDir, localData, path.join(tmpRoot, 'workspace'));
      fs.mkdirSync(path.join(legacy.stateDir, 'state'), { recursive: true });
      fs.writeFileSync(path.join(legacy.stateDir, 'state', 'openclaw.sqlite'), 'database-bytes');
      fs.writeFileSync(path.join(legacy.stateDir, 'state', 'openclaw.sqlite-wal'), 'wal-bytes');
      fs.writeFileSync(
        configPath(),
        JSON.stringify({
          workspacePath: '',
          gateways: [],
          bundledSkillRecords: {
            [path.join(legacy.stateDir, 'skills')]: { 'custom-skill': 'original-digest' },
          },
        }),
      );
      const result = await ensureClientGatewayEntry({
        userDataDir,
        portableWorkspacePath: path.join(tmpRoot, 'workspace'),
        legacyStateUserDataDir: localData,
      });

      expect(fs.readFileSync(path.join(result.stateDir, 'state', 'openclaw.sqlite'), 'utf8')).toBe('database-bytes');
      expect(fs.readFileSync(path.join(result.stateDir, 'state', 'openclaw.sqlite-wal'), 'utf8')).toBe('wal-bytes');
      expect(fs.readFileSync(path.join(legacy.stateDir, 'state', 'openclaw.sqlite-wal'), 'utf8')).toBe('wal-bytes');
      expect(readConfigRaw().bundledSkillRecords).toEqual({
        [path.join(result.stateDir, 'skills')]: { 'custom-skill': 'original-digest' },
      });
    },
  );

  it('⭐ 便携版：main 助手工作区跟随已选 U 盘工作区，不能静默落回本机 state/workspace', async () => {
    const localStateUserDataDir = path.join(tmpRoot, 'local-runtime-cache');
    const portableWorkspace = path.join(tmpRoot, 'portable-volume', '荣盈魔方工作区');
    const { writeConfig } = await import('../src/main/workspace/config.js');
    writeConfig({ workspacePath: portableWorkspace, gateways: [] });

    const first = await ensureClientGatewayEntry({
      userDataDir,
      stateUserDataDir: localStateUserDataDir,
      portableWorkspacePath: portableWorkspace,
    });
    const firstConfig = JSON.parse(fs.readFileSync(stateConfigPath(first.stateDir), 'utf-8'));

    expect(firstConfig.agents.entries.main.workspace).toBe(portableWorkspace);

    // 存量盘上的旧值也必须自愈；其它 main 字段不能被覆盖。
    firstConfig.agents.entries.main = { ...firstConfig.agents.entries.main, workspace: 'C:\\stale', name: '主代理' };
    fs.writeFileSync(stateConfigPath(first.stateDir), JSON.stringify(firstConfig));

    await ensureClientGatewayEntry({
      userDataDir,
      stateUserDataDir: localStateUserDataDir,
      portableWorkspacePath: portableWorkspace,
    });
    const healed = JSON.parse(fs.readFileSync(stateConfigPath(first.stateDir), 'utf-8'));
    expect(healed.agents.entries.main).toEqual({ workspace: portableWorkspace, name: '主代理' });
  });

  it('⭐ 便携版：登录凭证留在 U 盘，OpenClaw 内部 state 写到本机 NTFS 缓存', async () => {
    const localStateUserDataDir = path.join(tmpRoot, 'local-runtime-cache');
    const legacyStateDir = stateDirFor(userDataDir);
    fs.mkdirSync(legacyStateDir, { recursive: true });
    fs.writeFileSync(
      stateConfigPath(legacyStateDir),
      JSON.stringify({ gateway: { auth: { mode: 'token', token: 'legacy-portable-token' } } }),
    );

    const res = await ensureClientGatewayEntry({ userDataDir, stateUserDataDir: localStateUserDataDir });

    expect(res.token).toBe('legacy-portable-token');
    expect(res.stateDir).toBe(portableStateDirFor(localStateUserDataDir, 'legacy-portable-token'));
    expect(path.basename(res.stateDir)).toMatch(/^[a-f0-9]{24}$/u);
    expect(res.stateDir).not.toContain('legacy-portable-token');
    expect(res.stateDir).not.toBe(legacyStateDir);
    expect(JSON.parse(fs.readFileSync(authStorePath(userDataDir), 'utf-8')).token).toBe('legacy-portable-token');
    expect(JSON.parse(fs.readFileSync(stateConfigPath(res.stateDir), 'utf-8')).gateway.auth.token).toBe(
      'legacy-portable-token',
    );
    expect(JSON.parse(fs.readFileSync(stateConfigPath(res.stateDir), 'utf-8')).agents.defaults.skipBootstrap).toBe(
      true,
    );
    expect(fs.existsSync(authStorePath(localStateUserDataDir))).toBe(false);
  });

  it('便携版只强制跳过 exFAT 不支持的 bootstrap 硬链接，不覆盖已有助手默认值', async () => {
    const localStateUserDataDir = path.join(tmpRoot, 'local-runtime-cache');
    const first = await ensureClientGatewayEntry({ userDataDir, stateUserDataDir: localStateUserDataDir });
    const raw = JSON.parse(fs.readFileSync(stateConfigPath(first.stateDir), 'utf-8'));
    raw.agents = { defaults: { model: 'clawrouter/existing-model', skipBootstrap: false }, keep: 'yes' };
    fs.writeFileSync(stateConfigPath(first.stateDir), JSON.stringify(raw));

    await ensureClientGatewayEntry({ userDataDir, stateUserDataDir: localStateUserDataDir });

    const rewritten = JSON.parse(fs.readFileSync(stateConfigPath(first.stateDir), 'utf-8'));
    expect(rewritten.agents).toEqual({
      defaults: { model: 'clawrouter/existing-model', skipBootstrap: true, heartbeat: { every: '0m' } },
      keep: 'yes',
    });

    const onceFixed = fs.readFileSync(stateConfigPath(first.stateDir), 'utf-8');
    await ensureClientGatewayEntry({ userDataDir, stateUserDataDir: localStateUserDataDir });
    expect(fs.readFileSync(stateConfigPath(first.stateDir), 'utf-8')).toBe(onceFixed);
  });

  it('⭐ 同一盘符换成另一支 U 盘时，本机 state 按便携身份隔离，不能继承前一支盘的密钥/会话', async () => {
    const localStateUserDataDir = path.join(tmpRoot, 'local-runtime-cache');
    const first = await ensureClientGatewayEntry({ userDataDir, stateUserDataDir: localStateUserDataDir });

    // 模拟拔掉第一支盘、同一个 E: 路径插入全新的第二支盘；本机缓存故意保留。
    fs.rmSync(userDataDir, { recursive: true, force: true });
    fs.mkdirSync(userDataDir, { recursive: true });
    const second = await ensureClientGatewayEntry({ userDataDir, stateUserDataDir: localStateUserDataDir });

    expect(second.token).not.toBe(first.token);
    expect(second.stateDir).not.toBe(first.stateDir);
    expect(JSON.parse(fs.readFileSync(stateConfigPath(first.stateDir), 'utf-8')).gateway.auth.token).toBe(first.token);
    expect(JSON.parse(fs.readFileSync(stateConfigPath(second.stateDir), 'utf-8')).gateway.auth.token).toBe(
      second.token,
    );
  });

  it('⭐ U 盘 store 已存在时，它会改回本机 scoped state 里的漂移 token', async () => {
    const localStateUserDataDir = path.join(tmpRoot, 'local-runtime-cache');
    const first = await ensureClientGatewayEntry({ userDataDir, stateUserDataDir: localStateUserDataDir });
    const raw = JSON.parse(fs.readFileSync(stateConfigPath(first.stateDir), 'utf-8'));
    raw.gateway.auth.token = 'stale-local-token';
    fs.writeFileSync(stateConfigPath(first.stateDir), JSON.stringify(raw));

    const second = await ensureClientGatewayEntry({ userDataDir, stateUserDataDir: localStateUserDataDir });

    expect(second.stateDir).toBe(first.stateDir);
    expect(second.token).toBe(first.token);
    expect(JSON.parse(fs.readFileSync(stateConfigPath(second.stateDir), 'utf-8')).gateway.auth.token).toBe(first.token);
  });

  it('⭐ U 盘旧 state 缺失时仍接管 U 盘客户端 config 的 local-runtime token', async () => {
    const localStateUserDataDir = path.join(tmpRoot, 'local-runtime-cache');
    const { writeConfig } = await import('../src/main/workspace/config.js');
    writeConfig({
      workspacePath: '/w',
      gateways: [
        {
          id: LOCAL_GATEWAY_ID,
          name: 'Local Runtime',
          url: `ws://127.0.0.1:${GATEWAY_WS_PORT}`,
          authMode: 'token',
          token: 'client-config-token',
        },
      ],
      defaultGatewayId: LOCAL_GATEWAY_ID,
    });

    const res = await ensureClientGatewayEntry({ userDataDir, stateUserDataDir: localStateUserDataDir });

    expect(res.token).toBe('client-config-token');
    expect(JSON.parse(fs.readFileSync(authStorePath(userDataDir), 'utf-8')).token).toBe('client-config-token');
    expect(res.stateDir).toBe(portableStateDirFor(localStateUserDataDir, 'client-config-token'));
  });

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
