# 请求的助手不在本机时拒绝并说明 —— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 请求的助手不在本机目录里时，不再静默换成默认助手；改为落到通用欢迎屏并说明，三处入口都发，且不许把任务发给一个不存在的助手。

**Architecture:** 判据收进一个纯函数（`lib/requested-agent.ts`），三处消费者共用一份实现。`useGatewaySelector` 从「静默替换」改成「拒绝」（`effectiveAgentId` 返回空串），`WelcomeScreen` 的写回 effect 因此早返回 ⇒ `pendingNewTask` 不再被改写 ⇒ 重挂载消失。发送侧在 core 的 `commitPendingTask` 保守拒绝。

**Tech Stack:** TypeScript / React 19 / zustand / vitest（jsdom）/ i18next（9 语言）

**依据 spec:** `docs/superpowers/specs/2026-09-24-missing-agent-refusal-design.md`

**纪律（本仓踩出来的）：**

- 客户端测试放 `<package>/test/`；跑单文件先 `cd packages/desktop` 或 `packages/core`。
- 每刀 TDD：RED → GREEN → **变异验证** → 门禁 → 独立提交。
- `pnpm check` 前 `export PATH="/d/go-toolchain/go/bin:$PATH"`；本工作树 `format:check` 是**真信号**。
- 提交文案**英文**；临时文件不写进仓库、不 `git add -A`。
- ⛔ 不动 `stable` / `latest.yml` / `/updates`；不推远端（等用户发话）。

---

### Task 1: 判据纯函数

**Files:**

- Create: `packages/desktop/src/renderer/lib/requested-agent.ts`
- Test: `packages/desktop/test/requested-agent.test.ts`

- [x] **Step 1: 写失败的测试**

```ts
// packages/desktop/test/requested-agent.test.ts
import { describe, expect, it } from 'vitest';
import { resolveRequestedAgent } from '../src/renderer/lib/requested-agent';

const loaded = { agents: [{ id: 'main' }] };

describe('resolveRequestedAgent', () => {
  it('目录还没拉回来时判 loading，不许判缺失', () => {
    expect(resolveRequestedAgent('team-agent-x', undefined)).toBe('loading');
  });

  it('目录已加载且请求在里面时判 ok', () => {
    expect(resolveRequestedAgent('main', loaded)).toBe('ok');
  });

  it('没有请求时判 ok（用默认助手）', () => {
    expect(resolveRequestedAgent('', loaded)).toBe('ok');
    expect(resolveRequestedAgent(undefined, loaded)).toBe('ok');
  });

  it('目录已加载、请求非空且不在里面时判 missing', () => {
    expect(resolveRequestedAgent('team-agent-x', loaded)).toBe('missing');
  });

  it('目录已加载但为空时，非空请求判 missing', () => {
    expect(resolveRequestedAgent('team-agent-x', { agents: [] })).toBe('missing');
  });
});
```

- [x] **Step 2: 跑测试确认失败**

```bash
cd packages/desktop && ../../node_modules/.bin/vitest run test/requested-agent.test.ts
```

Expected: FAIL —— 模块不存在。

- [x] **Step 3: 写实现**

```ts
// packages/desktop/src/renderer/lib/requested-agent.ts

/**
 * 请求的助手在本机目录里吗？
 *
 * 三种结果，`loading` 那一种是**硬要求**：
 * 目录还没拉回来时**不许**判缺失，否则「正在拉目录」会被说成「这个助手不在本机」——
 * 那是用新的误报换掉旧的静默。见 `IdentityCenter/index.tsx:66-67` 那条既有注释。
 *
 * 判据收在这里是为了三处消费者（欢迎屏 / 左栏切换器 / 身份中心）共用一份实现。
 */
export type RequestedAgentState = 'ok' | 'missing' | 'loading';

export function resolveRequestedAgent(
  requestedAgentId: string | undefined,
  catalog: { agents: readonly { id: string }[] } | undefined,
): RequestedAgentState {
  if (!catalog) return 'loading';
  const requested = requestedAgentId ?? '';
  if (!requested) return 'ok';
  return catalog.agents.some((agent) => agent.id === requested) ? 'ok' : 'missing';
}
```

- [x] **Step 4: 跑测试确认通过**

