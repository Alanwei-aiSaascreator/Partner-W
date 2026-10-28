# Independent Assistant Workspaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the compass assistant and six professional assistants independent welcome pages, task starters, composer state, and filtered history.

**Architecture:** Keep the existing assistant selection and pending-task stores as the source of truth. Make the selected assistant identity explicit at the `MainArea` boundary, key the welcome surface by that identity, and render a focused `AssistantWorkspaceWelcome` component from metadata stored with each preset agent. A visit remains state-only; `ChatInput` creates the real task on first send using the pending assistant ID.

**Tech Stack:** Electron 34, React 19, TypeScript, Zustand, Vitest, Testing Library, react-i18next, lucide-react.

---

## File Map

- Modify `packages/desktop/src/renderer/lib/preset-agents.ts`: expose welcome-page metadata keys and resolve compass/preset workspace metadata.
- Create `packages/desktop/src/renderer/layouts/MainArea/AssistantWorkspaceWelcome.tsx`: render one assistant identity, four task starters, readiness, and model status.
- Modify `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`: delegate assistant-specific rendering and keep gateway/model pending state synchronized.
- Modify `packages/desktop/src/renderer/layouts/MainArea/index.tsx`: key the welcome surface by selected assistant so switching cannot reuse stale local state.
- Modify `packages/desktop/src/renderer/layouts/LeftNav/index.tsx`: clear stale drafts and set pending assistant without creating a task.
- Modify `packages/desktop/src/renderer/i18n/locales/*.json`: add four distinct starters and capability descriptions for every assistant.
- Create `packages/desktop/test/assistant-workspace-welcome.test.tsx`: cover assistant-specific content and starter behavior.
- Modify `packages/desktop/test/welcome-screen.test.tsx`: cover pending assistant/model synchronization after switching.

### Task 1: Assistant Workspace Metadata

**Files:**

- Modify: `packages/desktop/src/renderer/lib/preset-agents.ts`
- Test: `packages/desktop/test/preset-agents.test.ts`

- [ ] **Step 1: Write failing metadata tests**

Add assertions that `resolveAssistantWorkspace('partner-w-content')` returns the content display key, description key, and exactly four starter keys, while `resolveAssistantWorkspace('main')` returns the compass definition.

```ts
expect(resolveAssistantWorkspace('partner-w-content')).toMatchObject({
  id: 'partner-w-content',
  titleKey: 'presetAgents.roles.content',
  descriptionKey: 'assistantWorkspaces.content.description',
});
expect(resolveAssistantWorkspace('partner-w-content').starters).toHaveLength(4);
expect(resolveAssistantWorkspace('main').id).toBe('main');
```

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/preset-agents.test.ts`

Expected: FAIL because `resolveAssistantWorkspace` does not exist.

- [ ] **Step 3: Add the typed resolver**

Define `AssistantWorkspaceDefinition` with `id`, `titleKey`, `descriptionKey`, `emoji`, and four `{ titleKey, descriptionKey, promptKey }` entries. Build the compass definition explicitly and derive preset definitions from each preset's `workspaceKey`.

- [ ] **Step 4: Run the test to verify GREEN**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/preset-agents.test.ts`

Expected: all preset-agent tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/lib/preset-agents.ts packages/desktop/test/preset-agents.test.ts
git commit -m "feat(assistants): define workspace welcome metadata"
```

### Task 2: Independent Welcome Surface

**Files:**

- Create: `packages/desktop/src/renderer/layouts/MainArea/AssistantWorkspaceWelcome.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`
- Create: `packages/desktop/test/assistant-workspace-welcome.test.tsx`

- [ ] **Step 1: Write the failing component test**

Render content and ecommerce definitions separately. Assert that each render exposes only its own title, description, four prompt buttons, current model label, and readiness label. Click one content starter and assert `onSelectPrompt` receives only the translated content prompt.

- [ ] **Step 2: Run the test to verify RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/assistant-workspace-welcome.test.tsx`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the welcome component**

Use a centered identity header, a two-column starter grid, compact capability/status row, and no nested modal. Accept `definition`, `modelLabel`, `ready`, and `onSelectPrompt`; translate only the keys supplied by the definition.

