# Seven-Assistant Task Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn all seven assistant welcome screens into a reusable professional task workbench with 28 stable task templates, safe draft insertion, account-scoped recents, and truthful result actions.

**Architecture:** Add a pure typed task catalog and a small local recent-history adapter, then render both through one shared workbench component. Template selections become explicit draft requests handled by the existing uncontrolled chat composer; model calls, quota checks, attachments, persistence, and artifacts continue through the current production paths.

**Tech Stack:** React 19, TypeScript, i18next, localStorage, Zustand-backed existing stores, Vitest, Testing Library, Playwright, Electron.

---

## File map

- Create `packages/desktop/src/renderer/lib/assistant-task-presets.ts`: stable IDs, metadata keys, and strict assistant-to-template lookup.
- Create `packages/desktop/test/assistant-task-presets.test.ts`: catalog completeness and isolation tests.
- Create `packages/desktop/src/renderer/lib/assistant-task-history.ts`: account-scoped bounded recent-template persistence.
- Create `packages/desktop/test/assistant-task-history.test.ts`: sanitization, deduplication, isolation, and corruption tests.
- Create `packages/desktop/src/renderer/layouts/MainArea/AssistantTaskWorkbench.tsx`: shared seven-assistant welcome and task-template UI.
- Create `packages/desktop/test/assistant-task-workbench.test.tsx`: rendering and selection behavior.
- Create `packages/desktop/src/renderer/components/ChatInput/DraftConflictDialog.tsx`: append, replace, and cancel decision UI.
- Modify `packages/desktop/src/renderer/components/ChatInput/types.ts`: typed draft request/result contract.
- Modify `packages/desktop/src/renderer/components/ChatInput/index.tsx`: safe draft application without sending.
- Create `packages/desktop/test/chat-input-draft-request.test.tsx`: empty, append, replace, cancel, and no-send behavior.
- Modify `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`: render the workbench and pass typed selections upward.
- Modify `packages/desktop/src/renderer/layouts/MainArea/index.tsx`: own draft requests and recent history.
- Delete `packages/desktop/src/renderer/layouts/MainArea/AssistantWorkspaceWelcome.tsx` after its behavior is covered by the new workbench.
- Replace `packages/desktop/test/assistant-workspace-welcome.test.tsx` with the workbench test.
- Modify `packages/desktop/src/renderer/components/FirstTaskCompletionCard.tsx`: generate-file and artifact follow-up actions.
- Modify `packages/desktop/src/renderer/layouts/MainArea/FirstTaskCompletionFlow.tsx`: route follow-up actions through the existing composer and right panel.
- Modify `packages/desktop/test/first-task-completion-card.test.tsx` and `packages/desktop/test/first-task-completion-flow.test.tsx`.
- Modify all `packages/desktop/src/renderer/i18n/locales/*.json`: workbench, material, output, conflict, recent, and result-action copy.
- Modify `e2e/packaged/demo-main-path.spec.ts`: extend the existing real packaged rehearsal with template selection and draft protection.

### Task 1: Create the strict seven-assistant task catalog

**Files:**

- Create: `packages/desktop/src/renderer/lib/assistant-task-presets.ts`
- Create: `packages/desktop/test/assistant-task-presets.test.ts`
- Modify: `packages/desktop/src/renderer/lib/preset-agents.ts`

- [ ] **Step 1: Write the failing catalog tests**

```ts
import { describe, expect, it } from 'vitest';
import { ASSISTANT_TASK_PRESETS, resolveAssistantTaskPresets } from '../src/renderer/lib/assistant-task-presets';

describe('assistant task presets', () => {
  it('defines four unique tasks for every built-in assistant', () => {
    const assistantIds = [
      'main',
      'rongying-content',
      'rongying-video',
      'rongying-ecommerce',
      'rongying-office',
      'rongying-research',
      'rongying-family',
    ];
    expect(ASSISTANT_TASK_PRESETS).toHaveLength(28);
    expect(new Set(ASSISTANT_TASK_PRESETS.map((item) => item.id)).size).toBe(28);
    for (const assistantId of assistantIds) expect(resolveAssistantTaskPresets(assistantId)).toHaveLength(4);
  });

  it('fails closed for a custom or unknown assistant', () => {
    expect(resolveAssistantTaskPresets('customer-imported-agent')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the catalog test and verify RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-presets.test.ts`

