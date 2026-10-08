/**
 * 生产能力注册表（Production Capability Registry · BUG-043）。
 *
 * ## 它解决什么问题
 *
 * 产品的"能力面"此前散落在各处的**假设**里：模型目录里有什么、relay 声明了什么、
 * 哪个工具在包内、哪个能力本轮没接——没有一处能回答"**现在这台机器上，什么真的可用**"。
 * 下场是两类假话：对用户承诺做不到的事（"帮你生图"），或让模型**调用试错**
 * （调 image_generate → 报 Tool Failure → 用户看到一串失败）。
 *
 * ## 硬规则（本文件的存在理由）
 *
 * 1. **`available` 只能来自验证记录**（`CAPABILITY_VERIFICATION_LEDGER`，每条带
 *    `verifiedAt` + `verifiedCase` 实测证据）。目录里"存在"不等于验证过——
 *    目录存在但无实测记录 = `unverified`，**不许**说成可用。
 * 2. **目录没声明 ⇒ `unavailable`**（例如没有 vision 声明的模型看不了图）。
 * 3. **`unavailable` 的工具不得出现在模型可见的工具面**——判据是
 *    `plannerDeniedToolIds()`，由 `main/runtime/state-config.ts` 的 deny 通道消费
 *    （与 memory/canvas/web 那些名字同一个并集、同一套存量自愈判据）。
 *
 * ## 真源
 *
 * · **模型能力**：网关 `models.list`（`input: ['text','image']` 是随包运行时
 *   `rongying-provider-capability-v1` 从 relay 目录 `llm.vision` 投影来的声明）
 *   + relay 目录声明。`buildCapabilityRegistry` 只吃调用方筛过的条目
 *   （渲染层/主进程都按 `provider === 'clawrouter'` 过滤，与 `relayModelsFrom` 同一把尺）。
 * · **工具能力**：`tools.catalog` / `tools.effective` 的清单 id（ui-store 已有）。
 *   本模块只做**状态推导**，不自己上网关拉清单（拉清单是调用方的事，各层已有通道）。
 *
 * ## 与计费/UI 的关系
 *
 * 这里**只有事实与状态**，不含任何文案与 UI 决策：文案键在 `capability-boundary.ts`，
 * 展示层（模型选择器、团队面板等）继续走各自既有的 store。
 */

export type CapabilityAvailability = 'available' | 'unverified' | 'unavailable';
export type CapabilityKind = 'model' | 'tool';

/** 一条"验证记录"：**只有实测**才配写在这里，并必须带证据（日期 + 用例）。 */
export interface CapabilityEvidence {
  verifiedAt: string;
  verifiedCase: string;
}

export interface CapabilityLedgerRecord {
  kind: CapabilityKind;
  /** 模型 id（目录里的 id，不带 provider 前缀）/ 工具 id（运行时注册名）。 */
  id: string;
  /** 能力 id：模型用 `chat` / `vision` / `search`；工具用 `web-read` / `image-generation` / … */
  capability: string;
  /** 账本只记两端：实测可用 / 明确不可用。"没验证"是推导结果，不进账本。 */
  availability: 'available' | 'unavailable';
  provider?: string;
  /** `available` 必填（硬规则 1）；`unavailable` 用它说明为什么。 */
  evidence?: CapabilityEvidence;
  reason?: string;
}

/**
 * 验证账本（种子）—— **每一行都是一次真实现场**，不是设计意图。
 *
 * ⚠️ 加行之前先问：有没有实测证据（哪天、什么用例）？没有 ⇒ 别写 `available`，
 *    它的正确状态是推导出来的 `unverified`。
 */
