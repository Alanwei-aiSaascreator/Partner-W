# Ten-Hour Internal Beta Feature Sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a branded company-internal desktop build with a four-step guided setup, editable user purpose, truthful updater/admin entry points, useful local beta modules, and verified file-to-artifact delivery.

**Architecture:** Extend the account-scoped onboarding profile to a backward-compatible v2 contract, keep rendering inside the existing React/Electron shell, and adapt existing updater and commercial APIs instead of duplicating them. Local beta modules remain explicitly local and write only redacted events; production login, billing, model, and admin authorization remain server-owned.

**Tech Stack:** React 19, TypeScript, Zustand, Electron IPC, Tailwind CSS variables, Vitest, Testing Library, Playwright, electron-builder.

---

## File map

- `packages/desktop/src/renderer/lib/user-onboarding.ts`: v2 profile, v1 migration, assistant recommendations.
- `packages/desktop/src/renderer/layouts/Onboarding/index.tsx`: four-step wizard and edit mode.
- `packages/desktop/src/renderer/App.tsx`: enter/exit edit flow and refresh the active profile.
- `packages/desktop/src/renderer/layouts/Settings/index.tsx`: pass account actions into settings.
- `packages/desktop/src/renderer/layouts/Settings/sections/AccountSection.tsx`: purpose, device, and authorization entry points.
- `packages/desktop/src/renderer/features/internal-beta/update-service.ts`: truthful adapter over existing updater IPC.
- `packages/desktop/src/renderer/features/internal-beta/beta-store.ts`: versioned redacted event log.
- `packages/desktop/src/renderer/features/internal-beta/InternalBetaHub.tsx`: real update/admin entry and improved module feedback.
- `packages/desktop/src/renderer/styles/theme.css`: official-brand accent tokens with neutral surfaces.
- `packages/desktop/src/renderer/i18n/locales/*.json`: user-facing copy.
- `packages/desktop/test/*.test.ts(x)`: focused regression coverage.
- `e2e/local-file-artifact-loop.spec.ts`: real file/artifact acceptance.

### Task 1: Upgrade the account-scoped profile contract

**Files:**

- Modify: `packages/desktop/src/renderer/lib/user-onboarding.ts`
- Modify: `packages/desktop/test/user-onboarding.test.ts`

- [ ] **Step 1: Write failing migration and recommendation tests**

Add tests proving that a stored v1 profile loads as v2 defaults without losing `useCases` or `customGoal`, and that role/use-case/custom-goal matches return explainable assistant IDs.

```ts
expect(loadOnboardingProfile('u-1', storage)).toMatchObject({
  version: 2,
  role: 'custom',
  selectedAssistantIds: [],
  useCases: ['content'],
});
expect(recommendAssistants(profile).map((item) => item.id)).toContain('content');
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `pnpm --filter @clawwork/desktop test -- user-onboarding.test.ts`

Expected: FAIL because v2 fields and `recommendAssistants` do not exist.

- [ ] **Step 3: Implement the minimal v2 profile and migration**

Add `OnboardingRoleId`, response-detail and file-permission preference types. Keep the same account storage key so existing users migrate in place. Normalize free text before matching and return both assistant ID and a short reason.

- [ ] **Step 4: Run focused tests and commit**

Run: `pnpm --filter @clawwork/desktop test -- user-onboarding.test.ts`

Commit: `feat(onboarding): add role-aware profile recommendations`

### Task 2: Build the four-step onboarding and edit flow

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/Onboarding/index.tsx`
- Modify: `packages/desktop/test/onboarding-screen.test.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/zh-TW.json`
- Modify: `packages/desktop/src/renderer/i18n/locales/en.json`
- Modify: remaining locale JSON files with safe English fallback copy

- [ ] **Step 1: Write failing wizard behavior tests**

Cover role selection, custom role, use-case/free goal, generated assistant recommendations, assistant toggles, back navigation, personalization, and final v2 payload.

