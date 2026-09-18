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
  },
  config: null as unknown,
  showSaveDialog: vi.fn(),
  writeFile: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

vi.mock('electron', () => ({
  dialog: { showSaveDialog: mocks.showSaveDialog },
}));

vi.mock('node:fs/promises', () => ({
  writeFile: mocks.writeFile,
}));

vi.mock('../src/main/debug/index.js', () => ({
  getDebugLogger: () => mocks.logger,
}));

vi.mock('../src/main/workspace/config.js', () => ({
  readConfig: () => mocks.config,
}));

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
  return {
    isDbReady: () => mocks.state.ready,
    getDb: () => ({
      // `select()` 取行；`select({…})` 是聚合（count(*)）—— 与 drizzle 的签名同形
      select: (...args: unknown[]) => ({
        from: (table: unknown) =>
          args.length > 0
            ? { all: () => [{ n: mocks.state.messageCount ?? mocks.state.messages.length }] }
            : { orderBy: () => ({ all: () => rows(table) }), all: () => rows(table) },
      }),
    }),
  };
});

import { writeFile } from 'node:fs/promises';
import {
  buildLocalExport,
  saveExportFile,
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
  config?: unknown;
}): void {
  mocks.state.ready = input.ready ?? true;
  mocks.state.tasks = input.tasks ?? [];
  mocks.state.messages = input.messages ?? [];
  mocks.state.artifacts = input.artifacts ?? [];
  mocks.state.messageCount = input.messageCount ?? null;
  mocks.config = input.config ?? null;
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

  it('消息数超上限 ⇒ 只导出计数与索引，不含正文，且如实说明', async () => {
    setup({
      tasks: [task('t1')],
      messages: [message('m1', 't1', '2026-09-01T00:00:01Z')],
      messageCount: 500_001,
      config: appConfig,
    });

    const out = await buildLocalExport();

    expect(out.messages).toEqual([]);
    expect(out.meta.truncated).toBe(true);
    expect(out.meta.counts.messages).toBe(500_001);
    // 说明里要带上限与实际条数 —— 用户得知道"这份不是完整历史"
    expect(out.notes.join('')).toContain('500000');
    expect(out.notes.join('')).toContain('500001');
    // 任务 / 会话 / 成果不受消息上限牵连
    expect(out.tasks).toHaveLength(1);
    expect(out.sessions).toHaveLength(1);
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

  it('体积边界：正好等于上限 ⇒ 不截断；少 1 字节 ⇒ 截断', async () => {
    setup({ tasks: [task('t1')], messages: [message('m1', 't1', '2026-09-01T00:00:01Z')], config: appConfig });

    const full = await buildLocalExport();
    const exact = measureLocalBodies({
      tasks: full.tasks,
      sessions: full.sessions,
      messages: full.messages,
      artifacts: full.artifacts,
    });

    const atLimit = await buildLocalExport({ maxBytes: exact });
    expect(atLimit.meta.truncated).toBe(false);
    expect(atLimit.messages).toHaveLength(1);

    const overLimit = await buildLocalExport({ maxBytes: exact - 1 });
    expect(overLimit.meta.truncated).toBe(true);
    expect(overLimit.messages).toEqual([]);
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
});
