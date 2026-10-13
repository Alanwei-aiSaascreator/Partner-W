import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 本地数据组装（P4 Task 13）。
 *
 * 三条硬规矩，逐条钉在这里：
 *   ① **不含任何密钥** —— 配置里的网关令牌 / 密码 / 配对码 / license key /
 *      supabase anon key，一个都不许进导出产物（用户会把这份 JSON 随手转发）；
 *   ② **上限明确**（200 MB / 50 万条消息），超限**如实说明**，不静默截断；
 *   ③ 读不出来（库未就绪 / 配置损坏）就写进 `notes`，绝不假装成功。
 */
const mocks = vi.hoisted(() => ({
  state: {
    ready: true,
    tasks: [] as unknown[],
    messages: [] as unknown[],
    artifacts: [] as unknown[],
    messageCount: null as number | null,
    messageBytes: null as number | null,
    /** true = 把"读消息正文"的每一次分块读记进 `reads`（钉"超限时一行都不读"）。 */
    recordReads: false,
  },
  /** 读消息正文发生的**时序台账**（分块读的 offset + 事件循环探针）。 */
  reads: [] as string[],
  config: null as unknown,
  showSaveDialog: vi.fn(),
  writeFile: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

vi.mock('electron', () => ({
  dialog: { showSaveDialog: mocks.showSaveDialog },
}));

// 保留真的 fs（个别用例要用**真文件**读回落盘字节数），只把 writeFile 换成 spy
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, writeFile: mocks.writeFile };
});

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => mocks.logger,
}));

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => mocks.config,
}));

/** 消息的正文字节**下界**（与 SQL 侧 `length()` 同口径：数的是字符，不是 UTF-8 字节）。 */
function approxMessageBytes(list: unknown[]): number {
  const columns = ['content', 'thinkingContent', 'attachments', 'toolCalls'];
  return list.reduce<number>((sum, row) => {
    const record = (row ?? {}) as Record<string, unknown>;
    return sum + columns.reduce((inner, key) => inner + String(record[key] ?? '').length, 0);
  }, 0);
}

// 假库：按**表名**回行（`getTableName` 认表，不认调用顺序）。
vi.mock('../src/main/db/index.js', async () => {
  const { getTableName } = await import('drizzle-orm');
  const name = (table: unknown) => getTableName(table as never);
  const rows = (table: unknown) =>
    name(table) === 'tasks'
      ? mocks.state.tasks
      : name(table) === 'messages'
        ? mocks.state.messages
        : name(table) === 'artifacts'
          ? mocks.state.artifacts
          : [];
  const noteRead = (table: unknown, offset: number) => {
    if (name(table) === 'messages' && mocks.state.recordReads) mocks.reads.push(`read:${offset}`);
  };
  return {
    isDbReady: () => mocks.state.ready,
    getDb: () => ({
      // `select()` 取行；`select({…})` 是聚合（count(*) + 正文字节）—— 与 drizzle 的签名同形
      select: (...args: unknown[]) => ({
        from: (table: unknown) => {
          if (args.length > 0) {
            return {
              all: () => [
                {
                  n: mocks.state.messageCount ?? mocks.state.messages.length,
                  bytes: mocks.state.messageBytes ?? approxMessageBytes(mocks.state.messages),
                },
              ],
            };
          }
          const orderBy = () => ({
            all: () => rows(table),
            // 分块读：`.limit(n).offset(o).all()`（真实代码就是这么分页的）
            limit: (limit: number) => ({
              offset: (offset: number) => ({
                all: () => {
                  noteRead(table, offset);
                  return rows(table).slice(offset, offset + limit);
                },
              }),
            }),
          });
          return { orderBy, all: () => rows(table) };
        },
      }),
    }),
  };
});

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { isSecretKeyName } from '@clawwork/shared';
import {
  buildLocalExport,
  saveExportFile,
  isSecretKeyNameForExport,
  MAX_EXPORT_BYTES,
  MAX_MESSAGES,
  measureLocalBodies,
} from '../src/main/privacy/export-local.js';