- [ ] **Step 4: Replace the generic welcome body**

In `WelcomeScreen`, resolve the definition from `effectiveAgentId`, retain gateway/agent selection controls, and render `AssistantWorkspaceWelcome`. Do not create a task in an effect or click handler.

- [ ] **Step 5: Run focused tests and commit**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/assistant-workspace-welcome.test.tsx test/welcome-screen.test.tsx
git add packages/desktop/src/renderer/layouts/MainArea packages/desktop/test
git commit -m "feat(assistants): render independent welcome pages"
```

### Task 3: Switching and First-Send Binding

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/LeftNav/index.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: `packages/desktop/test/welcome-screen.test.tsx`
- Test: `packages/desktop/test/use-chat-send.test.tsx`

- [ ] **Step 1: Add failing switch assertions**

Assert that selecting `partner-w-ecommerce` updates the selected-agent store, sets pending `{ gatewayId, agentId: 'partner-w-ecommerce' }`, clears the active task, and does not call `createTask`. Assert the welcome component key changes with the assistant ID.

- [ ] **Step 2: Run the tests to verify RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/welcome-screen.test.tsx test/use-chat-send.test.tsx`

- [ ] **Step 3: Synchronize selection without creating empty tasks**

Pass `currentAgentId` from `MainArea` to `ChatContent`, key `WelcomeScreen` with `currentAgentId`, and update pending state in `LeftNav`. The first send continues through `commitPendingTask`, which persists the selected assistant and DeepSeek V4 Flash together.

- [ ] **Step 4: Run the tests to verify GREEN**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/welcome-screen.test.tsx test/use-chat-send.test.tsx`

- [ ] **Step 5: Commit**

```bash
git add packages/desktop/src/renderer/layouts/LeftNav/index.tsx packages/desktop/src/renderer/layouts/MainArea/index.tsx packages/desktop/test
git commit -m "fix(assistants): bind switching to independent workspaces"
```

### Task 4: Localized Professional Starters

**Files:**

- Modify: `packages/desktop/src/renderer/i18n/locales/en.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh-TW.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/de.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/es.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/fr.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ja.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/ko.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/pt.json`

- [ ] **Step 1: Add complete Chinese and English copy**

For each workspace key (`compass`, `content`, `ecommerce`, `family`, `office`, `research`, `video`), add a description and four distinct starter objects with title, description, and prompt. Prompts must request a concrete deliverable and ask only for missing constraints.

- [ ] **Step 2: Add parity values for every supported locale**

Use accurate existing translations where available; use the approved English copy as a fallback value rather than leaving keys absent.

- [ ] **Step 3: Verify locale contracts**

Run: `pnpm check:i18n && pnpm check:renderer-copy`

Expected: both checks pass with zero missing or unused keys.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src/renderer/i18n/locales
git commit -m "feat(i18n): add assistant workspace guidance"
```

### Task 5: Verification and Demo

**Files:**

- Modify: `docs/status/2026-09-15-basic-demo-progress.md`

- [ ] **Step 1: Run focused behavior tests**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/preset-agents.test.ts test/assistant-workspace-welcome.test.tsx test/welcome-screen.test.tsx test/use-chat-send.test.tsx
```

- [ ] **Step 2: Run static gates**

```bash
pnpm lint
pnpm check:architecture
pnpm check:ui-contract
pnpm check:renderer-copy
pnpm check:i18n
pnpm typecheck
pnpm typecheck:tests
```

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`

Expected: all tests pass. If a known 5-second concurrency timeout occurs, rerun that exact file alone and report both outcomes.

- [ ] **Step 4: Launch and inspect the real app**

Run: `pnpm dev`

Switch through all seven assistant entries. Confirm each page changes identity and four starters, preserves its filtered history, uses DeepSeek V4 Flash, and creates no task until the first message is sent.

- [ ] **Step 5: Update progress and commit**

Record the independent assistant workspace behavior, verification counts, and any remaining packaging work in the status document.

```bash
git add docs/status/2026-09-15-basic-demo-progress.md
git commit -m "docs(demo): record assistant workspace verification"
```