```bash
cd packages/desktop && ../../node_modules/.bin/vitest run test/requested-agent.test.ts
```

Expected: 5 passed。

- [x] **Step 5: 变异验证（每条断言都要能被变红）**

逐个改实现、跑测试、确认**指定那条**红，然后还原（用 `git checkout` 或手改回，**还原后必须逐字节相同**）：

1. 删掉 `if (!catalog) return 'loading';` ⇒ 「loading」那条红。
2. `requested ? ... : ...` 反过来写 ⇒ 「没有请求」那条红。
3. `catalog.agents.some(...)` 改成恒 `true` ⇒ 「missing」两条红。

- [x] **Step 6: 提交**

```bash
git add packages/desktop/src/renderer/lib/requested-agent.ts packages/desktop/test/requested-agent.test.ts
git commit -m "feat(agents): decide whether a requested assistant exists on this machine"
```

---

### Task 2: `useGatewaySelector` 不再静默替换

**Files:**

- Modify: `packages/desktop/src/renderer/hooks/useGatewaySelector.ts`
- Test: `packages/desktop/test/gateway-selector-refusal.test.tsx`

- [x] **Step 1: 写失败的测试**（跑**真 hook**，不用 `vi.mock`）

```tsx
// packages/desktop/test/gateway-selector-refusal.test.tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { useGatewaySelector } from '../src/renderer/hooks/useGatewaySelector';
import { useUiStore } from '../src/renderer/platform';

let captured: ReturnType<typeof useGatewaySelector> | null = null;

function Harness({ initialAgentId }: { initialAgentId: string }) {
  captured = useGatewaySelector({ initialGatewayId: 'gw-1', initialAgentId });
  return null;
}

function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(node));
  return { unmount: () => act(() => root.unmount()) };
}

describe('useGatewaySelector 拒绝不在本机的请求', () => {
  beforeEach(() => {
    captured = null;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    (window as unknown as { clawwork: unknown }).clawwork = {};
  });

  it('目录已加载时，请求缺失 ⇒ effectiveAgentId 空、missingRequestedAgentId 有值', () => {
    useUiStore.setState({
      gatewayInfoMap: { 'gw-1': { id: 'gw-1' } } as never,
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: { 'gw-1': { agents: [{ id: 'main' }] as never, defaultId: 'main' } },
    });
    const view = render(<Harness initialAgentId="team-agent-x" />);
    expect(captured?.missingRequestedAgentId).toBe('team-agent-x');
    expect(captured?.effectiveAgentId).toBe('');
    view.unmount();
  });

  it('目录还没加载时不许判缺失（行为与今天一字不变）', () => {
    useUiStore.setState({
      gatewayInfoMap: { 'gw-1': { id: 'gw-1' } } as never,
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: {},
    });
    const view = render(<Harness initialAgentId="team-agent-x" />);
    expect(captured?.missingRequestedAgentId).toBeNull();
    expect(captured?.effectiveAgentId).toBe('');
    view.unmount();
  });

  it('请求在目录里 ⇒ 原样生效，不判缺失', () => {
    useUiStore.setState({
      gatewayInfoMap: { 'gw-1': { id: 'gw-1' } } as never,
      defaultGatewayId: 'gw-1',
      agentCatalogByGateway: {
        'gw-1': { agents: [{ id: 'main' }, { id: 'rongying-video' }] as never, defaultId: 'main' },
      },
    });
    const view = render(<Harness initialAgentId="rongying-video" />);
    expect(captured?.missingRequestedAgentId).toBeNull();
    expect(captured?.effectiveAgentId).toBe('rongying-video');
    view.unmount();
  });
});
```

⚠️ Step 1 的两个细节执行时先核（别照抄猜）：
`gatewayInfoMap` 的元素类型（`GatewayInfo` 必填字段），以及 `useUiStore` 是否从 `../src/renderer/platform` 导出
（`WelcomeScreen` 用的是 `@/stores/uiStore`，测试里优先用**同一个**来源）。

- [x] **Step 2: 跑测试确认失败**

```bash
cd packages/desktop && ../../node_modules/.bin/vitest run test/gateway-selector-refusal.test.tsx
```

Expected: 第一条 FAIL（`missingRequestedAgentId` 是 `undefined`、`effectiveAgentId` 是 `'main'`）；后两条**也应该先红**（字段还不存在）。