function setup(input: {
  ready?: boolean;
  tasks?: unknown[];
  messages?: unknown[];
  artifacts?: unknown[];
  messageCount?: number;
  messageBytes?: number;
  recordReads?: boolean;
  config?: unknown;
}): void {
  mocks.state.ready = input.ready ?? true;
  mocks.state.tasks = input.tasks ?? [];
  mocks.state.messages = input.messages ?? [];
  mocks.state.artifacts = input.artifacts ?? [];
  mocks.state.messageCount = input.messageCount ?? null;
  mocks.state.messageBytes = input.messageBytes ?? null;
  mocks.state.recordReads = input.recordReads ?? false;
  mocks.config = input.config ?? null;
  mocks.reads = [];
}

/**
 * **独立尺子**：不复用 `measureLocalBodies`。
 *
 * ⚠️ 体积边界的用例如果拿被测函数自己当尺子，把 `measureLocalBodies` 改成
 * "只量 tasks" 之后**两条边界断言都还是绿的**（尺子和被量的是同一个 bug）。
 * 所以这里手写一份等价实现，并另有用例钉住"两份尺子给出同一个数"。
 */
function independentBytes(bodies: {
  tasks: unknown[];
  sessions: unknown[];
  messages: unknown[];
  artifacts: unknown[];
}): number {
  return Buffer.byteLength(JSON.stringify(bodies), 'utf8');
}

function task(id: string): Record<string, unknown> {
  return {
    id,
    sessionKey: `agent:main:clawwork:task:${id}`,
    sessionId: `sess-${id}`,
    title: `任务 ${id}`,
    status: 'active',
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-02T00:00:00Z',
    tags: '["a","b"]',
    artifactDir: 'D:\\workspace\\artifacts',
    gatewayId: 'g1',
  };
}

function message(id: string, taskId: string, timestamp: string): Record<string, unknown> {
  return {
    id,
    taskId,
    role: 'assistant',
    content: `内容 ${id}`,
    timestamp,
    sessionKey: `agent:main:clawwork:task:${taskId}`,
    attachments: '[{"mimeType":"image/png"}]',
    toolCalls: 'not json at all',
  };
}

/** 收集一份对象里出现过的所有键名（用来断言"没有密钥字段"）。 */
function collectKeys(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, out);
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      collectKeys(child, out);
    }
  }
  return out;
}

/** 带全套密钥的假配置：脱敏测试的"阳性对照"。 */
const SECRET_VALUES = [
  'sk-GATEWAY-TOKEN-abc',
  'gw-password',
  'PAIR-1234',
  'BOOTSTRAP-SECRET',
  'config-password',
  'supabase-anon-key-xyz',
  'LICENSE-KEY-999',
];

const appConfig = {
  workspacePath: 'D:\\workspace',
  theme: 'dark',
  language: 'zh-CN',
  gateways: [
    {
      id: 'g1',
      name: '本地网关',
      url: 'ws://127.0.0.1:18789',
      token: SECRET_VALUES[0],
      password: SECRET_VALUES[1],
      pairingCode: SECRET_VALUES[2],
      authMode: 'token',
      isDefault: true,
    },
  ],
  bootstrapToken: SECRET_VALUES[3],
  password: SECRET_VALUES[4],
  deviceId: 'device-1',
  quickLaunch: { enabled: true, shortcut: 'Alt+Space' },
  commercial: {
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: SECRET_VALUES[5],
    licenseKey: SECRET_VALUES[6],
  },
};