Expected: FAIL because `assistant-task-presets.ts` does not exist.

- [ ] **Step 3: Implement stable IDs and derived translation keys**

```ts
export const ASSISTANT_TASK_IDS = {
  compass: ['goal-breakdown', 'execution-plan', 'option-comparison', 'comprehensive-analysis'],
  content: ['topic-planning', 'long-form-writing', 'short-video-script', 'rewrite-polish'],
  video: ['shooting-script', 'storyboard', 'editing-rhythm', 'title-cover'],
  ecommerce: ['product-copy', 'campaign-plan', 'competitor-analysis', 'review-customer-service'],
  office: ['document-writing', 'spreadsheet-analysis', 'meeting-minutes', 'presentation-outline'],
  research: ['source-organization', 'viewpoint-comparison', 'learning-plan', 'research-report'],
  family: ['travel-plan', 'family-checklist', 'purchase-comparison', 'schedule-plan'],
} as const;

export type AssistantTaskWorkspaceKey = keyof typeof ASSISTANT_TASK_IDS;

export interface AssistantTaskPreset {
  id: string;
  assistantId: string;
  workspaceKey: AssistantTaskWorkspaceKey;
  titleKey: string;
  descriptionKey: string;
  promptKey: string;
  materialHintKey: string;
  outputKey: string;
  followUpPromptKey: string;
}

const ASSISTANT_WORKSPACE_BY_ID: Readonly<Record<string, AssistantTaskWorkspaceKey>> = {
  main: 'compass',
  'rongying-content': 'content',
  'rongying-video': 'video',
  'rongying-ecommerce': 'ecommerce',
  'rongying-office': 'office',
  'rongying-research': 'research',
  'rongying-family': 'family',
};

export const ASSISTANT_TASK_PRESETS: readonly AssistantTaskPreset[] = Object.entries(ASSISTANT_TASK_IDS).flatMap(
  ([workspaceKey, ids]) => {
    const assistantId = Object.entries(ASSISTANT_WORKSPACE_BY_ID).find(([, value]) => value === workspaceKey)?.[0];
    if (!assistantId) return [];
    return ids.map((id, index) => {
      const root = `assistantWorkspaces.${workspaceKey}.starters.${index + 1}`;
      return {
        id: `${workspaceKey}:${id}`,
        assistantId,
        workspaceKey: workspaceKey as AssistantTaskWorkspaceKey,
        titleKey: `${root}.title`,
        descriptionKey: `${root}.description`,
        promptKey: `${root}.prompt`,
        materialHintKey: `${root}.materialHint`,
        outputKey: `${root}.output`,
        followUpPromptKey: `${root}.followUpPrompt`,
      };
    });
  },
);

export function resolveAssistantTaskPresets(agentId: string): readonly AssistantTaskPreset[] {
  return ASSISTANT_TASK_PRESETS.filter((item) => item.assistantId === agentId);
}
```

Update `AssistantWorkspaceDefinition` so `starters` comes from `resolveAssistantTaskPresets(id)` and remove its old index-only starter builder. Keep `PRESET_AGENT_DEFINITIONS` and assistant creation prompts unchanged.

- [ ] **Step 4: Run the catalog and existing preset-agent tests**

Run:

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-presets.test.ts test/preset-agents.test.ts
```

Expected: both files PASS and all 28 IDs are unique.

- [ ] **Step 5: Commit the catalog**

```powershell
git add packages/desktop/src/renderer/lib/assistant-task-presets.ts packages/desktop/src/renderer/lib/preset-agents.ts packages/desktop/test/assistant-task-presets.test.ts
git commit -m "feat(assistants): add professional task preset catalog"
```

### Task 2: Add account-scoped recent template history

**Files:**

- Create: `packages/desktop/src/renderer/lib/assistant-task-history.ts`
- Create: `packages/desktop/test/assistant-task-history.test.ts`

- [ ] **Step 1: Write failing storage-contract tests**

```ts
import { describe, expect, it } from 'vitest';
import { loadRecentAssistantTasks, recordRecentAssistantTask } from '../src/renderer/lib/assistant-task-history';

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
  };
}