export const CAPABILITY_VERIFICATION_LEDGER: readonly CapabilityLedgerRecord[] = [
  // ── 模型 · 对话（真实任务链实证）────────────────────────────────────────────
  {
    kind: 'model',
    id: 'qwen3.7-flash',
    capability: 'chat',
    availability: 'available',
    provider: 'clawrouter',
    evidence: {
      verifiedAt: '2026-10-08',
      verifiedCase: '真实任务链：PPT 五连（a208–a212 全链 PASS）+ 团队会议审核 run02',
    },
  },
  {
    kind: 'model',
    id: 'deepseek-v4-flash',
    capability: 'chat',
    availability: 'available',
    provider: 'clawrouter',
    evidence: {
      verifiedAt: '2026-10-05',
      verifiedCase: '真实专卡出片：首版链 attempt05 全绿（13 页 + artifact 登记）',
    },
  },
  // ── 模型 · 视觉（探针 B，2026-10-08）─────────────────────────────────────────
  {
    kind: 'model',
    id: 'qwen3.7-flash',
    capability: 'vision',
    availability: 'available',
    provider: 'clawrouter',
    evidence: {
      verifiedAt: '2026-10-08',
      verifiedCase: '探针 B：上传图片后精确读出图内内容（relay 目录已声明 llm.vision）',
    },
  },
  // ── 模型 · 联网搜索（relay 探针 A4，2026-10-08）─────────────────────────────
  {
    kind: 'model',
    id: 'qwen3.7-flash',
    capability: 'search',
    availability: 'available',
    provider: 'clawrouter',
    evidence: {
      verifiedAt: '2026-10-08',
      verifiedCase: '探针 A4：enable_search 真实触发（同问句输入 15 → 5974 token，网页内容拼进 prompt）',
    },
  },
  // ⚠️ 白名单里的 `qwen-turbo` / `qwen-plus` **刻意不写在这里**：它们没有实测记录，
  //    正确的状态是推导出来的 `unverified`（账本只收两端，见类型注释）。
  // ── 工具 · 读网页（用户实测 + 日志，2026-10-08）─────────────────────────────
  {
    kind: 'tool',
    id: 'browser',
    capability: 'web-read',
    availability: 'available',
    evidence: {
      verifiedAt: '2026-10-08',
      verifiedCase: '用户实测 + 日志：真实打开并读取网页内容（2026-10-07 普查时语料 0 调用，实测后升级）',
    },
  },
  // ── 工具 · 本轮未接入（不得暴露给模型）─────────────────────────────────────
  {
    kind: 'tool',
    id: 'image_generate',
    capability: 'image-generation',
    availability: 'unavailable',
    reason: '图片生成本轮不接入（media-loop 冻结）——不得暴露给模型，不许调用试错',
  },
  {
    kind: 'tool',
    id: 'video_generate',
    capability: 'video-generation',
    availability: 'unavailable',
    reason: '视频生成本轮不接入（media-loop 冻结）——不得暴露给模型，不许调用试错',
  },
  {
    kind: 'tool',
    id: 'voice',
    capability: 'voice',
    availability: 'unavailable',
    reason: '语音合成 / 声音克隆在 Windows 桌面版未接入（语音输入是客户端能力，与本条无关）',
  },
  // ── 工具 · 配对节点文件传输（pre19 验收实跑，2026-10-08）────────────────────
  {
    kind: 'tool',
    id: 'file_fetch',
    capability: 'file-transfer',
    availability: 'unavailable',
    reason:
      '单机环境无配对节点（file-transfer 工具需要 nodes 配对）；本机路径用 read/exec。' +
      '实测：task 81e5053a 调用即败（40ms）——`no paired nodes available; file-transfer tools require a paired node from nodes status.`',
  },
];

/**
 * 模型 id → 该模型是否**开了** relay 侧 `enable_search`。
 *
 * ⚠️ 单一真源在读端一侧：`main/commercial/relay-config.ts` 的 `ENABLE_SEARCH_MODEL_IDS`
 *    （未导出，改那一处即全链生效）。这里保留一份**判据快照**用于状态推导——
 *    两边不一致时以 relay-config 为准，测试会钉住这份快照的内容。
 */
export const RELAY_SEARCH_ENABLED_MODEL_IDS: readonly string[] = ['qwen-turbo', 'qwen-plus', 'qwen3.7-flash'];

/**
 * `unavailable` 的工具 id —— **必须进 deny**（模型可见面里不许出现）。
 *
 * 与 state-config 的 `MEMORY_TOOLS_DENIED` / `PLATFORM_IRRELEVANT_TOOLS_DENIED` /
 * `WEB_TOOLS_DENIED` 合并成一个并集；新增/移除只改这里。
 * ⚠️ `voice` **不在这里**：它不是运行时注册的工具名，写进 `tools.deny` 没有意义
 *    （deny 收的是工具名）。它的"不支持"由能力边界提示词承担。
 *
 * 2026-10-08（pre19 验收实跑）：加 `file_fetch` —— 它是**配对节点**的文件传输工具，
 * 单机产品没有配对节点 ⇒ 调用必然失败，且失败原文是英文样板直接上屏
 * （`no paired nodes available; file-transfer tools require a paired node…`）。
 * 与 image/video 同一条机制：并集由 `state-config` 的 deny 通道消费，
 * 存量自愈判据与 `workflow-tools` 的默认集合**全自动跟随**（改这一行即全链生效）。
 */