```tsx
fireEvent.click(screen.getByRole('button', { name: /运营负责人/ }));
fireEvent.click(screen.getByRole('button', { name: /下一步/ }));
expect(screen.getByText(/你最想先完成什么/)).toBeTruthy();
```

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @clawwork/desktop test -- onboarding-screen.test.tsx`

Expected: FAIL because the current screen is a single-step form.

- [ ] **Step 3: Implement the four-step wizard**

Use one state object and a numeric step. Render the official-brand stepper, neutral cards, one primary action, and a back action. Reuse `GuideMascot`; do not copy AI-U盾 names, enterprise login, fake local-only claims, or fake counts.

- [ ] **Step 4: Add edit-mode initialization**

Accept `initialProfile` and `mode: 'first-run' | 'edit'`. Edit mode preloads values and uses “保存设置” instead of completing setup.

- [ ] **Step 5: Run focused tests, i18n check, and commit**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- onboarding-screen.test.tsx
pnpm check:i18n
```

Commit: `feat(onboarding): add four-step guided setup`

### Task 3: Allow users to edit their purpose from Account settings

**Files:**

- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Settings/index.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Settings/sections/AccountSection.tsx`
- Modify: `packages/desktop/test/settings-ui-regressions.test.tsx`

- [ ] **Step 1: Write failing account action tests**

Assert that Account shows the current profile summary and invokes `onEditOnboarding` without signing out or clearing Tasks.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @clawwork/desktop test -- settings-ui-regressions.test.tsx`

- [ ] **Step 3: Thread typed callbacks through App and Settings**

App owns `editingOnboarding`. Saving calls `saveOnboardingProfile`, updates `onboardingProfile`, closes settings, and returns to the personalized home. Cancelling returns to Account settings with no mutation.

- [ ] **Step 4: Add profile and permission summary rows**

Show role, selected purposes, custom goal, current device fingerprint, and a truthful statement that external file access is requested explicitly. Do not add deletion behavior for disk files.

- [ ] **Step 5: Run tests and commit**

Commit: `feat(account): add purpose and authorization center`

### Task 4: Replace the beta updater simulation with the real updater

**Files:**

- Create: `packages/desktop/src/renderer/features/internal-beta/update-service.ts`
- Create: `packages/desktop/test/internal-beta-update-service.test.ts`
- Modify: `packages/desktop/src/renderer/features/internal-beta/InternalBetaHub.tsx`
- Modify: `packages/desktop/test/internal-beta-hub.test.tsx`

- [ ] **Step 1: Write failing adapter tests**

Test no-update, update-available, check failure, download failure, download completion and install request. Inject the existing `window.clawwork` surface so the service is testable without Electron mocks leaking into UI tests.

- [ ] **Step 2: Verify RED**

Run: `pnpm --filter @clawwork/desktop test -- internal-beta-update-service.test.ts`

- [ ] **Step 3: Implement the adapter and bind the view**

Return a discriminated state object. Subscribe to existing update progress/download/error events and clean them up on unmount. Remove simulated rollback and display release-side rollback as explanatory copy only.

- [ ] **Step 4: Run tests and commit**

Commit: `feat(beta): connect update center to electron updater`

### Task 5: Add the real admin entry and redacted beta analytics

**Files:**

- Modify: `packages/desktop/src/renderer/features/internal-beta/beta-store.ts`
- Modify: `packages/desktop/src/renderer/features/internal-beta/InternalBetaHub.tsx`
- Modify: `packages/desktop/test/internal-beta-store.test.ts`
- Modify: `packages/desktop/test/internal-beta-hub.test.tsx`
- Modify: `packages/desktop/src/renderer/env.d.ts`

- [ ] **Step 1: Write failing event and URL tests**

Assert that module actions append timestamped event types, reject empty content, avoid duplicate install/check-in events, and never serialize keys named `phone`, `licenseKey`, `token`, `prompt`, or `content`. Assert that the admin button is disabled without `VITE_ADMIN_CONSOLE_URL` and opens only that configured URL when present.

- [ ] **Step 2: Verify RED**

Run:

```powershell
pnpm --filter @clawwork/desktop test -- internal-beta-store.test.ts
pnpm --filter @clawwork/desktop test -- internal-beta-hub.test.tsx
```

- [ ] **Step 3: Upgrade local beta storage and action validation**

Persist a bounded recent event list, derive counters from events plus explicit seed baseline, and return action results where the UI needs success/error feedback. Preserve v1 data through defensive loading.

- [ ] **Step 4: Add the truthful admin card and analytics timeline**

Use `window.open(url, '_blank', 'noopener,noreferrer')`. Do not embed keys or bypass Auth. Mark all local module data as company-beta data.

- [ ] **Step 5: Run tests and commit**

Commit: `feat(beta): add admin entry and redacted activity analytics`

### Task 6: Apply the official visual language to the first-run surfaces

**Files:**

- Modify: `packages/desktop/src/renderer/styles/theme.css`
- Modify: `packages/desktop/src/renderer/layouts/Login/index.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Onboarding/index.tsx`
- Modify: `packages/desktop/src/renderer/features/internal-beta/InternalBetaHub.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Settings/sections/AccountSection.tsx`
- Modify: relevant UI regression tests

- [ ] **Step 1: Add regression assertions before styling**

Assert one primary action per onboarding step, a visible step label, keyboard focus classes, truthful running-state copy, and no “数据不出内网” promise.

- [ ] **Step 2: Verify RED**

Run the onboarding, beta hub, dashboard and settings UI tests.

- [ ] **Step 3: Add restrained brand tokens**

Add semantic brand-start/brand-end/action tokens. Use the gradient only for logo/primary action/current selection. Keep neutral surfaces and existing semantic status colors. Preserve dark mode and reduced-motion behavior.

- [ ] **Step 4: Polish the target surfaces**

Match the reference hierarchy, not its fake data: narrow global navigation, clear current assistant header, calm assistant empty state, scan-friendly market entries, compact skill rows, and remaining-balance-first billing.

- [ ] **Step 5: Run UI contract, renderer copy and focused tests**

Run:

```powershell
pnpm check:ui-contract
pnpm check:renderer-copy
pnpm --filter @clawwork/desktop test -- onboarding-screen.test.tsx internal-beta-hub.test.tsx dashboard-overview.test.tsx settings-ui-regressions.test.tsx
```

Commit: `style(beta): align first-run surfaces with official brand`

### Task 7: Repair the real file/artifact E2E and close verification

**Files:**

- Modify: `e2e/local-file-artifact-loop.spec.ts`
- Modify only if required by a reproduced bug: file/artifact production sources

- [ ] **Step 1: Make the fixture use an isolated task root**

Assert collision-safe behavior by using the actual imported result path instead of assuming the source basename remains unchanged.

- [ ] **Step 2: Run the E2E and verify GREEN**

Run: `pnpm exec playwright test --config=e2e/playwright.config.ts --project=artifact-loop`

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

- [ ] **Step 4: Commit the acceptance work**

Commit: `test(desktop): verify local file artifact delivery loop`

### Task 8: Tag, merge, package and smoke test

**Files:**

- No product source changes unless packaging exposes a reproducible defect.

- [ ] **Step 1: Confirm clean worktrees and create rollback tags**

Create dated annotated tags on the desktop release branch and backend master before merging. Preserve the existing untracked backend directories and the nine user-owned locale changes in the original desktop checkout.

- [ ] **Step 2: Merge the feature branches without rewriting history**

Merge `feat/local-file-artifact-loop` into `feat/stage3b-demo-polish`, and `feat/admin-console-foundation` into backend `master`. Resolve only verified conflicts and rerun focused tests after each merge.

- [ ] **Step 3: Build the Windows package**

Run: `pnpm --filter @clawwork/desktop build:win`

Record installer path, size, SHA-256, source commit and build time.

- [ ] **Step 4: Smoke test the installed build**

Verify launch, login, four-step onboarding, activation, startup readiness, assistant selection, real response, remaining credits, file import, artifact save, restart recovery and admin link. Mark new-phone/new-machine steps as external pending if the required hardware or SMS number is unavailable.