describe('本地导出：形状', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup({});
  });

  it('本地库没就绪 ⇒ 空正文 + notes 如实说明（不假装导出成功）', async () => {
    setup({ ready: false, config: appConfig });

    const out = await buildLocalExport();

    expect(out.tasks).toEqual([]);
    expect(out.messages).toEqual([]);
    expect(out.artifacts).toEqual([]);
    expect(out.sessions).toEqual([]);
    expect(out.meta.counts).toEqual({ tasks: 0, sessions: 0, messages: 0, artifacts: 0 });
    expect(out.meta.truncated).toBe(false);
    expect(out.notes.join('')).toContain('本地数据库未就绪');
  });

  it('正文五件套齐全：任务 / 会话 / 消息 / 成果索引 / 设置', async () => {
    setup({
      tasks: [task('t1')],
      messages: [message('m1', 't1', '2026-09-01T00:00:01Z')],
      artifacts: [
        {
          id: 'a1',
          taskId: 't1',
          messageId: 'm1',
          type: 'file',
          name: '报表.xlsx',
          filePath: 'D:\\workspace\\out\\报表.xlsx',
          localPath: 'out/报表.xlsx',
          mimeType: 'application/vnd.ms-excel',
          size: 1024,
          sourceKey: 'src-1',
          contentText: '',
          createdAt: '2026-09-01T00:00:02Z',
        },
      ],
      config: appConfig,
    });

    const out = await buildLocalExport();

    // 任务：JSON 文本列解析回数组
    expect(out.tasks).toHaveLength(1);
    expect((out.tasks[0] as Record<string, unknown>).tags).toEqual(['a', 'b']);

    // 会话：一个任务一个 OpenClaw 会话（本地库没有独立会话表）
    expect(out.sessions).toEqual([
      {
        sessionKey: 'agent:main:clawwork:task:t1',
        sessionId: 'sess-t1',
        taskId: 't1',
        title: '任务 t1',
        status: 'active',
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-02T00:00:00Z',
      },
    ]);

    // 消息：坏 JSON **原样留着**（比丢掉好），好 JSON 解析回数组
    expect(out.messages).toHaveLength(1);
    expect((out.messages[0] as Record<string, unknown>).attachments).toEqual([{ mimeType: 'image/png' }]);
    expect((out.messages[0] as Record<string, unknown>).toolCalls).toBe('not json at all');

    // 成果索引
    expect(out.artifacts).toHaveLength(1);
    expect((out.artifacts[0] as Record<string, unknown>).name).toBe('报表.xlsx');

    // 设置（脱敏后的）
    expect(out.settings?.theme).toBe('dark');
    expect(out.settings?.workspacePath).toBe('D:\\workspace');

    // 元数据
    expect(out.meta.counts).toEqual({ tasks: 1, sessions: 1, messages: 1, artifacts: 1 });
    expect(out.meta.limits).toEqual({ maxMessages: MAX_MESSAGES, maxBytes: MAX_EXPORT_BYTES });
    expect(out.meta.truncated).toBe(false);
    expect(out.notes).toEqual([]);
  });

  it('读不到配置 ⇒ settings 为 null，并写进 notes', async () => {
    setup({ tasks: [task('t1')], config: null });

    const out = await buildLocalExport();

    expect(out.settings).toBeNull();
    expect(out.notes.join('')).toContain('设置');
  });
});