it('isolates, deduplicates, and bounds recent preset IDs', () => {
  const storage = memoryStorage();
  for (let index = 0; index < 7; index += 1) {
    recordRecentAssistantTask('user-a', `compass:task-${index}`, storage, new Date(index).toISOString());
  }
  recordRecentAssistantTask('user-a', 'compass:task-6', storage, new Date(10).toISOString());
  expect(loadRecentAssistantTasks('user-a', storage)).toHaveLength(5);
  expect(loadRecentAssistantTasks('user-a', storage)[0]?.presetId).toBe('compass:task-6');
  expect(loadRecentAssistantTasks('user-b', storage)).toEqual([]);
});
```

Add a second test that writes malformed JSON and objects containing `prompt`, `content`, `phone`, or `token`; loading must return only `{ presetId, usedAt }` records with bounded strings.

- [ ] **Step 2: Run the history test and verify RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-history.test.ts`

Expected: FAIL because the history adapter is missing.

- [ ] **Step 3: Implement the bounded adapter**

```ts
export interface RecentAssistantTask {
  presetId: string;
  usedAt: string;
}

export interface AssistantTaskHistoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PREFIX = 'rongying-cube:assistant-task-history:v1:';
const MAX_RECENT = 5;

export function loadRecentAssistantTasks(
  userId: string,
  storage: AssistantTaskHistoryStorage = window.localStorage,
): RecentAssistantTask[] {
  try {
    const parsed = JSON.parse(storage.getItem(`${PREFIX}${userId}`) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({ presetId: String(item.presetId ?? '').slice(0, 100), usedAt: String(item.usedAt ?? '') }))
      .filter((item) => item.presetId.length > 0 && !Number.isNaN(Date.parse(item.usedAt)))
      .slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function recordRecentAssistantTask(
  userId: string,
  presetId: string,
  storage: AssistantTaskHistoryStorage = window.localStorage,
  usedAt = new Date().toISOString(),
): RecentAssistantTask[] {
  const next = [
    { presetId: presetId.slice(0, 100), usedAt },
    ...loadRecentAssistantTasks(userId, storage).filter((item) => item.presetId !== presetId),
  ].slice(0, MAX_RECENT);
  storage.setItem(`${PREFIX}${userId}`, JSON.stringify(next));
  return next;
}
```

- [ ] **Step 4: Run the history tests**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-history.test.ts`

Expected: PASS; serialized history contains only `presetId` and `usedAt`.

- [ ] **Step 5: Commit the history adapter**

```powershell
git add packages/desktop/src/renderer/lib/assistant-task-history.ts packages/desktop/test/assistant-task-history.test.ts
git commit -m "feat(assistants): remember recent task templates safely"
```

### Task 3: Build the shared professional task workbench

**Files:**

- Create: `packages/desktop/src/renderer/layouts/MainArea/AssistantTaskWorkbench.tsx`
- Create: `packages/desktop/test/assistant-task-workbench.test.tsx`
- Delete after replacement: `packages/desktop/src/renderer/layouts/MainArea/AssistantWorkspaceWelcome.tsx`
- Delete after replacement: `packages/desktop/test/assistant-workspace-welcome.test.tsx`

- [ ] **Step 1: Write the failing component tests**

Render all seven assistant definitions. For each definition, assert four `[data-testid="assistant-task-preset"]` buttons, translated description, material hint, output label, and one custom-task button. Click a preset and assert the callback receives the full `AssistantTaskPreset`, not a translated string. Assert that `recentPresetIds` reorders only matching presets into a separate recent row.

```tsx
const onSelectPreset = vi.fn();
render(
  <AssistantTaskWorkbench
    definition={resolveAssistantWorkspace('rongying-content')!}
    modelLabel="DeepSeek V4 Flash"
    ready
    recentPresetIds={['content:short-video-script']}
    onSelectPreset={onSelectPreset}
    onCustomTask={vi.fn()}
  />,
);
fireEvent.click(screen.getByRole('button', { name: /assistantWorkspaces.content.starters.3.title/ }));
expect(onSelectPreset).toHaveBeenCalledWith(expect.objectContaining({ id: 'content:short-video-script' }));
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-workbench.test.tsx`

Expected: FAIL because `AssistantTaskWorkbench` does not exist.

- [ ] **Step 3: Implement the workbench**

The component accepts this exact contract:

```ts
interface AssistantTaskWorkbenchProps {
  definition: AssistantWorkspaceDefinition;
  modelLabel: string;
  ready: boolean;
  recentPresetIds: readonly string[];
  onSelectPreset: (preset: AssistantTaskPreset) => void;
  onCustomTask: () => void;
}
```

Render title and assistant description first, then a responsive one-column/two-column preset grid. Each card sets `data-testid="assistant-task-preset"` and `data-preset-id={preset.id}`, and shows title, description, `materialHint`, and `output`; keep the model/readiness chips below the grid. Render recent tasks only when IDs resolve to the current assistant. The custom action calls `onCustomTask` and never constructs or sends a message.

- [ ] **Step 4: Run component and accessibility-focused tests**

Run:

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-workbench.test.tsx
pnpm check:ui-contract
```