- [x] **Step 3: 改实现**

`useGatewaySelector.ts` 三处：

```ts
import { resolveRequestedAgent } from '@/lib/requested-agent';
```

结果接口加一个字段：

```ts
interface UseGatewaySelectorResult {
  // …原有字段…
  /** 仅当**目录已加载**且请求的助手不在里面时非空。参见 `lib/requested-agent.ts`。 */
  missingRequestedAgentId: string | null;
}
```

替换 `effectiveAgentId` 那段（原 `:41-45`）：

```ts
const defaultAgentId = gwAgents?.defaultId ?? agentCatalog[0]?.id ?? '';
const requestedState = useMemo(() => resolveRequestedAgent(selectedAgentId, gwAgents), [gwAgents, selectedAgentId]);
const missingRequestedAgentId = requestedState === 'missing' ? selectedAgentId : null;
const effectiveAgentId = useMemo(
  () =>
    requestedState === 'missing'
      ? ''
      : agentCatalog.some((agent) => agent.id === selectedAgentId)
        ? selectedAgentId
        : defaultAgentId,
  [agentCatalog, defaultAgentId, requestedState, selectedAgentId],
);
```

返回值里加上 `missingRequestedAgentId,`。

**为什么不引入新闪烁**：目录未加载 ⇒ `requestedState === 'loading'` ⇒ 走老分支，
而 `agentCatalog` 为空 ⇒ `defaultAgentId` 是 `''` ⇒ 与今天一模一样。
只有「目录已加载且请求缺失」这一种情况行为变了。

- [x] **Step 4: 跑测试确认通过**

```bash
cd packages/desktop && ../../node_modules/.bin/vitest run test/gateway-selector-refusal.test.tsx
```

Expected: 3 passed。

- [x] **Step 5: 变异验证**

1. 把 `requestedState === 'missing' ? '' : …` 改回 `… ? selectedAgentId : defaultAgentId`（即恢复静默替换）⇒ 第一条红。
2. 把 `resolveRequestedAgent` 的 `loading` 分支改成返回 `'missing'` ⇒ 第二条红。
3. `missingRequestedAgentId` 改成恒 `null` ⇒ 第一条红。

- [x] **Step 6: 提交**

```bash
git add packages/desktop/src/renderer/hooks/useGatewaySelector.ts packages/desktop/test/gateway-selector-refusal.test.tsx
git commit -m "fix(agents): refuse a requested assistant instead of swapping in the default"
```

---

### Task 3: 文案（9 语言）+ 提示组件 + 欢迎屏

**Files:**

- Modify: `packages/desktop/src/renderer/i18n/locales/{de,en,es,fr,ja,ko,pt,zh-TW,zh}.json`
- Create: `packages/desktop/src/renderer/components/AgentMissingNotice.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`
- Modify: `packages/desktop/test/welcome-screen.test.tsx`（**拆掉假 hook**）

- [x] **Step 1: 加文案（9 个文件，key 完全一致）**

`agent` 段下新增四个键。中文（`zh.json`）：

```json
"missingTitle": "「{{agentId}}」这个助手不在本机",
"missingBody": "它可能只装在另一台电脑上。换一个助手就能继续，或者去团队页看看。",
"missingSwitchToCompass": "换用罗盘助手",
"missingOpenTeams": "去团队页"
```

其余 8 个文件按同义翻译；`en.json` 示例：

```json
"missingTitle": "\"{{agentId}}\" is not on this machine",
"missingBody": "It may only be installed on another computer. Pick another assistant to continue, or check the teams page.",
"missingSwitchToCompass": "Use the compass assistant",
"missingOpenTeams": "Open teams"
```

⚠️ 改完跑 `node scripts/sort-i18n.mjs`（若该脚本会重排）并确认 `check:i18n` 绿。

- [x] **Step 2: 写提示组件**

