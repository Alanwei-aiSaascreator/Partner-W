# Reliable Single-Agent Team Workflow Implementation Plan

> **For agentic workers:** Execute each task test-first in this worktree. Do not commit this change set.

**Goal:** Make every team chat use one installed agent directly and give that agent a mandatory strategy → creation → QA/revision → delivery contract without depending on `sessions_spawn`.

**Architecture:** Team launch remains a normal task with `teamId` preserved, but `ensemble` is always false. A focused renderer helper owns the hidden workflow contract and merges it into `contextPrefix`, so it reaches the model without appearing in the user bubble or persisted user text. The old conductor remains compatible for existing ensemble tasks, but delegation becomes optional and direct execution is its fallback.

**Tech Stack:** TypeScript, React, Zustand-backed stores, Vitest/jsdom.

---

### Task 1: Default Team Launch

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/TeamsPanel/index.tsx`
- Test: `packages/desktop/test/teams-panel-single-agent.test.tsx`

- [ ] Write a component test that clicks “start chat” on a two-member team and expects `startNewTask({ gatewayId, agentId: managerId, ensemble: false, teamId })`.
- [ ] Run `pnpm --filter @clawwork/desktop exec vitest run test/teams-panel-single-agent.test.tsx` and verify it fails because the current component sets `ensemble: true` for multi-member teams.
- [ ] Replace the member-count-derived ensemble flag with the explicit reliable-mode value `false`; keep `teamId` so a later sequential reviewer can resolve the team roster without changing the UI contract.
- [ ] Re-run the focused test and verify it passes.

### Task 2: Four-Phase Hidden Workflow Contract

**Files:**

- Create: `packages/desktop/src/renderer/lib/team-workflow.ts`
- Create: `packages/desktop/test/team-workflow.test.ts`
- Modify: `packages/desktop/src/renderer/components/ChatInput/useChatSend.ts`
- Modify: `packages/desktop/test/use-chat-send.test.tsx`

- [ ] Write pure tests for a contract that requires the exact ordered phases strategy, creation, QA with revision when needed, and delivery; forbids `sessions_spawn`/`sessions_send`; restricts work to currently available tools; and forbids completion until the requested artifact exists and has been verified.
- [ ] Run the pure test and verify it fails because the helper does not exist.
- [ ] Add the minimal helper that returns the contract and merges it before any existing hidden context.
- [ ] Re-run the pure test and verify it passes.
- [ ] Add a hook-level test where the active task has `teamId` and `ensemble: false`; expect `composer.send` to receive the workflow in `contextPrefix` while `content` remains exactly the user text.
- [ ] Run the hook test and verify it fails because team context is not yet injected.
- [ ] In `useChatSend`, merge the workflow into `contextPrefix` for every task carrying `teamId`, after optional artifact-index construction and before dispatch.
- [ ] Re-run the hook and pure tests and verify they pass.

### Task 3: Legacy Conductor Must Not Require Spawn

**Files:**

- Modify: `packages/shared/src/constants.ts`
- Modify: `packages/shared/test/conductor-prompt.test.ts`

- [ ] Replace the old assertion that mandates successful `sessions_spawn` with assertions that delegation is optional, spawn failure falls back to direct work, and any attempted delegation must still be reported truthfully.
- [ ] Run `pnpm --filter @clawwork/shared exec vitest run test/conductor-prompt.test.ts` and verify it fails against the current hard rules.
- [ ] Make the smallest prompt change: allow direct execution, prohibit dependency on delegation, retain truthful status language, and keep in-app-only recovery guidance.
- [ ] Re-run the shared test and verify it passes.

### Task 4: Regression Verification

**Files:**

- Verify only; no new files.

- [ ] Run the focused desktop/shared tests for team entry, team workflow, send wiring, conductor catalog fallback, room store, composer, and conductor prompt.
- [ ] Run desktop/shared type checks for the touched packages.
- [ ] Confirm `git diff --check`, inspect `git diff`, and confirm no media/backend files changed and no commit was created.