Expected: component tests PASS and UI contract reports no violation.

- [ ] **Step 5: Commit the workbench**

```powershell
git add packages/desktop/src/renderer/layouts/MainArea/AssistantTaskWorkbench.tsx packages/desktop/src/renderer/layouts/MainArea/AssistantWorkspaceWelcome.tsx packages/desktop/test/assistant-task-workbench.test.tsx packages/desktop/test/assistant-workspace-welcome.test.tsx
git commit -m "feat(assistants): add shared professional task workbench"
```

### Task 4: Protect existing drafts during template insertion

**Files:**

- Modify: `packages/desktop/src/renderer/components/ChatInput/types.ts`
- Create: `packages/desktop/src/renderer/components/ChatInput/DraftConflictDialog.tsx`
- Modify: `packages/desktop/src/renderer/components/ChatInput/index.tsx`
- Create: `packages/desktop/test/chat-input-draft-request.test.tsx`

- [ ] **Step 1: Define the failing interaction tests**

Cover these exact cases:

1. Empty composer applies the prompt and focuses the textarea.
2. Existing text opens a dialog and does not change the textarea.
3. Append produces `existing + "\n\n" + prompt`.
4. Replace produces only `prompt`.
5. Cancel keeps the exact existing value.
6. None of the five cases calls the normal send path.
7. Applying the same request ID twice has no effect the second time.

- [ ] **Step 2: Run the draft tests and verify RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/chat-input-draft-request.test.tsx`

Expected: FAIL because ChatInput currently replaces drafts without conflict protection.

- [ ] **Step 3: Add the typed request/result contract**

```ts
export interface DraftPromptRequest {
  id: string;
  prompt: string;
  presetId?: string;
  source: 'assistant-template' | 'goal-routing' | 'first-task-follow-up' | 'result-action';
}

export type DraftPromptResolution = 'applied' | 'appended' | 'replaced' | 'cancelled';
```

Change ChatInput props to:

```ts
draftRequest?: DraftPromptRequest | null;
onDraftResolved?: (request: DraftPromptRequest, resolution: DraftPromptResolution) => void;
```

- [ ] **Step 4: Implement the three-action conflict dialog**

`DraftConflictDialog` uses the existing base `Dialog` and exactly three actions: cancel, append, and replace. `ChatInput` keeps `pendingDraftRequest` state plus a set/ref of handled request IDs. A single `applyDraftText(value)` helper updates the textarea value, height, send availability, and focus. It must not dispatch keyboard events or call `useChatSend`.

```ts
const applyDraftText = useCallback((value: string) => {
  const textarea = textareaRef.current;
  if (!textarea) return;
  textarea.value = value;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  setCanSend(value.trim().length > 0);
  textarea.focus();
}, []);
```

- [ ] **Step 5: Run draft and existing send tests**

Run:

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/chat-input-draft-request.test.tsx test/use-chat-send.test.tsx test/conductor-catalog-fallback.test.tsx
```