describe('本地导出：上限', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup({});
  });

  it('上限就是设计里的两个数：200 MB / 50 万条消息', () => {
    expect(MAX_MESSAGES).toBe(500_000);
    expect(MAX_EXPORT_BYTES).toBe(200 * 1024 * 1024);
  });

  it('消息数超上限 ⇒ 只导出计数与索引，不含正文，且如实说明（**一行正文都不读**）', async () => {
    setup({
      tasks: [task('t1')],
      messages: [message('m1', 't1', '2026-09-01T00:00:01Z')],
      messageCount: 500_001,
      recordReads: true,
      config: appConfig,
    });

    const out = await buildLocalExport();

    expect(out.messages).toEqual([]);
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.counts.messages).toBe(500_001);
    // 条数预检是真的：超限时**根本不该去读正文**
    expect(mocks.reads).toEqual([]);
    // 说明里要带上限与实际条数 —— 用户得知道"这份不是完整历史"
    expect(out.notes.join('')).toContain('500000');
    expect(out.notes.join('')).toContain('500001');
    // 任务 / 会话 / 成果不受消息上限牵连
    expect(out.tasks).toHaveLength(1);
    expect(out.sessions).toHaveLength(1);
  });

  it('正文字节预检：下界估计就超限 ⇒ 直接退到元数据，**绝不把正文捞进内存**', async () => {
    setup({
      tasks: [task('t1')],
      messages: [message('m1', 't1', '2026-09-01T00:00:01Z'), message('m2', 't1', '2026-09-01T00:00:02Z')],
      messageBytes: 300,
      recordReads: true,
      config: appConfig,
    });

    const out = await buildLocalExport({ maxBytes: 100 });

    expect(out.meta.truncated).toBe(true);
    expect(out.messages).toEqual([]);
    expect(out.tasks).toEqual([]);
    expect(out.artifacts).toEqual([]);
    // 计数与设置仍然如实带上
    expect(out.meta.counts).toEqual({ tasks: 1, sessions: 1, messages: 2, artifacts: 0 });
    expect(out.meta.limits.maxBytes).toBe(100);
    expect(out.settings?.theme).toBe('dark');
    // ⭐ 核心断言：一条正文都没读（去掉预检 ⇒ 这里会变成 ['read:0'] ⇒ 红）
    expect(mocks.reads).toEqual([]);
    expect(out.notes.join('')).toContain('100');
  });

  it('体积预检与逐字节上限一致：下界没超但真值超 ⇒ 仍由精确尺子拦下', async () => {
    setup({ tasks: [task('t1')], messages: [message('m1', 't1', '2026-09-01T00:00:01Z')], config: appConfig });

    const full = await buildLocalExport();
    const bodies = {
      tasks: full.tasks,
      sessions: full.sessions,
      messages: full.messages,
      artifacts: full.artifacts,
    };
    const exact = independentBytes(bodies);

    // 下界（45 字符）远小于 exact ⇒ 预检放行 ⇒ 必须走"读了正文再按精确尺子判"这条路
    const out = await buildLocalExport({ maxBytes: exact - 1 });

    expect(out.meta.truncated).toBe(true);
    expect(out.messages).toEqual([]);
  });

  it('消息正文分块读：每块之间让出事件循环（主进程不被长时间独占），且不丢行不重行', async () => {
    const many: unknown[] = [];
    for (let i = 0; i < 12_000; i += 1)
      many.push(message(`m${i}`, 't1', `2026-09-01T00:${String(i % 60).padStart(2, '0')}:00Z`));
    setup({ tasks: [task('t1')], messages: many, recordReads: true, config: appConfig });

    // 事件循环探针：与分块读共用一本台账，才能看出"读块"和"让出"的**交错**
    let stop = false;
    const probe = () => {
      mocks.reads.push('tick');
      if (!stop) setImmediate(probe);
    };
    setImmediate(probe);

    const out = await buildLocalExport();
    stop = true;

    expect(out.messages).toHaveLength(12_000);
    expect(out.meta.truncated).toBe(false);
    // 分块证据：三次读、每块 5000 行
    const readsOnly = mocks.reads.filter((entry) => entry.startsWith('read:'));
    expect(readsOnly).toEqual(['read:0', 'read:5000', 'read:10000']);
    // 让出事件循环的证据：**最后一块读之前**探针已经跑过至少一次
    // （一次性同步读完 12000 行的话，所有 tick 都会排在三次读之后 ⇒ 红）
    const firstTick = mocks.reads.indexOf('tick');
    expect(firstTick).toBeGreaterThan(-1);
    expect(firstTick).toBeLessThan(mocks.reads.lastIndexOf('read:10000'));
  });

  it('消息数正好等于上限 ⇒ 不算超限（边界是 >，不是 >=）', async () => {
    setup({
      tasks: [task('t1')],
      messages: [message('m1', 't1', '2026-09-01T00:00:01Z')],
      messageCount: MAX_MESSAGES,
      config: appConfig,
    });

    const out = await buildLocalExport();

    expect(out.messages).toHaveLength(1);
    expect(out.meta.truncated).toBe(false);
    expect(out.notes).toEqual([]);
  });

  it('本地正文超体积上限 ⇒ 正文退化成元数据（计数 + 设置仍在），并如实说明', async () => {
    setup({
      tasks: [task('t1')],
      messages: [message('m1', 't1', '2026-09-01T00:00:01Z')],
      artifacts: [
        {
          id: 'a1',
          taskId: 't1',
          messageId: 'm1',
          name: 'big.bin',
          localPath: 'out/big.bin',
          size: 1,
          createdAt: '2026-09-01T00:00:02Z',
        },
      ],
      config: appConfig,
    });

    const out = await buildLocalExport({ maxBytes: 10 });

    expect(out.tasks).toEqual([]);
    expect(out.sessions).toEqual([]);
    expect(out.messages).toEqual([]);
    expect(out.artifacts).toEqual([]);
    expect(out.meta.truncated).toBe(true);
    // 元数据仍如实
    expect(out.meta.counts).toEqual({ tasks: 1, sessions: 1, messages: 1, artifacts: 1 });
    expect(out.meta.limits.maxBytes).toBe(10);
    expect(out.notes.join('')).toContain('10');
    // 设置是元数据，超限时仍然带上
    expect(out.settings?.theme).toBe('dark');
  });

  it('体积边界：正好等于上限 ⇒ 不截断；少 1 字节 ⇒ 截断（**独立尺子**）', async () => {
    setup({ tasks: [task('t1')], messages: [message('m1', 't1', '2026-09-01T00:00:01Z')], config: appConfig });

    const full = await buildLocalExport();
    const bodies = {
      tasks: full.tasks,
      sessions: full.sessions,
      messages: full.messages,
      artifacts: full.artifacts,
    };
    // ⚠️ 边界值由**测试自己**算（不是拿被测函数量自己）—— 见 `independentBytes`
    const exact = independentBytes(bodies);
    // 两份尺子必须给出同一个数（否则这条边界量的是另一回事）
    expect(measureLocalBodies(bodies)).toBe(exact);

    const atLimit = await buildLocalExport({ maxBytes: exact });
    expect(atLimit.meta.truncated).toBe(false);
    expect(atLimit.messages).toHaveLength(1);

    const overLimit = await buildLocalExport({ maxBytes: exact - 1 });
    expect(overLimit.meta.truncated).toBe(true);
    expect(overLimit.messages).toEqual([]);
  });

  it('上限量的是**四类正文合起来**的字节：小任务 + 大成果，卡在两者之间必须整体截断', async () => {
    const big = {
      id: 'a1',
      taskId: 't1',
      messageId: 'm1',
      name: 'big.bin',
      localPath: 'out/big.bin',
      size: 1,
      // 成果正文也是正文：漏量它就会"看起来没超限"
      contentText: 'x'.repeat(4_000),
      createdAt: '2026-09-01T00:00:02Z',
    };
    setup({ tasks: [task('t1')], artifacts: [big], messages: [], config: appConfig });

    const full = await buildLocalExport();
    const tasksOnly = independentBytes({ tasks: full.tasks, sessions: [], messages: [], artifacts: [] });
    const everything = independentBytes({
      tasks: full.tasks,
      sessions: full.sessions,
      messages: full.messages,
      artifacts: full.artifacts,
    });
    // 上限卡在"只算任务"与"算上成果"之间
    const maxBytes = Math.floor((tasksOnly + everything) / 2);
    expect(maxBytes).toBeGreaterThan(tasksOnly);
    expect(maxBytes).toBeLessThan(everything);

    const out = await buildLocalExport({ maxBytes });

    // 真值超了 ⇒ 必须整体退到元数据。把尺子缩成"只量 tasks"的话这里会变成
    // truncated=false 且成果正文照样导出（假绿），所以这条用例就是那把独立尺子。
    expect(out.meta.truncated).toBe(true);
    expect(out.artifacts).toEqual([]);
    expect(out.meta.counts).toEqual({ tasks: 1, sessions: 1, messages: 0, artifacts: 1 });
    expect(out.notes.join('')).toContain(String(maxBytes));
  });
});