```tsx
// packages/desktop/src/renderer/components/AgentMissingNotice.tsx
import { useTranslation } from 'react-i18next';
import InlineNotice from '@/components/semantic/InlineNotice';

interface AgentMissingNoticeProps {
  agentId: string;
  /** 给了才渲染按钮——左栏太窄，只放说明不放按钮。 */
  onSwitchAssistant?: () => void;
  onOpenTeams?: () => void;
  className?: string;
}

export default function AgentMissingNotice({
  agentId,
  onSwitchAssistant,
  onOpenTeams,
  className,
}: AgentMissingNoticeProps) {
  const { t } = useTranslation();

  return (
    <InlineNotice tone="warning" className={className}>
      <p className="type-label">{t('agent.missingTitle', { agentId })}</p>
      <p className="mt-0.5 text-[var(--text-secondary)]">{t('agent.missingBody')}</p>
      {onSwitchAssistant || onOpenTeams ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onSwitchAssistant ? (
            <button
              type="button"
              onClick={onSwitchAssistant}
              className="type-label inline-flex items-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent-dim)] px-4 py-2.5 text-[var(--accent)] transition-colors focus-visible:outline-none glow-focus"
            >
              {t('agent.missingSwitchToCompass')}
            </button>
          ) : null}
          {onOpenTeams ? (
            <button
              type="button"
              onClick={onOpenTeams}
              className="type-label inline-flex items-center gap-2 rounded-xl border border-[var(--border)] px-4 py-2.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none glow-focus"
            >
              {t('agent.missingOpenTeams')}
            </button>
          ) : null}
        </div>
      ) : null}
    </InlineNotice>
  );
}
```

⚠️ 上面两套类名是照 `WelcomeScreen.tsx:145-150` 的助手按钮**抄来的**（主/次两个变体）。
执行时若那处已改，以**当时**的类名为准，不要凭空发明样式。

- [x] **Step 3: 写欢迎屏的失败测试**

⚠️ 先**拆掉** `welcome-screen.test.tsx:64-79` 那个假 hook（它把缺陷抄进了夹具），
再补一条真 hook 的用例。夹具要提供真实 `uiStore` 状态（`agentCatalogByGateway`、`defaultGatewayId`）。

```tsx
it('⭐ 请求的助手不在目录里时：提示出现、不冒充所选助手、pending 不被改写', () => {
  useUiStore.setState({
    defaultGatewayId: 'gw-1',
    agentCatalogByGateway: { 'gw-1': { agents: [{ id: 'main' }] as never, defaultId: 'main' } },
  });
  mocks.pendingNewTask = { gatewayId: 'gw-1', agentId: 'team-agent-x' };

  const { container, unmount } = render(<WelcomeScreen … />);

  expect(container.textContent).toContain('agent.missingTitle');
  expect(container.textContent).not.toContain('assistantWorkspaces.compass.description');
  expect(mocks.setPending).not.toHaveBeenCalledWith(
    expect.objectContaining({ agentId: 'main' }),
  );
  unmount();
});
```

- [x] **Step 4: 跑测试确认失败** → `cd packages/desktop && ../../node_modules/.bin/vitest run test/welcome-screen.test.tsx`，Expected: 新用例 FAIL。

- [x] **Step 5: 改 `WelcomeScreen.tsx`**

1. 从 hook 解构出 `missingRequestedAgentId`（`:49-53`）；
2. 取 `const setMainView = useUiStore((s) => s.setMainView);`
3. 在通用欢迎屏那个分支（`:122-127`）的 `<section>` 里、`<h1>` 之前插：

```tsx
{
  missingRequestedAgentId ? (
    <AgentMissingNotice
      agentId={missingRequestedAgentId}
      onSwitchAssistant={() => handleSelectAgent('main')}
      onOpenTeams={() => setMainView('teams')}
      className="mb-4 w-full text-left"
    />
  ) : null;
}
```

`handleSelectAgent` 已有（`:90-108`）：它会同时改选择、改 pending、清预设标签，正是出口要的四步。
**不需要**为「不再写回 pending」写任何代码 —— `:65` 那句 `if (!selectedGwId || !effectiveAgentId) return;`
在拒绝态（`effectiveAgentId === ''`）自动早返回。

- [x] **Step 6: 跑测试确认通过** → 同一个命令，Expected: 全绿（含既有的 12 条）。

- [x] **Step 7: 变异验证**

1. 把「不再写回」破坏掉（`effectiveAgentId || defaultAgentId`）⇒ 新用例红。
2. 删掉欢迎屏里的 `<AgentMissingNotice>` ⇒ 新用例红。

- [x] **Step 8: 提交**