Expected: all tests PASS; cancelled conflicts preserve the exact draft.

- [ ] **Step 6: Commit draft protection**

```powershell
git add packages/desktop/src/renderer/components/ChatInput packages/desktop/test/chat-input-draft-request.test.tsx
git commit -m "feat(chat): protect drafts when applying task templates"
```

### Task 5: Integrate task selection, recent history, and custom tasks

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Create: `packages/desktop/test/assistant-task-workbench-flow.test.tsx`

- [ ] **Step 1: Write the failing integration tests**

Mock the gateway selector and render WelcomeScreen/MainArea. Assert that selecting `content:short-video-script` produces a `DraftPromptRequest` whose translated prompt is placed into ChatInput, that cancellation does not record history, and that append/replace records the preset once under the active `onboardingProfile.userId`. Switch to another assistant and assert content presets do not appear.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-workbench-flow.test.tsx`

Expected: FAIL because MainArea still owns only a string `starterPrompt`.

- [ ] **Step 3: Replace string starter state with typed draft requests**

MainArea owns a monotonic request sequence:

```ts
const draftSequence = useRef(0);
const [draftRequest, setDraftRequest] = useState<DraftPromptRequest | null>(null);
const [recentTasks, setRecentTasks] = useState(() => loadRecentAssistantTasks(onboardingProfile.userId));

const requestDraft = useCallback((prompt: string, source: DraftPromptRequest['source'], presetId?: string) => {
  draftSequence.current += 1;
  setDraftRequest({ id: `${source}:${draftSequence.current}`, prompt, source, presetId });
}, []);
```

On `onDraftResolved`, clear the matching request. Only `applied`, `appended`, and `replaced` with a `presetId` call `recordRecentAssistantTask`; `cancelled` never changes history. Reload history when `onboardingProfile.userId` changes.

- [ ] **Step 4: Connect WelcomeScreen and custom task focus**

WelcomeScreen translates `preset.promptKey` and calls `onSelectPreset(preset, translatedPrompt)`. Custom task emits a draft request with an empty prompt only as a focus command; ChatInput treats an empty custom request as focus-only and marks it applied without changing text.

Goal routing and first-task follow-ups must use `requestDraft` with their explicit sources instead of directly setting strings.

- [ ] **Step 5: Run integration regressions**

Run:

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-workbench-flow.test.tsx test/welcome-screen.test.tsx test/goal-recommendation-panel.test.tsx test/first-task-completion-flow.test.tsx
```

Expected: PASS; history is written only after an applied template.

- [ ] **Step 6: Commit integration**

```powershell
git add packages/desktop/src/renderer/layouts/MainArea packages/desktop/test/assistant-task-workbench-flow.test.tsx packages/desktop/test/welcome-screen.test.tsx
git commit -m "feat(assistants): connect task templates to the real composer"
```

### Task 6: Add truthful result follow-up actions

**Files:**

- Modify: `packages/desktop/src/renderer/components/FirstTaskCompletionCard.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/FirstTaskCompletionFlow.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: `packages/desktop/test/first-task-completion-card.test.tsx`
- Modify: `packages/desktop/test/first-task-completion-flow.test.tsx`

- [ ] **Step 1: Write failing result-action tests**

With no artifacts, the completion card shows “生成文件” and invokes `onGenerateFile`; it does not claim a file exists. With one or more current-task artifacts, it shows “查看成果” and invokes `onViewArtifacts`. Existing continue, new task, usage, and dismiss actions remain available.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/first-task-completion-card.test.tsx test/first-task-completion-flow.test.tsx
```

Expected: FAIL because the card has no file-aware action.

- [ ] **Step 3: Implement file-aware completion actions**

Add props:

```ts
artifactCount: number;
onGenerateFile: () => void;
onViewArtifacts: () => void;
```

