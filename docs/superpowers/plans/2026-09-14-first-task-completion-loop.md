# First Task Completion Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route home-page task starters to installed professional agents and show one account-scoped completion prompt after the user's first real AI response.

**Architecture:** Keep agent routing and completion qualification in pure renderer utilities. A small hook owns account-scoped local persistence, a presentational card owns the completion actions, and MainArea wires those pieces to existing task, message, and UI stores without adding a message writer.

**Tech Stack:** Electron 34, React 19, TypeScript, Zustand, Vitest, react-i18next, existing Rongying Cube design tokens.

---

### Task 1: Add deterministic starter-to-agent routing

**Files:**

- Modify: `packages/desktop/src/renderer/lib/preset-agents.ts`
- Modify: `packages/desktop/test/preset-agents.test.ts`

- [ ] **Step 1: Write the failing routing tests**

Add tests that require every `StarterId` to map to its approved stable agent ID and require the resolver to fall back when that ID is absent:

```ts
expect(STARTER_AGENT_BY_ID).toEqual({
  content: 'rongying-content',
  photography: 'rongying-video',
  office: 'rongying-office',
  research: 'rongying-research',
  ecommerce: 'rongying-ecommerce',
  family: 'rongying-family',
});
expect(resolveStarterAgentId('content', ['main', 'rongying-content'], 'main')).toBe('rongying-content');
expect(resolveStarterAgentId('content', ['main'], 'main')).toBe('main');
```

- [ ] **Step 2: Verify RED**

Run:

```text
pnpm --filter @clawwork/desktop exec vitest run test/preset-agents.test.ts
```

Expected: failure because the routing exports do not exist.

- [ ] **Step 3: Implement the pure routing API**

Import `StarterId`, export the immutable mapping, and implement:

```ts
export function resolveStarterAgentId(
  starterId: StarterId,
  availableAgentIds: readonly string[],
  fallbackAgentId: string,
): string {
  const targetId = STARTER_AGENT_BY_ID[starterId];
  return availableAgentIds.includes(targetId) ? targetId : fallbackAgentId;
}
```

- [ ] **Step 4: Verify GREEN**

Run the Task 1 test command and confirm all tests pass.

### Task 2: Define and persist the first-task milestone

**Files:**

- Create: `packages/desktop/src/renderer/lib/first-task-milestone.ts`
- Create: `packages/desktop/test/first-task-milestone.test.ts`

- [ ] **Step 1: Write failing qualification and storage tests**

Cover these behaviors with real utility calls:

```ts
const record = detectFirstTaskCompletion({
  userId: 'user-1',
  taskId: 'task-1',
  onboardingCompletedAt: '2026-09-14T10:00:00.000Z',
  activity: 'idle',
  messages: [
    { id: 'u1', role: 'user', content: 'draft a plan', timestamp: '2026-09-14T10:01:00.000Z' },
    { id: 'a1', role: 'assistant', content: 'Here is the plan', timestamp: '2026-09-14T10:02:00.000Z' },
  ],
});
expect(record).toEqual({
  version: 1,
  userId: 'user-1',
  taskId: 'task-1',
  assistantMessageId: 'a1',
  completedAt: '2026-09-14T10:02:00.000Z',
});
```

Also assert `null` for non-idle activity, an empty assistant reply, a reply preceding the first qualifying user message, and messages older than onboarding. Verify account-scoped load/save and malformed JSON fallback with an in-memory storage implementation.

- [ ] **Step 2: Verify RED**

Run:

```text
pnpm --filter @clawwork/desktop exec vitest run test/first-task-milestone.test.ts
```

Expected: failure because the module does not exist.

- [ ] **Step 3: Implement the pure milestone utility**

Export `FirstTaskMilestoneRecord`, `MilestoneMessage`, `detectFirstTaskCompletion`, `loadFirstTaskMilestone`, and `saveFirstTaskMilestone`. Use the key prefix `rongying-cube:first-task:v1:`. Parse timestamps with `Date.parse`, require a non-empty assistant message after the first qualifying user message, and never throw for malformed or unavailable storage.

- [ ] **Step 4: Verify GREEN**

Run the Task 2 test command and confirm all cases pass.

### Task 3: Add the account-scoped milestone hook

**Files:**

- Create: `packages/desktop/src/renderer/hooks/useFirstTaskMilestone.ts`
- Create: `packages/desktop/test/use-first-task-milestone.test.tsx`

- [ ] **Step 1: Write failing hook tests**

Render a small harness using the wished-for API:

```ts
const milestone = useFirstTaskMilestone({
  userId,
  onboardingCompletedAt,
  taskId,
  messages,
  activity,
  storage,
});
```

Assert that it stays hidden before a full response, becomes visible after an idle user-to-assistant round trip, persists exactly one record, stays dismissed after `dismiss()`, and never appears for an account with a stored record.

- [ ] **Step 2: Verify RED**

Run:

```text
pnpm --filter @clawwork/desktop exec vitest run test/use-first-task-milestone.test.tsx
```

Expected: failure because the hook does not exist.

- [ ] **Step 3: Implement the hook**

Use lazy state to load the account record. In an effect, call `detectFirstTaskCompletion` only while no record exists, save the returned record, and expose:

```ts
{
  visible: Boolean(record && visibleTaskId === taskId && !dismissed),
  dismiss,
}
```

Reset only the view-level dismissal when the account changes. Do not write to the message or task database.

- [ ] **Step 4: Verify GREEN**

Run the Task 3 test command and confirm the hook tests pass without React act warnings.

### Task 4: Build the restrained completion card

**Files:**

- Create: `packages/desktop/src/renderer/components/FirstTaskCompletionCard.tsx`
- Create: `packages/desktop/test/first-task-completion-card.test.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/de.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/en.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/es.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/fr.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ja.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ko.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/pt.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh-TW.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh.json`

- [ ] **Step 1: Write the failing component test**

Render the component with spies and require localized title text plus buttons for continue, new task, usage, and dismiss. Click each action and verify the matching callback only.

- [ ] **Step 2: Verify RED**

Run:

```text
pnpm --filter @clawwork/desktop exec vitest run test/first-task-completion-card.test.tsx
```

Expected: failure because the component does not exist.

- [ ] **Step 3: Add i18n copy**

Add the `firstTaskCompletion` namespace to every desktop locale. Use native Simplified and Traditional Chinese copy and the reviewed English fallback for other locales. Required keys: `title`, `description`, `continue`, `continuePrompt`, `newTask`, `viewUsage`, and `dismiss`.

- [ ] **Step 4: Implement the component**

Use one full border, `rounded-xl`, existing background and accent variables, a restrained `CircleCheck` icon, standard Button variants, and an icon dismiss button with an accessible label. Do not add shadows, gradients, celebration motion, or nested cards.

- [ ] **Step 5: Verify GREEN**

Run the Task 4 test and `pnpm check:i18n`.

### Task 5: Connect starter routing to the welcome screen

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`
- Modify: `packages/desktop/test/welcome-screen.test.tsx`

- [ ] **Step 1: Extend the welcome test before changing production code**

Provide a catalog containing `main` and `rongying-video`, click the photography starter, and expect `setPending({ gatewayId: 'gw-1', agentId: 'rongying-video' })` before the existing draft callback. Add a second case with only `main` and require fallback to `main`.

- [ ] **Step 2: Verify RED**

Run:

```text
pnpm --filter @clawwork/desktop exec vitest run test/welcome-screen.test.tsx
```

Expected: the professional-agent assertion fails because starters currently only fill text.

- [ ] **Step 3: Implement welcome routing**

Create `handleSelectStarter(id)` that resolves against `agentCatalog`, immediately updates `pendingNewTask` for the selected gateway, updates local selector state when the professional agent exists, and then calls `onSelectPrompt`. Keep custom-goal behavior unchanged.

- [ ] **Step 4: Verify GREEN**

Run the welcome and preset-agent tests together.

### Task 6: Wire the milestone into MainArea

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Create: `packages/desktop/src/renderer/layouts/MainArea/FirstTaskCompletionFlow.tsx`
- Create: `packages/desktop/test/first-task-completion-flow.test.tsx`

- [ ] **Step 1: Write a failing flow test around the coordinator**

Import the wished-for `FirstTaskCompletionFlow`, feed it one completed real exchange, and assert the card becomes visible. Verify:

- continue passes `t('firstTaskCompletion.continuePrompt')` to the draft callback;
- new task calls `startNewTask` and dismisses the card;
- usage calls `setMainView('dashboard')` and dismisses the card.

- [ ] **Step 2: Verify RED**

Run:

```text
pnpm --filter @clawwork/desktop exec vitest run test/first-task-completion-flow.test.tsx
```

Expected: failure because the coordinator integration does not exist.

- [ ] **Step 3: Implement the integration**

Create `FirstTaskCompletionFlow.tsx` as the only React coordinator for the hook and card:

```tsx
<FirstTaskCompletionFlow
  userId={onboardingProfile.userId}
  onboardingCompletedAt={onboardingProfile.completedAt}
  taskId={activeTaskId}
  messages={messages}
  activity={activity}
  onContinue={() => setStarterPrompt(t('firstTaskCompletion.continuePrompt'))}
  onNewTask={() => startNewTask()}
  onViewUsage={() => setMainView('dashboard')}
/>
```

Place it immediately after the message timeline. Reuse `starterPrompt` for continue and pass it to ChatInput in both welcome and active-chat branches. The coordinator dismisses itself before calling the new-task and usage actions.

- [ ] **Step 4: Verify GREEN**

Run the flow, card, hook, milestone, welcome, and chat-send tests together.

### Task 7: Verify visually and ship

**Files:**

- Modify only batch files when verification reveals a batch-specific defect.

- [ ] Run targeted Vitest tests for routing, milestone, hook, card, flow, welcome, onboarding, and chat send.
- [ ] Run desktop TypeScript, targeted ESLint, Prettier, architecture, renderer-copy, and i18n checks.
- [ ] Run `pnpm --filter @clawwork/desktop build`.
- [ ] Run `pnpm check:ui-contract` and confirm no violation outside the existing five baseline locations.
- [ ] Launch the desktop app and inspect the completed-response card in light and dark themes at approximately 1266×800 without sending a new live model request.
- [ ] Commit with `feat(onboarding): close first task loop` and push `feat/stage3b-demo-polish`.