```bash
git add -A packages/desktop/src/renderer/i18n/locales packages/desktop/src/renderer/components/AgentMissingNotice.tsx packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx packages/desktop/test/welcome-screen.test.tsx
git commit -m "feat(agents): explain a missing assistant on the welcome screen and offer two ways out"
```

---

### Task 4: 左栏切换器 + 身份中心

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/LeftNav/index.tsx:92-94,170-177`
- Modify: `packages/desktop/src/renderer/layouts/IdentityCenter/index.tsx:69-76`
- Test: `packages/desktop/test/missing-agent-surfaces.test.tsx`

- [x] **Step 1: 写失败的测试**（两条按名断言：左栏不再把默认助手冒充成选中；身份中心拒绝并提示）

- [x] **Step 2: 跑测试确认失败**

- [x] **Step 3: 改实现**

LeftNav：

```tsx
const agentCatalogEntry = useUiStore((s) => s.agentCatalogByGateway[selectedGwId]);
const selectedAgentId = useUiStore((s) => s.selectedAgentByGateway[selectedGwId] ?? '');
const requestedState = resolveRequestedAgent(selectedAgentId, agentCatalogEntry);
const currentAgentId =
  requestedState === 'missing' ? '' : selectedAgentId || defaultAgentId || agentCatalog[0]?.id || '';
```

并在 `assistantSlot` 里 `AssistantSwitcher` **后面**加（**不给按钮**：这一列太窄，且 ui-contract 对左栏要求
`ToolbarButton|EmptyState`；纯说明不撞那条规则）：

```tsx
{
  requestedState === 'missing' ? <AgentMissingNotice agentId={selectedAgentId} className="mx-3 mt-1" /> : null;
}
```

IdentityCenter：`applyPersona` 里**先判再切**（目录未加载时**不判**，守那条既有注释）：

```tsx
const catalogEntry = useUiStore((s) => s.agentCatalogByGateway[gatewayId ?? '']);
const [missingAgentId, setMissingAgentId] = useState<string | null>(null);

const applyPersona = useCallback((): boolean => {
  if (!gatewayId) {
    toast.error(t('identity.applyFailed'));
    return false;
  }
  if (resolveRequestedAgent(officeAssistantId, catalogEntry) === 'missing') {
    setMissingAgentId(officeAssistantId);
    return false;
  }
  setMissingAgentId(null);
  selectAgent(officeAssistantId);
  return true;
}, [gatewayId, officeAssistantId, catalogEntry, selectAgent, t]);
```

并在按钮下方渲染（`setMainView` 用 `useUiStore((s) => s.setMainView)` 取）：

```tsx
{
  missingAgentId ? (
    <AgentMissingNotice
      agentId={missingAgentId}
      onSwitchAssistant={() => applyPersona()}
      onOpenTeams={() => setMainView('teams')}
      className="mt-3"
    />
  ) : null;
}
```

⚠️ `onSwitchAssistant={() => applyPersona()}` 在 `missingAgentId` 存在时会**再次**命中 missing 分支 ⇒ 死循环。
执行时改成「换用罗盘助手」的直给动作：`selectAgent(ASSISTANT_ID_BY_WORKSPACE.compass)` 或 `'main'`
（**先核** `ASSISTANT_ID_BY_WORKSPACE` 里罗盘那一项的键名）。出口必须是**能走通**的那条。

- [x] **Step 4: 跑测试确认通过**

- [x] **Step 5: 变异验证**：左栏那处把 `requestedState === 'missing' ? '' : …` 恢复成旧写法 ⇒ 左栏用例必须红。

- [x] **Step 6: 提交**

```bash
git commit -m "feat(agents): surface the missing-assistant notice in the sidebar and identity centre"
```

---

### Task 5: 发送侧在 core 保守拒绝

**Files:**

- Modify: `packages/core/src/stores/task-store.ts:161-166`（+ 导出错误类型）
- Modify: `packages/desktop/src/renderer/components/ChatInput/useChatSend.ts:267-275`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`（`errors.agentMissing`）
- Test: `packages/core/test/task-store-unknown-agent.test.ts`

- [x] **Step 1: 写失败的测试**（三个方向）

