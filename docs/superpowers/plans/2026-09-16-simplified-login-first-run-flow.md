# Simplified Login and First-Run Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove duplicated purpose selection from login and guarantee first-time users see onboarding before workspace setup and the main workspace.

**Architecture:** Keep login authentication behavior unchanged, remove its business-purpose state, and centralize entry-screen precedence in a pure resolver consumed by `App.tsx`. Preserve backward compatibility by leaving the existing login-purpose reader available to onboarding.

**Tech Stack:** React 19, TypeScript, Vitest, Electron Vite, Tailwind CSS.

---

### Task 1: Simplify the login brand panel

**Files:**

- Modify: `packages/desktop/test/login-screen.test.tsx`
- Modify: `packages/desktop/src/renderer/layouts/Login/index.tsx`

- [ ] **Step 1: Write the failing test**

Change the purpose test to assert that `[data-login-purpose]` is absent and that no login-purpose value is written while the brand region, mascot, and permission copy remain present.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @clawwork/desktop test -- login-screen.test.tsx --run`

Expected: FAIL because four purpose buttons still render.

- [ ] **Step 3: Write minimal implementation**

Remove `LOGIN_PURPOSES`, purpose state, persistence, imports, and the two-column purpose grid from the login component. Replace the fluid marketing heading with a fixed product heading that keeps the left panel quiet.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @clawwork/desktop test -- login-screen.test.tsx --run`

Expected: all login tests pass.

- [ ] **Step 5: Commit**

Commit: `feat(onboarding): simplify login entry`

### Task 2: Enforce the first-run route order

**Files:**

- Create: `packages/desktop/src/renderer/lib/app-entry-flow.ts`
- Create: `packages/desktop/test/app-entry-flow.test.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`

- [ ] **Step 1: Write the failing test**

Add table-driven tests for `resolveAppEntryScreen` covering checking, required login, unresolved onboarding, missing onboarding profile, missing workspace setup, and ready workspace states.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @clawwork/desktop test -- app-entry-flow.test.ts --run`

Expected: FAIL because the resolver does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement a pure resolver returning `loading`, `login`, `onboarding`, `setup`, or `workspace`. In `App.tsx`, use the resolver so onboarding is selected before setup after successful authentication.

- [ ] **Step 4: Run focused tests**

Run: `pnpm --filter @clawwork/desktop test -- app-entry-flow.test.ts onboarding-screen.test.tsx login-screen.test.tsx --run`

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

Commit: `fix(onboarding): guide first-time users before setup`

### Task 3: Verify the end-to-end UI foundation

**Files:**

- Modify only if verification exposes an issue in the files above.

- [ ] **Step 1: Run static checks**

Run: `pnpm --filter @clawwork/desktop exec tsc --noEmit && pnpm check:i18n`

Expected: both commands pass.

- [ ] **Step 2: Run desktop tests**

Run: `pnpm --filter @clawwork/desktop test -- --run`

Expected: all desktop tests pass except documented skips.

- [ ] **Step 3: Build the desktop renderer**

Run: `pnpm --filter @clawwork/desktop build`

Expected: Electron Vite production build succeeds.

- [ ] **Step 4: Inspect the running login screen**

Confirm the brand panel is visually quiet, contains no purpose controls, and the login form remains the single obvious action.

- [ ] **Step 5: Commit verification fixes if needed**

Only commit files required to resolve a verification failure; otherwise keep the two feature commits as the completed rollback points.