describe('本地导出：绝不带密钥', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('配置里的令牌 / 密码 / 配对码 / license key / anon key 一个都不进产物', async () => {
    setup({ tasks: [task('t1')], messages: [message('m1', 't1', '2026-09-01T00:00:01Z')], config: appConfig });

    const out = await buildLocalExport();
    const text = JSON.stringify(out);

    for (const secret of SECRET_VALUES) {
      expect(text, secret).not.toContain(secret);
    }
    // 密文（`enc:` 前缀）同样不许出现 —— 它是"没解开的密钥"，一样是密钥
    expect(text).not.toContain('enc:');
    // 键名层面也不许有敏感字段（只挑安全字段的白名单）
    const keys = collectKeys(out.settings);
    expect(
      keys.filter((key) => /token|password|secret|license|key|pairing|credential|authorization/i.test(key)),
    ).toEqual([]);

    // 非密钥的设置照旧导出（别把整份设置一起丢掉）
    expect(out.settings?.gateways).toEqual([
      {
        id: 'g1',
        name: '本地网关',
        url: 'ws://127.0.0.1:18789',
        authMode: 'token',
        tlsVerify: null,
        isDefault: true,
        color: null,
      },
    ]);
    // 卡密在不在 ⇒ 只导出布尔，不导出值（键名也不能叫 `license*`：那是脱敏词）
    expect(out.settings?.commercial).toEqual({ activated: true });
    expect(out.settings?.deviceId).toBe('device-1');
  });

  it('没有激活卡时 activated 为 false（不是 null，也不是漏字段）', async () => {
    setup({ config: { workspacePath: 'D:\\workspace', gateways: [], commercial: undefined } });

    const out = await buildLocalExport();

    expect(out.settings?.commercial).toEqual({ activated: false });
    expect(out.settings?.gateways).toEqual([]);
  });
});

