# Partner-W Double Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first approved application-shell batch: a fixed 56px global rail, an adjustable 224px assistant rail with every available assistant and recent tasks, and an unchanged central work path.

**Architecture:** Keep authentication, setup, onboarding, gateway, task, payment, and main-area orchestration in `App.tsx`. Add a presentational `GlobalRail`, convert the existing `LeftNav` into the assistant rail, and add a reusable deterministic `CubeFaceIcon`; reuse existing Zustand state and task actions so navigation does not fork application state. Keep the stored `leftNavWidth` key for compatibility while tightening its behavior to the approved 200–260px assistant-rail range.

**Tech Stack:** Electron 34, React 19, TypeScript, Zustand, Tailwind CSS 4, Radix Tooltip, lucide-react, Framer Motion, Vitest, react-i18next

---

### Task 1: Lock the assistant rail width contract

**Files:**

- Create: `packages/core/test/ui-store-layout.test.ts`
- Modify: `packages/core/src/stores/ui-store.ts`

- [x] **Step 1: Write the failing width tests**

Create a store with an in-memory storage adapter and assert that a fresh store starts at `224`, a persisted legacy width above the new range resolves to `260`, and `setLeftNavWidth(120)` / `setLeftNavWidth(360)` clamp to `200` / `260`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @clawwork/core test -- ui-store-layout.test.ts`

Expected: FAIL because the current default and limits are `180–400`.

- [x] **Step 3: Implement the bounded persisted width**

Add a small `fixedPanelWidth` helper in `ui-store.ts`, initialize `leftNavWidth` with `fixedPanelWidth(storage, 'cw:leftNavWidth', 200, 260, 224)`, and clamp writes to the same bounds. Do not rename the public store fields or local-storage key in this batch.

- [x] **Step 4: Run the focused core test and verify GREEN**

Run: `pnpm --filter @clawwork/core test -- ui-store-layout.test.ts`

Expected: PASS.

- [x] **Step 5: Commit the width contract**

```bash
git add packages/core/src/stores/ui-store.ts packages/core/test/ui-store-layout.test.ts
git commit -m "feat(ui): bound assistant rail width"
```

### Task 2: Add the ability-face icon and persistent assistant list

**Files:**

- Create: `packages/desktop/src/renderer/components/CubeFaceIcon.tsx`
- Create: `packages/desktop/src/renderer/layouts/LeftNav/AssistantList.tsx`
- Create: `packages/desktop/test/assistant-list.test.tsx`
- Modify: `packages/desktop/src/renderer/layouts/LeftNav/index.tsx`

- [x] **Step 1: Write the failing assistant-list test**

Render `AssistantList` with the compass assistant plus two professional assistants. Assert that all labels are present, the selected assistant exposes `aria-current="page"`, and clicking another assistant calls `onSelect` with its exact id.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @clawwork/desktop test -- assistant-list.test.tsx`

Expected: FAIL because `AssistantList` and `CubeFaceIcon` do not exist.

- [x] **Step 3: Implement the reusable icon and list**

Implement `CubeFaceIcon` as a CSS-variable-driven square with three geometric facets derived deterministically from `agentId`; keep it decorative with `aria-hidden="true"`. Implement `AssistantList` as a semantic list of buttons using `AgentInfo`, `resolveAgentDisplayNameKey`, and `CubeFaceIcon`, with a visible selected state and truncation-safe labels.

- [x] **Step 4: Convert `LeftNav` to the assistant rail**

Replace the dropdown switcher and duplicated global links with:

- a title row for “My assistants”, collapse, and “Add assistant”;
- the persistent `AssistantList`;
- task search;
- a “Recent tasks” header with a new-task action;
- the selected assistant’s five most recently updated non-archived tasks;
- a local “View all tasks” / “Show fewer tasks” toggle.

When an assistant is selected, persist the UI selection, update the pending task’s gateway and agent without committing it, clear the active task, and return to the chat/home view. Do not send a message or create a persisted task.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `pnpm --filter @clawwork/desktop test -- assistant-list.test.tsx`

Expected: PASS.

- [x] **Step 6: Commit the assistant rail**