export const PLANNER_UNAVAILABLE_TOOL_IDS: readonly string[] = ['image_generate', 'video_generate', 'file_fetch'];

export interface CapabilityModelSource {
  id: string;
  provider?: string;
  /** 网关 `models.list` 的形状：`['text']` / `['text','image']`（缺省 = 没有声明）。 */
  input?: unknown;
}

export interface CapabilityRegistryInput {
  /** 目录条目（调用方筛过 provider；缺省 = 只出账本里有记录的条目）。 */
  models?: readonly CapabilityModelSource[];
  /**
   * 工具清单的 id（`tools.catalog` / `tools.effective` 的 `tools[].id`，调用方给）。
   *
   * 清单里的工具**只有账本记录过的那条能力**才算数；其余一律 `unverified` ——
   * "出现在清单里"只证明它被注册了，不证明这个能力可用（硬规则 1）。
   * 账本里的工具（含 `unavailable` 的 image/video 生成）**不因清单缺它而消失**。
   */
  toolIds?: readonly string[];
}

export interface CapabilityEntry {
  kind: CapabilityKind;
  id: string;
  capability: string;
  availability: CapabilityAvailability;
  provider?: string;
  evidence?: CapabilityEvidence;
  /** 人话的原因（`unavailable` / `unverified` 时给）：为什么是这个状态。 */
  reason?: string;
  cost?: string;
  priority?: number;
  fallback?: string;
}

function declaresImageInput(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  return input.some((value) => typeof value === 'string' && value === 'image');
}

function ledgerRecord(kind: CapabilityKind, id: string, capability: string): CapabilityLedgerRecord | undefined {
  return CAPABILITY_VERIFICATION_LEDGER.find(
    (record) => record.kind === kind && record.id === id && record.capability === capability,
  );
}