describe('本地导出：配置形状坏掉也不许整份失败', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('数组字段被手改成非数组 ⇒ 当空数组 + notes 说明，导出照常成功', async () => {
    setup({
      tasks: [task('t1')],
      config: { ...appConfig, gateways: { not: 'an array' }, teamHubRegistries: 'oops' },
    });

    const out = await buildLocalExport();

    // 坏字段降级
    expect(out.settings?.gateways).toEqual([]);
    expect(out.settings?.teamHubRegistries).toEqual([]);
    expect(out.notes.join('')).toContain('gateways');
    expect(out.notes.join('')).toContain('teamHubRegistries');
    // 好字段与正文照旧（用户要的是把数据导出来，不是被一份坏配置拦住）
    expect(out.settings?.theme).toBe('dark');
    expect(out.tasks).toHaveLength(1);
    expect(out.meta.truncated).toBe(false);
  });

  it('数组里混进非对象项 ⇒ 跳过它们并说明（剩下的照常导出）', async () => {
    setup({
      tasks: [task('t1')],
      config: {
        ...appConfig,
        gateways: [null, 'oops', { id: 'g1', name: '本地网关', url: 'ws://127.0.0.1:18789' }],
      },
    });

    const out = await buildLocalExport();

    expect(out.settings?.gateways).toEqual([
      {
        id: 'g1',
        name: '本地网关',
        url: 'ws://127.0.0.1:18789',
        authMode: null,
        tlsVerify: null,
        isDefault: false,
        color: null,
      },
    ]);
    expect(out.notes.join('')).toContain('跳过');
  });
});