```ts
it('目录为空（可能只是还没加载）时不拒绝 —— 行为与今天一致', () => {
  /* getAgentCatalog 返回 {agents: [], defaultId: null}，pending.agentId='x' ⇒ 仍建出任务 */
});
it('目录确有内容且不含该 id 时拒绝，且不建出任务', () => {
  /* expect(() => commit).toThrow(UnknownAgentError) 且 tasks 长度不变 */
});
it('目录含该 id 时放行', () => {
  /* 正常建出任务 */
});
```

- [x] **Step 2: 跑测试确认失败** → `cd packages/core && ../../node_modules/.bin/vitest run test/task-store-unknown-agent.test.ts`

- [x] **Step 3: 改实现**

`task-store.ts` 顶部导出：

```ts
/**
 * 请求的助手不在**已加载**的目录里。
 *
 * 判据刻意保守：`getAgentCatalog` 把「目录没加载」与「目录为空」塌成同一个形状
 * `{agents: [], defaultId: null}`，所以只有在 `agents.length > 0`（确已加载）时才拒绝 ——
 * 否则「目录还没回来就发送」会被误伤。
 */
export class UnknownAgentError extends Error {
  readonly code = 'unknown-agent';
  constructor(readonly agentId: string) {
    super(`unknown agent: ${agentId}`);
    this.name = 'UnknownAgentError';
  }
}
```

`commitPendingTask` 在 `if (!agId) throw …` **之后**加：

```ts
const requestedAgentId = pending?.agentId ?? '';
if (
  requestedAgentId &&
  catalog.agents.length > 0 &&
  !catalog.agents.some((agent) => (agent as { id?: unknown }).id === requestedAgentId)
) {
  throw new UnknownAgentError(requestedAgentId);
}
```

并从 core 的入口（`packages/core/src/index.ts`，**执行时核对实际导出点**）导出 `UnknownAgentError`。

`useChatSend.ts` 的 `catch`：

```ts
} catch (error) {
  toast.error(
    error instanceof UnknownAgentError ? t('errors.agentMissing') : t('errors.agentNotResponding'),
  );
  return;
}
```

`errors.agentMissing` 文案（9 语言）。中文：`"这个助手不在本机，换一个助手再发送。"`

⚠️ **执行时必核**：`useTaskMaterials.ts:112` 也直接调 `commitPendingTask()`（无 try/catch）。
新拒绝会从那里抛出去 ⇒ 要么同样分类提示，要么明确接受并登记。**不许漏掉不写。**

- [x] **Step 4: 跑测试确认通过**

- [x] **Step 5: 变异验证**：去掉 `catalog.agents.length > 0` ⇒ 「目录为空不拒绝」那条红（这是**对照**，必须绿）。

- [x] **Step 6: 提交**

```bash
git commit -m "fix(tasks): refuse to commit a task for an assistant the loaded catalog lacks"
```

---

### Task 6: 门禁 + 账本

- [x] **Step 1: 全量门禁**

```bash
export PATH="/d/go-toolchain/go/bin:$PATH"
cd "D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/fix-portable-update-gaps"
pnpm check
```

Expected: `RC=0`。RC≠0 时**先看是不是本地产物**（`format:check` 在本工作树是真信号）。

- [x] **Step 2: 记读数**

把每条套件的实际数字（desktop / core / shared / pwa passed）写进本计划末尾的「完成记录」。

- [x] **Step 3: 提交账本**

```bash
git commit -m "docs(agents): record the missing-assistant refusal readings"
```

---

## 完成记录（真实读数，2026-09-24）

