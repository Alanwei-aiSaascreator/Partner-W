# Demo Experience Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Windows Demo enter its real workspace quickly, expose truthful file and assistant capabilities, default every new task to DeepSeek V4 Flash, and show quota progress as remaining balance.

**Architecture:** Keep authentication, onboarding, and activation as blocking gates, but render the existing three-panel workspace while runtime readiness continues. Centralize commercial model and quota display decisions in small renderer utilities, then consume those utilities from task creation, chat, account, and dashboard surfaces. Reuse the existing workspace and context-folder IPC paths for local data visibility; do not introduce full-disk scanning or a second filesystem trust model.

**Tech Stack:** Electron 34, React 19, TypeScript, Zustand, Vitest, Testing Library, react-i18next, Tailwind CSS variables, lucide-react.

---

## File Map

- Create `packages/desktop/src/renderer/lib/commercial-default-model.ts`: resolve the canonical commercial default from the filtered catalog.
- Create `packages/desktop/src/renderer/lib/quota-display.ts`: calculate clamped remaining values for every quota surface.
- Create `packages/desktop/src/renderer/layouts/MainArea/StartupReadinessPanel.tsx`: inline runtime preparation UI.
- Create `packages/desktop/src/renderer/layouts/MainArea/AssistantGuide.tsx`: empty-task guidance for preset assistants.
- Create `packages/desktop/src/renderer/layouts/FileBrowser/WorkspaceAccessSummary.tsx`: truthful current workspace and context-folder visibility.
- Modify `packages/desktop/src/renderer/App.tsx`: remove the full-screen runtime gate and pass readiness into the workspace.
- Modify `packages/desktop/src/renderer/layouts/MainArea/index.tsx`: render readiness, assistant guide, and disabled composer states.
- Modify `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`: initialize pending tasks with the canonical default model.
- Modify `packages/desktop/src/renderer/components/ChatInput/useChatSend.ts`: use the canonical default for first send and fallback.
- Modify `packages/desktop/src/renderer/layouts/MainArea/index.tsx` and `packages/desktop/src/renderer/layouts/Settings/sections/AccountSection.tsx`: use remaining quota width.
- Modify `packages/desktop/src/renderer/layouts/FileBrowser/index.tsx`: surface workspace access summary.
- Modify `packages/desktop/src/renderer/i18n/locales/*.json`: add translated runtime, assistant, workspace, and remaining-quota copy.
- Add or modify focused tests under `packages/desktop/test/` for each behavior.

### Task 1: Canonical Commercial Default Model

**Files:**

- Create: `packages/desktop/src/renderer/lib/commercial-default-model.ts`
- Create: `packages/desktop/test/commercial-default-model.test.ts`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`
- Modify: `packages/desktop/src/renderer/components/ChatInput/useChatSend.ts`

- [ ] **Step 1: Write the failing resolver tests**

```ts
import { describe, expect, it } from 'vitest';
import { resolveCommercialDefaultModel } from '../src/renderer/lib/commercial-default-model';