/**
 * BUG-056⑤：导出脱敏与日志脱敏必须**同一套规则** —— 两边各写一份正则，
 * 某天只改一处就会出现"日志摘了、导出没摘"（用户会把导出的 JSON 随手转发）。
 * relay key 以 `apiKey` 键写进网关配置，这正是原先两边都漏的一族。
 */
describe('BUG-056⑤ —— 导出与日志同一条密钥键名规则', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('⭐ 公共规则（含 apiKey / relayKey 家族）在导出规则里完整生效', () => {
    const sharedFamiliy = [
      'apiKey',
      'APIKEY',
      'api_key',
      'API_KEY',
      'api-key',
      'relayKey',
      'RelayKey',
      'relay_key',
      'RELAY_KEY',
      'relay-key',
    ];
    for (const key of sharedFamiliy) {
      expect(isSecretKeyName(key), `公共规则漏了 ${key}`).toBe(true);
      expect(isSecretKeyNameForExport(key), `导出规则漏了 ${key}`).toBe(true);
    }
    // 导出独有的词（license/pairing/credential/anon key）保持有效
    for (const key of ['licenseKey', 'pairingCode', 'credential', 'anonKey', 'anon_key']) {
      expect(isSecretKeyNameForExport(key), key).toBe(true);
    }
    // 负对照：正常业务字段不许被误判（键名层面）
    for (const key of ['apiVersion', 'capacity', 'keyboard', 'monkey', 'keyResult', 'relayLatency']) {
      expect(isSecretKeyNameForExport(key), key).toBe(false);
      expect(isSecretKeyName(key), key).toBe(false);
    }
  });

  it('⭐ 不修改原对象：导出读配置后，配置对象逐字不变（深冻结也不炸）', async () => {
    const frozen = Object.freeze(structuredClone(appConfig));
    setup({ tasks: [task('t1')], config: frozen });
    const snapshot = JSON.stringify(frozen);

    const out = await buildLocalExport();

    expect(JSON.stringify(frozen), '导出不得原地改写配置对象').toBe(snapshot);
    // 白名单第一道 + 键名规则第二道之后，密钥值一个都不许出现在产物里
    const text = JSON.stringify(out);
    for (const secret of SECRET_VALUES) expect(text, secret).not.toContain(secret);
  });
});