```bash
git add packages/desktop/src/renderer/components/CubeFaceIcon.tsx packages/desktop/src/renderer/layouts/LeftNav packages/desktop/test/assistant-list.test.tsx
git commit -m "feat(ui): add persistent assistant rail"
```

### Task 3: Add the fixed global rail and compose the application shell

**Files:**

- Create: `packages/desktop/src/renderer/layouts/AppShell/GlobalRail.tsx`
- Create: `packages/desktop/test/global-rail.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Settings/index.tsx`

- [x] **Step 1: Write the failing global-rail test**

Render `GlobalRail` with callback spies. Assert accessible buttons exist for home, files, usage, identity, and settings; click each primary route and verify its callback. Assert only the active route exposes `aria-current="page"`.

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @clawwork/desktop test -- global-rail.test.tsx`

Expected: FAIL because `GlobalRail` does not exist.

- [x] **Step 3: Implement `GlobalRail`**

Use a fixed `w-14` rail, `CubeFaceIcon` for the brand, lucide icons for functional entries, Tooltip for every icon-only button, visible keyboard focus, top routes for home/files/usage, archive as the available secondary route, and identity/settings at the bottom. When the assistant rail is collapsed, show a current-assistant ability-face button below Home that expands it.

- [x] **Step 4: Integrate the shell in `App.tsx`**

Render `GlobalRail` before the existing motion-wrapped assistant rail. Animate only the assistant rail between zero and `leftNavWidth`, keep the global rail fixed, retain the existing resizers and right panel, and route Home to `chat` with no active task. Add an `openSettings(section)` callback so Identity opens Account, Settings opens General, and Add Assistant opens Agents.

- [x] **Step 5: Allow Settings to receive a selected section**

Add an optional `initialSection` prop to `Settings`, initialize and synchronize its local section state from that prop, and preserve all existing in-panel navigation.

- [x] **Step 6: Run focused tests and verify GREEN**

Run: `pnpm --filter @clawwork/desktop test -- global-rail.test.tsx assistant-list.test.tsx`

Expected: PASS.

- [x] **Step 7: Commit the application shell**

```bash
git add packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/layouts/AppShell packages/desktop/src/renderer/layouts/Settings/index.tsx packages/desktop/test/global-rail.test.tsx
git commit -m "feat(ui): compose double sidebar shell"
```

### Task 4: Localize, verify, and visually inspect

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

- [x] **Step 1: Add every new label to all locale files**

Add locale entries for Home, Identity, My assistants, Add assistant, Recent tasks, View all tasks, and Show fewer tasks. Keep the simplified Chinese product copy direct and use correct equivalents in the other bundled locales.

- [x] **Step 2: Run code-quality checks for touched production files**

Run Prettier on changed files, then run ESLint only for the touched TypeScript and TSX files. Run `pnpm check:i18n`, `pnpm check:renderer-copy`, desktop source/test typechecks, and `pnpm --filter @clawwork/desktop build`.

Expected: the touched files pass. Existing repository-wide failures in ignored local probe files remain outside this change.

- [x] **Step 3: Run focused and broader tests**

Run the three focused desktop UI tests, the new core store test, then the desktop suite once. Compare any suite failures with the recorded Windows path-fixture baseline.

Verification on 2026-09-15: the focused UI and model-loading regressions passed, the core suite passed 175/175, and the desktop suite retained its recorded Windows path-fixture baseline of 835 passing and 13 failing tests.

- [x] **Step 4: Inspect the real app in light and dark modes**

At approximately 1266×800, verify the 56px global rail, 224px assistant rail, all assistants, five recent tasks, collapse/expand behavior, resizer limits, Home, Files, Usage, Identity, Settings, Add Assistant, model loading state, composer, and right-panel opening. Repeat the shell inspection in both light and dark themes and restore Follow Windows afterward.

- [x] **Step 5: Commit verification adjustments and push**

```bash
git add packages/desktop/src/renderer/i18n/locales packages/desktop/src/renderer packages/desktop/test packages/core
git commit -m "chore(ui): verify double sidebar shell"
git push origin feat/stage3b-demo-polish
```
