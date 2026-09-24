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

- [ ] **Step 1: 写失败的测试**

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

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/desktop && ../../node_modules/.bin/vitest run test/requested-agent.test.ts
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 写实现**

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

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/desktop && ../../node_modules/.bin/vitest run test/requested-agent.test.ts
```

Expected: 5 passed。

- [ ] **Step 5: 变异验证（每条断言都要能被变红）**

逐个改实现、跑测试、确认**指定那条**红，然后还原（用 `git checkout` 或手改回，**还原后必须逐字节相同**）：

1. 删掉 `if (!catalog) return 'loading';` ⇒ 「loading」那条红。
2. `requested ? ... : ...` 反过来写 ⇒ 「没有请求」那条红。
3. `catalog.agents.some(...)` 改成恒 `true` ⇒ 「missing」两条红。

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/src/renderer/lib/requested-agent.ts packages/desktop/test/requested-agent.test.ts
git commit -m "feat(agents): decide whether a requested assistant exists on this machine"
```

---

### Task 2: `useGatewaySelector` 不再静默替换

**Files:**

- Modify: `packages/desktop/src/renderer/hooks/useGatewaySelector.ts`
- Test: `packages/desktop/test/gateway-selector-refusal.test.tsx`

- [ ] **Step 1: 写失败的测试**（跑**真 hook**，不用 `vi.mock`）

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

- [ ] **Step 2: 跑测试确认失败**

```bash
cd packages/desktop && ../../node_modules/.bin/vitest run test/gateway-selector-refusal.test.tsx
```

Expected: 第一条 FAIL（`missingRequestedAgentId` 是 `undefined`、`effectiveAgentId` 是 `'main'`）；后两条**也应该先红**（字段还不存在）。

- [ ] **Step 3: 改实现**

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

- [ ] **Step 4: 跑测试确认通过**

```bash
cd packages/desktop && ../../node_modules/.bin/vitest run test/gateway-selector-refusal.test.tsx
```

Expected: 3 passed。

- [ ] **Step 5: 变异验证**

1. 把 `requestedState === 'missing' ? '' : …` 改回 `… ? selectedAgentId : defaultAgentId`（即恢复静默替换）⇒ 第一条红。
2. 把 `resolveRequestedAgent` 的 `loading` 分支改成返回 `'missing'` ⇒ 第二条红。
3. `missingRequestedAgentId` 改成恒 `null` ⇒ 第一条红。

- [ ] **Step 6: 提交**

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

- [ ] **Step 1: 加文案（9 个文件，key 完全一致）**

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

- [ ] **Step 2: 写提示组件**

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

- [ ] **Step 3: 写欢迎屏的失败测试**

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

- [ ] **Step 4: 跑测试确认失败** → `cd packages/desktop && ../../node_modules/.bin/vitest run test/welcome-screen.test.tsx`，Expected: 新用例 FAIL。

- [ ] **Step 5: 改 `WelcomeScreen.tsx`**

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

- [ ] **Step 6: 跑测试确认通过** → 同一个命令，Expected: 全绿（含既有的 12 条）。

- [ ] **Step 7: 变异验证**

1. 把「不再写回」破坏掉（`effectiveAgentId || defaultAgentId`）⇒ 新用例红。
2. 删掉欢迎屏里的 `<AgentMissingNotice>` ⇒ 新用例红。

- [ ] **Step 8: 提交**

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

- [ ] **Step 1: 写失败的测试**（两条按名断言：左栏不再把默认助手冒充成选中；身份中心拒绝并提示）

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 改实现**

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

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 变异验证**：左栏那处把 `requestedState === 'missing' ? '' : …` 恢复成旧写法 ⇒ 左栏用例必须红。

- [ ] **Step 6: 提交**

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

- [ ] **Step 1: 写失败的测试**（三个方向）

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

- [ ] **Step 2: 跑测试确认失败** → `cd packages/core && ../../node_modules/.bin/vitest run test/task-store-unknown-agent.test.ts`

- [ ] **Step 3: 改实现**

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

- [ ] **Step 4: 跑测试确认通过**

- [ ] **Step 5: 变异验证**：去掉 `catalog.agents.length > 0` ⇒ 「目录为空不拒绝」那条红（这是**对照**，必须绿）。

- [ ] **Step 6: 提交**

```bash
git commit -m "fix(tasks): refuse to commit a task for an assistant the loaded catalog lacks"
```

---

### Task 6: 门禁 + 账本

- [ ] **Step 1: 全量门禁**

```bash
export PATH="/d/go-toolchain/go/bin:$PATH"
cd "D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/fix-portable-update-gaps"
pnpm check
```

Expected: `RC=0`。RC≠0 时**先看是不是本地产物**（`format:check` 在本工作树是真信号）。

- [ ] **Step 2: 记读数**

把每条套件的实际数字（desktop / core / shared / pwa passed）写进本计划末尾的「完成记录」。

- [ ] **Step 3: 提交账本**

```bash
git commit -m "docs(agents): record the missing-assistant refusal readings"
```

---

## 完成记录（执行时填真实读数）

| 项           | 读数 |
| ------------ | ---- |
| Task 1 套件  |      |
| Task 2 套件  |      |
| Task 3 套件  |      |
| Task 4 套件  |      |
| Task 5 套件  |      |
| 变异电池     |      |
| `pnpm check` |      |

## 执行期发现（计划与现实的出入，逐条记）

## 独立复核（本仓规矩：每刀双复核）
