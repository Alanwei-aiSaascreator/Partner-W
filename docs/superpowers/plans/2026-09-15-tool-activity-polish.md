# Tool Activity Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace repeated full-size tool cards with a compact, inspectable activity summary and reduce redundant file-system exploration by built-in assistants.

**Architecture:** Preserve the canonical `ToolCall[]` data and introduce a pure renderer-side projection that maps calls into semantic activity groups. Both persisted messages and active streaming turns render the same summary component; the existing `ToolCallCard` remains the deepest technical-detail view. Add shared operating guidance to preset agents without changing gateway protocols or persistence.

**Tech Stack:** React 19, TypeScript, Radix Collapsible, Framer Motion, i18next, Vitest, jsdom.

---

## File structure

- Create `packages/desktop/src/renderer/lib/tool-activity.ts`: deterministic tool-name classification, duration calculation, status aggregation, and grouping.
- Create `packages/desktop/test/tool-activity.test.ts`: pure projection tests.
- Modify `packages/desktop/src/renderer/components/ToolCallSummary.tsx`: compact summary, semantic groups, nested raw details, failure treatment.
- Modify `packages/desktop/src/renderer/components/ToolCallCard.tsx`: accept an optional user-facing label while retaining the raw name.
- Modify `packages/desktop/src/renderer/components/StreamingMessage.tsx`: route every streaming tool collection through the shared summary.
- Create `packages/desktop/test/tool-call-summary.test.tsx`: interaction and failure-state component tests.
- Modify `packages/desktop/src/renderer/i18n/locales/*.json`: summary, group, status, and semantic-action copy with locale parity.
- Modify `packages/desktop/src/renderer/lib/preset-agents.ts`: shared file-exploration constraints.
- Modify `packages/desktop/test/preset-agents.test.ts`: contract regression test.

### Task 1: Build the tool activity projection

**Files:**

- Create: `packages/desktop/src/renderer/lib/tool-activity.ts`
- Create: `packages/desktop/test/tool-activity.test.ts`

- [ ] **Step 1: Write failing classification and grouping tests**

```ts
it('groups repeated file listings and commands into semantic activities', () => {
  const summary = summarizeToolActivity([call('1', 'ls', 'done'), call('2', 'ls', 'done'), call('3', 'exec', 'done')]);
  expect(summary.groups.map((group) => [group.kind, group.calls.length])).toEqual([
    ['listDirectory', 2],
    ['execute', 1],
  ]);
});

it('keeps failed calls separate from successful calls', () => {
  const summary = summarizeToolActivity([call('1', 'ls', 'done'), call('2', 'ls', 'error')]);
  expect(summary.errorCount).toBe(1);
  expect(summary.groups).toHaveLength(2);
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/tool-activity.test.ts`

Expected: FAIL because `summarizeToolActivity` does not exist.

- [ ] **Step 3: Implement the projection**

```ts
export type ToolActivityKind =
  | 'listDirectory'
  | 'readFile'
  | 'search'
  | 'execute'
  | 'writeFile'
  | 'browseWeb'
  | 'other';

export interface ToolActivityGroup {
  key: string;
  kind: ToolActivityKind;
  status: ToolCall['status'];
  calls: ToolCall[];
}

export interface ToolActivitySummaryModel {
  totalCount: number;
  completedCount: number;
  runningCount: number;
  errorCount: number;
  durationMs: number | null;
  groups: ToolActivityGroup[];
}

export function summarizeToolActivity(toolCalls: ToolCall[]): ToolActivitySummaryModel {
  // Classify each call, group by semantic kind + status, and aggregate counts/duration.
}
```

Classification must recognize `ls`/directory listing, read, search/find/rg, exec/shell, write/patch, and browser/web names using normalized lowercase tokens. Unknown names map to `other`.