describe('resolveCommercialDefaultModel', () => {
  it('selects DeepSeek V4 Flash when available', () => {
    expect(
      resolveCommercialDefaultModel([
        { id: 'qwen3.5-27b', provider: 'clawrouter' },
        { id: 'deepseek-v4-flash', provider: 'clawrouter', name: 'DeepSeek V4 Flash' },
      ]),
    ).toEqual({ id: 'deepseek-v4-flash', provider: 'clawrouter', label: 'DeepSeek V4 Flash' });
  });

  it('returns undefined instead of inventing an unavailable model', () => {
    expect(resolveCommercialDefaultModel([])).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/commercial-default-model.test.ts`

Expected: FAIL because the resolver module does not exist.

- [ ] **Step 3: Implement the resolver**

```ts
import type { ModelCatalogEntry } from '@clawwork/shared';

export const COMMERCIAL_DEFAULT_MODEL_ID = 'deepseek-v4-flash';

export function resolveCommercialDefaultModel(catalog: ModelCatalogEntry[]) {
  const entry = catalog.find((model) => model.id === COMMERCIAL_DEFAULT_MODEL_ID);
  if (!entry) return undefined;
  return {
    id: entry.id,
    provider: entry.provider,
    label: entry.name ?? 'DeepSeek V4 Flash',
  };
}
```

- [ ] **Step 4: Initialize pending tasks and first send from this resolver**

In `WelcomeScreen.tsx`, preserve the existing pending task fields and add `model` and `modelProvider` once the filtered catalog contains the default. In `useChatSend.ts`, derive `currentModel` from the task selection or the resolver and pass it as `presetModel` on the first message. Replace the hardcoded `bailian/qwen3.5-flash` degraded fallback with the resolved commercial default.

- [ ] **Step 5: Add component coverage and confirm GREEN**

Extend `packages/desktop/test/welcome-screen.test.tsx` to assert the pending task receives `deepseek-v4-flash`, then run both tests.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/lib/commercial-default-model.ts packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx packages/desktop/src/renderer/components/ChatInput/useChatSend.ts packages/desktop/test/commercial-default-model.test.ts packages/desktop/test/welcome-screen.test.tsx
git commit -m "fix(models): align default model selection"
```

### Task 2: Remaining Quota Presentation

**Files:**

- Create: `packages/desktop/src/renderer/lib/quota-display.ts`
- Create: `packages/desktop/test/quota-display.test.ts`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Settings/sections/AccountSection.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Dashboard/index.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/en.json`

- [ ] **Step 1: Write failing remaining-quota tests**

```ts
import { describe, expect, it } from 'vitest';
import { deriveQuotaDisplay } from '../src/renderer/lib/quota-display';

describe('deriveQuotaDisplay', () => {
  it('returns remaining amount and width', () => {
    expect(deriveQuotaDisplay(50_000, 12_500)).toEqual({ remaining: 37_500, remainingPercent: 75 });
  });

  it('clamps overspend at zero', () => {
    expect(deriveQuotaDisplay(100, 120)).toEqual({ remaining: 0, remainingPercent: 0 });
  });
});
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/quota-display.test.ts`

- [ ] **Step 3: Implement the shared display helper**

```ts
export function deriveQuotaDisplay(total: number, used: number) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0;
  const remaining = Math.max(0, safeTotal - safeUsed);
  const remainingPercent = safeTotal > 0 ? Math.min(100, (remaining / safeTotal) * 100) : 0;
  return { remaining, remainingPercent };
}
```

- [ ] **Step 4: Replace every account quota bar width**

Use `remainingPercent` in the header balance popover, account settings, and dashboard. Make the prominent label `remainingCredits`; keep total and used as secondary rows.

- [ ] **Step 5: Add UI assertions and confirm GREEN**

Update `dashboard-overview.test.tsx` and account section coverage to assert `aria-valuenow` and rendered width represent remaining quota.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop/src/renderer/lib/quota-display.ts packages/desktop/src/renderer/layouts/MainArea/index.tsx packages/desktop/src/renderer/layouts/Settings/sections/AccountSection.tsx packages/desktop/src/renderer/layouts/Dashboard/index.tsx packages/desktop/src/renderer/i18n/locales packages/desktop/test
git commit -m "fix(quota): show remaining balance progress"
```

### Task 3: Enter the Workspace Before Runtime Readiness

**Files:**

- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/lib/startup-readiness.ts`
- Create: `packages/desktop/src/renderer/layouts/MainArea/StartupReadinessPanel.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: `packages/desktop/src/renderer/components/ChatInput/index.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`
- Modify: `packages/desktop/test/startup-readiness.test.ts`
- Modify: `packages/desktop/test/startup-readiness-screen.test.tsx`

- [ ] **Step 1: Write failing readiness-policy tests**

Add assertions that `workspaceAvailable` becomes true after auth, onboarding, and workspace setup even while AI is starting, and that `conversationReady` only requires AI plus the selected assistant rather than all six assistants.

```ts
expect(result.workspaceAvailable).toBe(true);
expect(result.conversationReady).toBe(false);
```

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/startup-readiness.test.ts test/startup-readiness-screen.test.tsx`

- [ ] **Step 3: Split readiness into workspace and conversation states**

Extend `StartupReadiness` with `workspaceAvailable` and `conversationReady`. Preserve `isReady` temporarily as a compatibility alias for `conversationReady` until all callers migrate.

- [ ] **Step 4: Remove the full-screen runtime return from App**

Delete the `if (!startupReadiness.isReady) return <StartupReadinessScreen ... />` branch. Pass `startupReadiness` and `onRetryStartup` to `MainArea` through the existing app layout.

- [ ] **Step 5: Add the inline preparation panel**

The panel must show AI service, model catalog, assistant progress, retry, and a 90-second delayed recovery message. It must use existing CSS variables, lucide icons, translated strings, and reduced-motion-compatible progress styling.

- [ ] **Step 6: Disable only conversation submission**

Pass `conversationReady` into `ChatInput`. Keep navigation and file/account views usable; show a precise disabled reason in the composer.

- [ ] **Step 7: Run focused tests and commit**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/startup-readiness.test.ts test/startup-readiness-screen.test.tsx test/welcome-screen.test.tsx
git add packages/desktop/src/renderer packages/desktop/test
git commit -m "feat(startup): prepare ai inside workspace"
```

### Task 4: Preset Assistant Guidance

**Files:**

- Create: `packages/desktop/src/renderer/layouts/MainArea/AssistantGuide.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`
- Modify: `packages/desktop/src/renderer/lib/preset-agents.ts`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`
- Create: `packages/desktop/test/assistant-guide.test.tsx`

- [ ] **Step 1: Write a failing guide test**

Render a selected preset assistant with no messages and assert its title, capability description, four starter tasks, readiness label, and default model label are visible.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/assistant-guide.test.tsx`

- [ ] **Step 3: Add assistant guide metadata**

Add translation-key references for one description, four starter tasks, and capability labels per preset definition. Do not duplicate prompt bodies in component code.

- [ ] **Step 4: Render the guide inline**

Use the guide only when the selected preset assistant has no active conversation content. Clicking a starter updates the existing pending task agent and fills the composer through the current `onSelectPrompt` callback.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/assistant-guide.test.tsx test/welcome-screen.test.tsx
git add packages/desktop/src/renderer packages/desktop/test/assistant-guide.test.tsx packages/desktop/test/welcome-screen.test.tsx
git commit -m "feat(assistants): add guided task starters"
```

### Task 5: Truthful Local Workspace Visibility

**Files:**

- Create: `packages/desktop/src/renderer/layouts/FileBrowser/WorkspaceAccessSummary.tsx`
- Modify: `packages/desktop/src/renderer/layouts/FileBrowser/index.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`
- Create: `packages/desktop/test/workspace-access-summary.test.tsx`

- [ ] **Step 1: Write a failing summary test**

Mock `getWorkspacePath()` and assert the UI displays the exact current workspace path, states that the app does not scan the whole computer, and provides the existing `openWorkspaceFolder()` action.

- [ ] **Step 2: Run and confirm RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/workspace-access-summary.test.tsx`

- [ ] **Step 3: Implement the summary with existing IPC only**

Use `getWorkspacePath`, `openWorkspaceFolder`, and the existing context-folder picker. Do not claim arbitrary persistent folder authorization until the main-process trust model supports it. Explain that individual files can be attached and that generated artifacts live in the visible workspace.

- [ ] **Step 4: Integrate above the artifact browser**

Keep current search, filtering, previews, and artifact navigation unchanged. The new summary should collapse after the user has interacted with the file browser to preserve density.

- [ ] **Step 5: Run tests and commit**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/workspace-access-summary.test.tsx
git add packages/desktop/src/renderer/layouts/FileBrowser packages/desktop/src/renderer/i18n/locales packages/desktop/test/workspace-access-summary.test.tsx
git commit -m "feat(files): explain local workspace access"
```

### Task 6: Integrated Visual Polish and Verification

**Files:**

- Modify only the files touched by Tasks 1–5.
- Update: `docs/status/2026-09-15-basic-demo-progress.md`

- [ ] **Step 1: Run focused behavior tests**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/commercial-default-model.test.ts test/quota-display.test.ts test/startup-readiness.test.ts test/startup-readiness-screen.test.tsx test/assistant-guide.test.tsx test/workspace-access-summary.test.tsx test/welcome-screen.test.tsx test/dashboard-overview.test.tsx
```

- [ ] **Step 2: Run static quality gates**

```bash
pnpm lint
pnpm check:architecture
pnpm check:ui-contract
pnpm check:renderer-copy
pnpm check:i18n
pnpm typecheck
pnpm typecheck:tests
```

- [ ] **Step 3: Run the complete test suite**

Run: `pnpm test`

Expected: all 862 existing tests plus new tests pass. If `workspace-refresh.test.ts` times out only in the full run, rerun it alone and report both results without hiding the timeout.

- [ ] **Step 4: Verify light and dark Windows UI**

Launch `pnpm dev`. Check login, onboarding, inline readiness, assistant guide, composer disabled/enabled state, files, account balance, and one actual model reply in both themes. Confirm the selector, reply badge, and usage model are identical.

- [ ] **Step 5: Update the progress record**

Record completed changes, test counts, unresolved issues, and whether packaging remains blocked.

- [ ] **Step 6: Commit**

```bash
git add docs/status/2026-09-15-basic-demo-progress.md packages/desktop
git commit -m "docs(demo): record experience polish verification"
```

## Deferred Follow-up

Persistent multi-folder authorization requires a separate security design covering canonical path storage, symlink handling, atomic reads, removal, migration, and Gateway workspace propagation. This plan deliberately ships truthful visibility of the current workspace and explicit per-task file attachment first; it does not mislabel those existing capabilities as full-computer Agent access.