| 项           | 读数                                                                                                                                        |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Task 1 套件  | `test/requested-agent.test.ts` **5 passed**                                                                                                 |
| Task 2 套件  | `test/gateway-selector-refusal.test.tsx` **3 passed**                                                                                       |
| Task 3 套件  | `test/welcome-screen.test.tsx` **15 passed**（原 14 + 新核心用例 1）                                                                        |
| Task 4 套件  | `test/left-nav-missing-agent.test.tsx` **2** + `test/identity-center.test.tsx` **15**（原 13 + 2）+ `test/assistant-switcher.test.tsx` 全绿 |
| Task 5 套件  | `packages/core/test/task-store-unknown-agent.test.ts` **4** + `test/send-refusal.test.ts` **3**                                             |
| 变异电池     | **16 条变异全部命中 + 9 条对照全 0 红**；每一次都核过「还原逐字节相同」                                                                     |
| `pnpm check` | **RC=0** · desktop **287 文件 / 3030 passed / 2 skipped** · core 39/**662** · shared 10/**124** · pwa 4/**61**                              |

提交：`75b99e66` → `742c0e36` → `ab051c5a` → `ae11bbe4` → `4d3b8aca`（每个 Task 一刀，未推）。

## 执行期发现（计划与现实的出入，逐条记）

1. **计划里的 vitest 路径是错的** —— 本工作树里在 `packages/<pkg>/node_modules/.bin/vitest`，
   不是 `../../node_modules/.bin/vitest`（根 `node_modules/.bin` 里**没有** vitest）。
2. **`pnpm` 也不在 `node_modules/.bin`** —— 用 PATH 上的（11.21.0）。
   同一类坑：`cmd | tail; echo RC=$?` 读到的是 **tail 的退出码**，必须 `set -o pipefail` 或读 `PIPESTATUS`。
3. ⭐ **真正的替换点在 `AssistantSwitcher`，不只是 LeftNav**（计划只点了 LeftNav）：
   切换器自己就有 `?? agents[0]`。**计划外新增一处改动**，否则左栏那一半的 D3 是假的。
4. ⚠️ **Task 1 与 Task 4 没有单独跑 RED**：Task 1 的测试与实现一次写入；
   Task 4 是先改实现后补测试。**用变异电池补证** —— 每条断言都验过"能被变红"，
   其中"恢复静默替换"那条变异**直接复现了原缺陷**。**但这不是 TDD 的原始形态，记一笔。**
5. ⭐ **变异电池抓到我自己的 no-op**：我在 LeftNav 加的 `missing ? '' : …` 三元两个分支
   **恒等**（缺失时 `selectedAgentId` 本就非空，`||` 压根不回落）⇒ 已删除，并把
   「真正的替换点在哪」写进注释，免得后人再修错地方。
6. ⚠️ **`welcome-screen.test.tsx` 有 5 条既有用例原本靠静默替换才成立**
   （fixture 的 onboarding profile 点名了一个**不在夹具目录里**的助手）。
   ⇒ 改成 profile 不点名（`useCases: []` ⇒ 首选就是目录里的 `main`），
   **它们各自的主体断言一条没改**。这正是 D3 说的"有意的涟漪"。
7. **夹具的 `t` 之前忽略插值** ⇒ 「提示里点名了哪个助手」只能绑到 key、绑不住**值**。
   已改成带插值时显示取值（`key({"agentId":"…"})`），新用例因此能断言 `team-agent-x` 真的出现。
8. **core 的 `getAgentCatalog` 确实把"没加载/空"塌成同一形状**（计划已预见并写成保守判据；
   实测确认，且"目录为空不拒绝"有对照用例钉住）。
9. **`useTaskMaterials.ensureTaskId` 确实在两个调用点的 `try` 之外**（计划标了"必核"）。
   ⇒ 改成返回 `string | null`，只吞 `UnknownAgentError`、其它异常照旧抛出去。
10. **`errors.agentNotResponding` 那句原本没有任何测试守着** ⇒ 抽成 `lib/send-refusal.ts`
    纯函数（本仓既有习语，见 `lib/agent-switch.ts`）并加 3 条测试；否则那个三元的两种分支
    没有任何钉子。

## 独立复核与修复（2026-09-24）

两个**独立复核者**（只读、看不到实现者的会话历史、各带一份"去证伪"的指令）并行跑：
**A · spec 合规**（按 spec §1–§6 逐条对实现，被明确要求去证伪"未加载路径与旧行为逐字节相同"这条主张、
并穷举 `commitPendingTask()`/`createTask()` 的每一个调用点）与 **B · 代码质量（对抗式）**
（对**每一条新测试**问"改哪一行能让它绿着但缺陷回来"）。

**两份都是 Critical 0 条，判词 `with fixes`。** A 还独立跑过 3 条变异来证伪 spec 的主张
（恢复静默替换 / 把 loading 判成 missing / 把 `missing ? '' : …` 加回 LeftNav），三条都让对应用例变红。

### 复核抓到的问题（都不是我自己发现的）

| 编号    | 复核者        | 问题                                                                                                 | 处置                                                                                                   |
| ------- | ------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- |
| **I-1** | A、B 各自独立 | 引导画像的**推荐**被当成"用户点名要的助手"，新机器装预置助手期间误报「不在本机」（B 实测复现）       | **修**：hook 多收 `requestedAgentId`，只有它参与拒绝（`WelcomeScreen` 只传 `pendingNewTask?.agentId`） |
| **I-2** | B             | 渲染层判"已加载但为空 ⇒ missing"，core 因形状塌陷不拒 ⇒ 同一状态两边结论相反，幽灵发送口在窄路上开着 | **修**：`getAgentCatalog` 返回 `                                                                       | undefined`（desktop/pwa 各一行），core 判据改**精确版** |
| **I-3** | B             | 发送路两处新逻辑**没有任何测试绑住**（B 给了两条能存活下来的单行变异）                               | **修**：`use-chat-send` / `use-task-materials` 各补用例                                                |
| **A-1** | A             | **PWA 那条路**把两句话压成一句（`chat-composer.resolveTask` 裸 catch）                               | **修**：规则收到 core 的 `describeSendRefusal` 一处，三条调用方共用                                    |
| **A-2** | A             | 我写在 `LeftNav` 的注释**是错的**：把 `missing ? '' : …` 说成 no-op，而它会让切换器冒充罗盘          | **修**：注释改写为正确推理                                                                             |
| M-1     | B             | `IdentityCenter` 的 docblock 还写着"**不做**在不在目录里的检查"，与新代码矛盾                        | 修                                                                                                     |
| M-2     | B             | 罗盘自己也不在目录里时，"换用罗盘助手"是死胡同按钮                                                   | 修：按目录决定渲染                                                                                     |
| M-3     | B             | core 拿 id 走强转，`null` 条目会抛 `TypeError` 逃出去                                                | 修：dep 类型收成 `{ id: string }[]`，强转整个消失                                                      |
| M-4     | B             | core 测试桩忽略自己的入参（读错网关也能全绿）                                                        | 修：桩用上 `gatewayId` + 补一例非默认网关                                                              |
| M-5     | B             | 没有用例覆盖"目录刷新后提示**消失**"                                                                 | 修：hook 套件补一例                                                                                    |
| M-6     | B             | 回落换网关时拿新网关的目录去判**旧网关**的请求 ⇒ 把"不在这个网关上"说成"不在本机"                    | **修**：判据前置**网关一致性闸门**，不一致时记 `loading`                                               |
| M-7     | B             | 左栏注释声称"新建任务原样传 id"但没有测试绑住                                                        | 修：补一例点 `[data-action="new-task"]`                                                                |
| M-8     | B             | 左栏套件的 `t` 桩只回 key，绑不住"点名了哪一个"                                                      | 修：桩改成会拼插值                                                                                     |

### ⚠️ 复核也**证伪了我自己的两处东西**（记下来）

1. **我写的注释是错的**（A-2，A 用变异证明）：我以为那个三元两个分支恒等 ⇒ 是 no-op。**no-op 的是我后来改成的那版**；
   最初带空串的那版**不是** no-op —— 它会让切换器落进 `?? agents[0]`、把罗盘冒充成当前助手。我把两版记混了，
   而这条注释会引着后人把空串加回去。已改写。
2. **我为 M-6 写的第一版修复与测试都是空的**：清掉本地选择那行**不可观测**（新网关目录"未加载"时走 loading 路，
   清不清都一样），变异电池当场证伪（R2 未命中）⇒ 撤回那行，改成**判据上的网关一致性闸门**，测试也改成
   "新网关目录**已加载**"这个真会误报的形状。

### 修复后的读数

- 变异电池（本轮修复）：**9 条变异全部命中 + 6 条对照全 0 红**，每次还原逐字节相同。
- core **40 文件 / 670 passed**；desktop 本轮触碰的 7 个套件 **84 passed**。
- 全量 `pnpm check` 见下节。

### 尚未做

- **复核者复验还没做**（本仓规矩：复核 → 修 → **回复核者确认**才算收口）。
- **未推远端**（等用户发话）。
- **行为级真机未验**：真盘 / 真网关下的"团队发起对话"三次点击现场，本刀只到单测与门禁层。