- [ ] **Step 4: Run the pure tests and confirm GREEN**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/tool-activity.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/lib/tool-activity.ts packages/desktop/test/tool-activity.test.ts
git commit -m "feat(tools): summarize tool activity"
```

### Task 2: Render a compact grouped summary

**Files:**

- Modify: `packages/desktop/src/renderer/components/ToolCallSummary.tsx`
- Modify: `packages/desktop/src/renderer/components/ToolCallCard.tsx`
- Create: `packages/desktop/test/tool-call-summary.test.tsx`

- [ ] **Step 1: Write failing component tests**

```tsx
it('shows one collapsed summary for ten successful calls', () => {
  const { container } = render(<ToolCallSummary toolCalls={tenCalls} />);
  expect(screen.getByTestId('tool-activity-summary')).toBeTruthy();
  expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(0);
});

it('groups repeated calls after expansion', () => {
  click(screen.getByTestId('tool-activity-summary'));
  expect(screen.getByText('toolActivity.actions.listDirectory')).toBeTruthy();
  expect(screen.getByText('× 8')).toBeTruthy();
  expect(screen.getByText('toolActivity.actions.execute')).toBeTruthy();
  expect(screen.getByText('× 2')).toBeTruthy();
});

it('announces failures without opening raw results', () => {
  const { container } = render(<ToolCallSummary toolCalls={callsWithFailure} />);
  expect(container.textContent).toContain('chatMessage.toolCallSummaryWithErrors');
  expect(container.querySelector('[data-status="error"]')).toBeTruthy();
});
```

- [ ] **Step 2: Run tests and confirm RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/tool-call-summary.test.tsx`

Expected: FAIL because the current component renders a flat list and has no semantic groups.

- [ ] **Step 3: Implement the two-level disclosure UI**

`ToolCallSummary` must:

```tsx
const summary = useMemo(() => summarizeToolActivity(toolCalls), [toolCalls]);

return (
  <Collapsible open={expanded} onOpenChange={setExpanded}>
    <CollapsibleTrigger data-testid="tool-activity-summary">
      {/* status icon + completed/running/error copy + count + duration */}
    </CollapsibleTrigger>
    <CollapsibleContent>
      {summary.groups.map((group) => (
        <ToolActivityGroupRow key={group.key} group={group} />
      ))}
    </CollapsibleContent>
  </Collapsible>
);
```

Each group row is another collapsible. Its closed state shows semantic label, count, and status. Its open state renders `ToolCallCard` for every canonical call. `ToolCallCard` receives the semantic label, displays `semantic label · raw tool name`, and adds `data-testid="tool-call-card"`.

- [ ] **Step 4: Run component and contract checks**

Run:

```bash
pnpm --filter @clawwork/desktop exec vitest run test/tool-call-summary.test.tsx
pnpm check:ui-contract
pnpm check:renderer-copy
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/components/ToolCallSummary.tsx packages/desktop/src/renderer/components/ToolCallCard.tsx packages/desktop/test/tool-call-summary.test.tsx
git commit -m "feat(tools): group tool activity details"
```

### Task 3: Unify streaming and historical rendering

**Files:**

- Modify: `packages/desktop/src/renderer/components/StreamingMessage.tsx`
- Modify: `packages/desktop/test/tool-call-summary.test.tsx`

- [ ] **Step 1: Add a failing streaming regression test**

```tsx
it('renders streaming calls through one shared activity summary', () => {
  const { container } = render(<StreamingMessage content="" toolCalls={tenCalls} />);
  expect(container.querySelectorAll('[data-testid="tool-activity-summary"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-testid="tool-call-card"]')).toHaveLength(0);
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/tool-call-summary.test.tsx`

Expected: FAIL because `StreamingMessage` currently renders the newest call as a standalone card.

- [ ] **Step 3: Replace the split streaming renderer**

```tsx
{
  toolCalls?.length ? (
    <div className="mb-2">
      <ToolCallSummary toolCalls={toolCalls} streaming />
    </div>
  ) : null;
}
```

Add a `streaming?: boolean` prop. While any call is running, the summary shows the current call as secondary text; completed calls remain grouped inside the disclosure area. When all calls finish, the component retains the same outer structure and switches to completed copy.

- [ ] **Step 4: Run focused tests and type checking**

Run:

```bash
pnpm --filter @clawwork/desktop exec vitest run test/tool-call-summary.test.tsx test/chat-message-copy.test.tsx
pnpm typecheck
pnpm typecheck:tests
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/components/StreamingMessage.tsx packages/desktop/test/tool-call-summary.test.tsx
git commit -m "fix(tools): keep streaming activity compact"
```

### Task 4: Add localized semantic activity copy

**Files:**

- Modify: `packages/desktop/src/renderer/i18n/locales/en.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/de.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/es.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/fr.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ja.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ko.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/pt.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh-TW.json`

- [ ] **Step 1: Add exact translation keys**

Add `toolActivity` with these leaf keys to every locale:

```json
{
  "toolActivity": {
    "actions": {
      "browseWeb": "查询网页",
      "execute": "执行操作",
      "listDirectory": "查看文件夹",
      "other": "使用工具",
      "readFile": "读取文件",
      "search": "搜索资料",
      "writeFile": "修改文件"
    },
    "completed": "已完成 {{count}} 个步骤",
    "duration": "{{seconds}} 秒",
    "groupCount": "× {{count}}",
    "running": "正在处理 · 已完成 {{count}} 个步骤",
    "viewDetails": "查看详情"
  }
}
```

Use accurate Simplified Chinese and English. Other locales may temporarily use the reviewed English fallback, matching the existing Demo policy.

- [ ] **Step 2: Verify locale parity and scanner visibility**

Run:

```bash
pnpm check:i18n
pnpm check:renderer-copy
```

Expected: both pass with no missing or unused keys.

- [ ] **Step 3: Commit**

```bash
git add packages/desktop/src/renderer/i18n/locales packages/desktop/src/renderer/components/ToolCallSummary.tsx
git commit -m "feat(tools): localize activity summaries"
```

### Task 5: Reduce redundant file exploration

**Files:**

- Modify: `packages/desktop/src/renderer/lib/preset-agents.ts`
- Modify: `packages/desktop/test/preset-agents.test.ts`

- [ ] **Step 1: Write a failing operating-contract test**

```ts
it('constrains file exploration to an authorized target and avoids repeated listings', () => {
  for (const agent of PRESET_AGENT_DEFINITIONS) {
    expect(agent.soulMd).toContain('authorized target');
    expect(agent.soulMd).toContain('Do not repeat directory listings');
    expect(agent.soulMd).toContain('batch');
  }
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/preset-agents.test.ts`

Expected: FAIL because the common contract lacks file-exploration guidance.

- [ ] **Step 3: Add shared exploration constraints**

Append to `COMMON_OPERATING_CONTRACT`:

```md
## File exploration

- Work only inside the user-authorized target. If no target is clear, ask the user to attach or link one before scanning.
- List the necessary directory scope once, filter candidates by name and type, then read only relevant files.
- Do not repeat directory listings for the same path unless a prior operation changed that path or the listing failed.
- Prefer a bounded batch operation over many equivalent single-file calls.
- Stop exploring as soon as the available evidence is sufficient to deliver the requested result.
```

- [ ] **Step 4: Run regression tests**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/preset-agents.test.ts test/preset-agent-installer.test.ts`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/lib/preset-agents.ts packages/desktop/test/preset-agents.test.ts
git commit -m "fix(assistants): bound file exploration"
```

### Task 6: Final verification and live inspection

**Files:**

- No production files expected.

- [ ] **Step 1: Run focused quality gates**

Run:

```bash
pnpm check:ui-contract
pnpm check:renderer-copy
pnpm check:i18n
pnpm typecheck
pnpm typecheck:tests
```

Expected: all pass.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm test`

Expected: all workspace tests pass, including the new tool activity tests.

- [ ] **Step 3: Inspect the live Demo**

Use the existing `pnpm dev` window and run a simulated or real file task containing repeated `ls` and `exec` calls. Verify one compact default summary, two semantic groups after expansion, raw-call inspection, and visible failure treatment.

- [ ] **Step 4: Record any repository-wide baseline failures separately**

Run: `pnpm check`

If it stops at the existing `knip` or repository-wide Prettier baseline, record that separately. Do not attribute pre-existing unused exports or global formatting drift to this change; all touched-file formatting and the focused gates above must still pass.