MainArea derives `artifactCount` by filtering `useFileStore((state) => state.artifacts)` by `activeTaskId`. “生成文件” creates a `result-action` draft with the localized prompt “请把刚才的结果整理成一个可下载文件。先确认最合适的文件格式，再生成并保存到当前任务成果目录。” “查看成果” opens the existing right panel and selects the newest current-task artifact when available.

- [ ] **Step 4: Run completion, artifact, and right-panel tests**

Run:

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/first-task-completion-card.test.tsx test/first-task-completion-flow.test.tsx test/artifact-card.test.tsx test/right-panel-artifacts.test.tsx
```

Expected: PASS; no file card is rendered without a registered artifact.

- [ ] **Step 5: Commit result actions**

```powershell
git add packages/desktop/src/renderer/components/FirstTaskCompletionCard.tsx packages/desktop/src/renderer/layouts/MainArea packages/desktop/test/first-task-completion-card.test.tsx packages/desktop/test/first-task-completion-flow.test.tsx
git commit -m "feat(assistants): add truthful result follow-up actions"
```

### Task 7: Complete Chinese copy, locale parity, and responsive polish

**Files:**

- Modify: `packages/desktop/src/renderer/i18n/locales/zh.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/en.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/de.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/es.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/fr.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ja.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ko.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/pt.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh-TW.json`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/AssistantTaskWorkbench.tsx`

- [ ] **Step 1: Add failing copy assertions**

Update the workbench test to assert Chinese labels for recent tasks, recommended material, expected output, and custom task. Add assertions that no card contains fake counts, ratings, income, or “数据不出网”.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-workbench.test.tsx
pnpm check:i18n
```

Expected: tests or locale parity FAIL because the new keys are not present in every locale.

- [ ] **Step 3: Add the full copy contract**

Add these shared keys to every locale:

```json
{
  "taskWorkbench": {
    "recent": "最近使用",
    "recommendedMaterial": "建议资料",
    "expectedOutput": "预期成果",
    "customTask": "自定义任务",
    "customTaskDescription": "直接描述你的目标和希望得到的结果",
    "draftConflictTitle": "输入框已有内容",
    "draftConflictDescription": "选择保留原内容并追加模板，或使用模板替换当前内容。",
    "appendDraft": "追加模板",
    "replaceDraft": "替换内容",
    "generateFile": "生成文件",
    "viewArtifacts": "查看成果",
    "generateFilePrompt": "请把刚才的结果整理成一个可下载文件。先确认最合适的文件格式，再生成并保存到当前任务成果目录。"
  }
}
```

Use reviewed Simplified Chinese in `zh.json`, Traditional Chinese in `zh-TW.json`, English in `en.json`, and the exact English values as safe fallbacks in de/es/fr/ja/ko/pt until translated copy is reviewed. For each of the 28 starters add non-empty `materialHint`, `output`, and `followUpPrompt` values. In Chinese, material hints must name realistic optional inputs and outputs must describe deliverable structure without promising a file.

- [ ] **Step 4: Polish responsive states**

Use one column below `sm`, two columns from `sm`, visible `glow-focus`, `motion-reduce:transition-none`, neutral surfaces, and the existing accent only for the selected/recent badge and primary action. Do not add a dark background block.

- [ ] **Step 5: Run locale and visual contract checks**

Run:

```powershell
pnpm check:i18n
pnpm check:renderer-copy
pnpm check:ui-contract
pnpm --filter @clawwork/desktop exec vitest run test/assistant-task-workbench.test.tsx test/chat-input-draft-request.test.tsx
```

Expected: all checks PASS.

- [ ] **Step 6: Commit copy and polish**

```powershell
git add packages/desktop/src/renderer/i18n/locales packages/desktop/src/renderer/layouts/MainArea/AssistantTaskWorkbench.tsx packages/desktop/test/assistant-task-workbench.test.tsx
git commit -m "style(assistants): polish professional task entry points"
```

### Task 8: Add acceptance coverage, verify, tag, and package

**Files:**

- Modify: `e2e/packaged/demo-main-path.spec.ts`
- Update: `docs/status/2026-09-15-basic-demo-progress.md`

- [ ] **Step 1: Extend the real packaged main-path rehearsal**

In `demo-main-path.spec.ts`, after the existing real login, activation, readiness, and assistant-selection steps but before filling the paid-call `PROMPT`, add this UI sequence:

```ts
const template = page.locator('[data-preset-id="content:short-video-script"]');
await expect(template).toBeVisible();
await template.click();
const composer = page.locator('textarea').first();
await expect(composer).toHaveValue(/短视频/);