/** 账本里的工具记录 → 注册表条目（账本怎么说就怎么是）。 */
function ledgerToolEntries(): CapabilityEntry[] {
  return CAPABILITY_VERIFICATION_LEDGER.filter((record) => record.kind === 'tool').map((record) => ({
    kind: 'tool' as const,
    id: record.id,
    capability: record.capability,
    availability: record.availability,
    ...(record.evidence ? { evidence: record.evidence } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  }));
}

/**
 * 建注册表：账本事实 + 目录推导。
 *
 * 模型三态推导（每个目录模型三条能力）：
 * · `chat`：账本有实测 ⇒ `available`；目录里有、没实测 ⇒ `unverified`；
 * · `vision`：目录声明 image **且**账本有实测 ⇒ `available`；声明了没实测 ⇒ `unverified`；
 *   没声明 ⇒ `unavailable`（"其余模型视觉不可用"）；
 * · `search`：在 relay 白名单内且有实测 ⇒ `available`；白名单内无实测 ⇒ `unverified`；
 *   白名单外 ⇒ `unavailable`（enable_search 对它根本没开）。
 */
export function buildCapabilityRegistry(input?: CapabilityRegistryInput): CapabilityEntry[] {
  const entries: CapabilityEntry[] = [];
  const seen = new Set<string>();
  for (const model of input?.models ?? []) {
    if (!model || typeof model.id !== 'string' || model.id.length === 0) continue;
    if (seen.has(model.id)) continue;
    seen.add(model.id);
    const provider = typeof model.provider === 'string' ? model.provider : undefined;

    const chat = ledgerRecord('model', model.id, 'chat');
    entries.push({
      kind: 'model',
      id: model.id,
      capability: 'chat',
      availability: chat?.availability ?? 'unverified',
      ...(provider ? { provider } : {}),
      ...(chat?.evidence ? { evidence: chat.evidence } : {}),
      ...(chat?.availability === undefined ? { reason: '目录里有这个模型，但还没有它的实测记录' } : {}),
    });

    const vision = ledgerRecord('model', model.id, 'vision');
    const visionDeclared = declaresImageInput(model.input);
    if (visionDeclared && vision?.availability === 'available') {
      entries.push({
        kind: 'model',
        id: model.id,
        capability: 'vision',
        availability: 'available',
        ...(provider ? { provider } : {}),
        ...(vision.evidence ? { evidence: vision.evidence } : {}),
      });
    } else if (visionDeclared) {
      entries.push({
        kind: 'model',
        id: model.id,
        capability: 'vision',
        availability: 'unverified',
        ...(provider ? { provider } : {}),
        reason: '目录声明了图片输入，但还没有实测记录',
      });
    } else {
      entries.push({
        kind: 'model',
        id: model.id,
        capability: 'vision',
        availability: 'unavailable',
        ...(provider ? { provider } : {}),
        reason: '目录没有图片输入声明（视觉能力不可用）',
      });
    }

    const searchAllowed = RELAY_SEARCH_ENABLED_MODEL_IDS.includes(model.id);
    const search = ledgerRecord('model', model.id, 'search');
    if (!searchAllowed) {
      entries.push({
        kind: 'model',
        id: model.id,
        capability: 'search',
        availability: 'unavailable',
        ...(provider ? { provider } : {}),
        reason: 'relay 联网搜索（enable_search）白名单外，对该模型未开启',
      });
    } else if (search?.availability === 'available') {
      entries.push({
        kind: 'model',
        id: model.id,
        capability: 'search',
        availability: 'available',
        ...(provider ? { provider } : {}),
        ...(search.evidence ? { evidence: search.evidence } : {}),
      });
    } else {
      entries.push({
        kind: 'model',
        id: model.id,
        capability: 'search',
        availability: 'unverified',
        ...(provider ? { provider } : {}),
        reason: '白名单内、但还没有实测记录',
      });
    }
  }
  entries.push(...ledgerToolEntries());
  entries.push(...inventoryToolEntries(input?.toolIds ?? []));
  return entries;
}

/**
 * 工具清单里**账本没记录过**的条目 ⇒ `unverified`（"存在 ≠ 验证过"，硬规则 1）。
 *
 * ⚠️ 这是**加法**（不是过滤）：账本里 `unavailable` 的工具（image/video 生成）即使
 *    不在清单里也保留在注册表里（`ledgerToolEntries`）——"它不在清单里"与"我们不许
 *    暴露它"是两件事，后者要一直有据可查（deny 名单就从那里出发）。
 * ⚠️ 账本记录过的 id 在这里**直接跳过**：它们已由 `ledgerToolEntries` 按账本逐条产出，
 *    这里再产一份就是同一个能力两条记录（第一处与第二处的状态还会各自漂移）。
 */
function inventoryToolEntries(toolIds: readonly string[]): CapabilityEntry[] {
  const seen = new Set<string>();
  const entries: CapabilityEntry[] = [];
  for (const id of toolIds) {
    if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue;
    seen.add(id);
    const known = CAPABILITY_VERIFICATION_LEDGER.some((record) => record.kind === 'tool' && record.id === id);
    if (known) continue;
    entries.push({
      kind: 'tool',
      id,
      capability: 'tool',
      availability: 'unverified',
      reason: '在工具清单里，但未纳入验证账本（存在 ≠ 验证过）',
    });
  }
  return entries;
}

export function findCapabilityEntry(
  registry: readonly CapabilityEntry[],
  query: { kind: CapabilityKind; id: string; capability: string },
): CapabilityEntry | undefined {
  return registry.find(
    (entry) => entry.kind === query.kind && entry.id === query.id && entry.capability === query.capability,
  );
}

/** 模型 id 列表 → 只留对话能力 `available` 的那些（能力边界提示词要用它列"可用模型"）。 */
export function availableChatModelIds(registry: readonly CapabilityEntry[]): string[] {
  return registry
    .filter((entry) => entry.kind === 'model' && entry.capability === 'chat' && entry.availability !== 'unavailable')
    .map((entry) => entry.id);
}

/**
 * 必须进 `tools.deny` 的工具 id（**deny 名单的单一真源**）。
 *
 * 由 `main/runtime/state-config.ts` 与 `main/runtime/workflow-tools.ts` 消费；
 * 与 memory / canvas / web 那些名字合并成同一个并集、同一套存量自愈判据。
 * ⚠️ `voice` **不在这里**：它不是运行时注册的工具名，写进 `tools.deny` 没有意义
 *    （deny 收的是工具名）。它的"不支持"由能力边界提示词承担。
 * 账本里对应的 `unavailable` 行必须与这份名单逐字一致（测试钉住）。
 */
export function plannerDeniedToolIds(): readonly string[] {
  return [...PLANNER_UNAVAILABLE_TOOL_IDS];
}