describe('saveExportFile', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setup({});
  });

  it('用户在对话框点取消 ⇒ 抛 cancelled（IPC 层翻成 cancelled 码）', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    await expect(saveExportFile({ a: 1 })).rejects.toThrow('cancelled');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('选好路径 ⇒ 写 UTF-8 JSON、记一条 privacy 域调试事件、返回路径', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'D:\\out\\export.json' });
    mocks.writeFile.mockResolvedValue(undefined);

    const path = await saveExportFile({ format: 'rongying-mofang-export@1' });

    expect(path).toBe('D:\\out\\export.json');
    const [target, body, encoding] = mocks.writeFile.mock.calls[0] as [string, string, string];
    expect(target).toBe('D:\\out\\export.json');
    expect(JSON.parse(body)).toEqual({ format: 'rongying-mofang-export@1' });
    expect(encoding).toBe('utf8');
    expect(mocks.logger.info).toHaveBeenCalledWith({ domain: 'privacy', event: 'privacy.export-saved' });

    // 建议文件名固定形状：rongying-mofang-export-YYYY-MM-DD.json
    const suggested = (mocks.showSaveDialog.mock.calls[0][0] as { defaultPath: string }).defaultPath;
    expect(suggested).toMatch(/rongying-mofang-export-\d{4}-\d{2}-\d{2}\.json$/);
  });

  it('保存对话框带 JSON filter（不给 filter 时用户很容易存成没后缀的文件）', async () => {
    mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'D:\\out\\export.json' });
    mocks.writeFile.mockResolvedValue(undefined);

    await saveExportFile({ a: 1 });

    const options = mocks.showSaveDialog.mock.calls[0][0] as { filters?: unknown };
    expect(options.filters).toEqual([{ name: 'JSON', extensions: ['json'] }]);
  });

  it('建议文件名用**本地日期**：本地与 UTC 不同日时不许写成昨天', async () => {
    vi.useFakeTimers();
    try {
      // 本地 2026-09-18 00:30；东八区此刻 UTC 还是 09-17
      vi.setSystemTime(new Date(2026, 8, 18, 0, 30, 0));
      const now = new Date();
      const localStamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: 'D:\\out\\export.json' });
      mocks.writeFile.mockResolvedValue(undefined);

      await saveExportFile({ a: 1 });

      const suggested = (mocks.showSaveDialog.mock.calls[0][0] as { defaultPath: string }).defaultPath;
      expect(suggested).toContain(`rongying-mofang-export-${localStamp}.json`);
      // 本地日期与 UTC 日期确实不同的时区里，文件名必须是**本地**那个
      const utcStamp = now.toISOString().slice(0, 10);
      if (utcStamp !== localStamp) expect(suggested).not.toContain(utcStamp);
    } finally {
      vi.useRealTimers();
    }
  });

  it('落盘的实际字节数 vs 上限：完整那份确实装着正文，截断那份明显更小（真 fs 读回）', async () => {
    const messages: unknown[] = [];
    for (let i = 0; i < 200; i += 1) {
      messages.push({
        ...message(`m${i}`, 't1', `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}Z`),
        content: `第 ${i} 条消息的正文，长度足够让体积上限有感`,
      });
    }
    setup({ tasks: [task('t1')], messages, config: appConfig });

    const dir = await mkdtemp(join(tmpdir(), 'clawwork-privacy-export-'));
    // 这个用例要**真文件**：读回长度才算"落盘的实际字节数"。
    // ⚠️ 走 `importActual` 拿真函数 —— 上面 import 到的 `writeFile` 就是 spy 自己，
    //    在 spy 的实现里调它会无限递归。
    const actualFs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    mocks.writeFile.mockImplementation((target: string, data: string, encoding: BufferEncoding) =>
      actualFs.writeFile(target, data, encoding),
    );
    try {
      const full = await buildLocalExport();
      expect(full.meta.truncated).toBe(false);
      const fullBytes = independentBytes({
        tasks: full.tasks,
        sessions: full.sessions,
        messages: full.messages,
        artifacts: full.artifacts,
      });

      const fullPath = join(dir, 'full.json');
      mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: fullPath });
      await saveExportFile({ format: 'rongying-mofang-export@1', local: full });

      const fullWritten = (await stat(fullPath)).size;
      // 文件里确实装着那份正文（≥ 四类正文的序列化字节，另加外层字段）
      expect(fullWritten).toBeGreaterThanOrEqual(fullBytes);
      expect(JSON.parse(await readFile(fullPath, 'utf8')).local.messages).toHaveLength(200);

      // 上限卡在正文之下 ⇒ 退化成元数据那份必须明显更小
      const truncated = await buildLocalExport({ maxBytes: 500 });
      expect(truncated.meta.truncated).toBe(true);

      const truncatedPath = join(dir, 'truncated.json');
      mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: truncatedPath });
      await saveExportFile({ format: 'rongying-mofang-export@1', local: truncated });

      const truncatedWritten = (await stat(truncatedPath)).size;
      expect(truncatedWritten).toBeLessThan(fullWritten);
      const parsed = JSON.parse(await readFile(truncatedPath, 'utf8')) as {
        local: { messages: unknown[]; tasks: unknown[] };
      };
      expect(parsed.local.messages).toEqual([]);
      expect(parsed.local.tasks).toEqual([]);
    } finally {
      mocks.writeFile.mockReset();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