await composer.fill('必须保留的用户草稿');
await page.locator('[data-preset-id="content:rewrite-polish"]').click();
await page.getByRole('button', { name: '取消', exact: true }).click();
await expect(composer).toHaveValue('必须保留的用户草稿');

await page.locator('[data-preset-id="content:rewrite-polish"]').click();
await page.getByRole('button', { name: '追加模板', exact: true }).click();
await expect(composer).toHaveValue(/必须保留的用户草稿[\s\S]+请优化/);

const recent = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((item) => item.startsWith('rongying-cube:assistant-task-history:v1:'));
  return key ? JSON.parse(localStorage.getItem(key) ?? '[]') : [];
});
expect(recent[0]).toEqual({
  presetId: 'content:rewrite-polish',
  usedAt: expect.any(String),
});
expect(Object.keys(recent[0]).sort()).toEqual(['presetId', 'usedAt']);
```

Then retain the existing `await composer.fill(PROMPT)` and single real send. Template clicks must not create a user message or invoke the paid model before that line.

The existing artifact-loop E2E remains responsible for import, save-as, restart recovery, and missing-folder behavior. The packaged main path already owns the single paid live model call and must not add a second one.

- [ ] **Step 2: Run focused acceptance**

Run:

```powershell
pnpm exec playwright test --config=e2e/playwright.config.ts --project=artifact-loop
pnpm exec playwright test --config=e2e/playwright.config.ts --project=packaged e2e/packaged/demo-main-path.spec.ts
```

Expected: artifact-loop PASS. Packaged demo-main-path PASS when the documented test phone, OTP, and unused test card are configured; otherwise it must report SKIPPED with the existing explicit reason and remains an external pending acceptance item.

- [ ] **Step 3: Run repository verification**

Run:

```powershell
pnpm check:architecture
pnpm check:ui-contract
pnpm check:renderer-copy
pnpm check:i18n
pnpm typecheck
pnpm typecheck:tests
pnpm typecheck:e2e
pnpm test
pnpm --filter @clawwork/desktop build
```

Expected: every command exits 0; Vitest reports no unhandled worker error.

- [ ] **Step 4: Update progress truthfully**

Record the seven-assistant workbench, 28 templates, safe draft behavior, and automated evidence in `docs/status/2026-09-15-basic-demo-progress.md`. Keep live SMS, fresh-card, paid model, and clean-machine rehearsal unchecked until physically performed.

- [ ] **Step 5: Commit acceptance work**

```powershell
git add e2e/packaged/demo-main-path.spec.ts docs/status/2026-09-15-basic-demo-progress.md
git commit -m "test(assistants): verify task workbench flow"
```

- [ ] **Step 6: Create a rollback tag and build from the short worktree**

Create annotated tag `internal-beta-before-assistant-workbench-20260916` on `internal-beta-v1-candidate-20260916` if it does not already exist. Move the clean detached `D:\mfbuild` worktree to the verified feature commit, run `pnpm install --frozen-lockfile`, then:

```powershell
pnpm --filter @clawwork/desktop build:win
Get-FileHash -Algorithm SHA256 -LiteralPath 'packages/desktop/dist/荣盈魔方-0.0.16-win-x64.exe'
```

Expected: NSIS installer, `.blockmap`, and `latest.yml` are generated; record absolute path, size, SHA-256, source commit, and unsigned status.

- [ ] **Step 7: Manual internal-beta checkpoint**

Open the packaged app and inspect all seven assistants at wide and windowed sizes. Verify one template per assistant, a draft conflict append/replace/cancel cycle, file attachment, one live model response, quota change, generate-file request, artifact open/save-as, restart recovery, and no black first-run surface. Mark steps requiring a fresh phone, fresh activation card, or clean PC as external pending if those resources are unavailable.
