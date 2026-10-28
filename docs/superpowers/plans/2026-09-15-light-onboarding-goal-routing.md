# Light Onboarding and Goal Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a real, rollback-safe desktop Demo with a light first-use experience, physically correct mascot arms, visible custom-goal input, in-workspace startup progress, and model-driven assistant recommendation or confirmed custom-agent creation.

**Architecture:** Keep the existing authentication, onboarding profile, startup readiness, gateway catalog, system session, and agent mutation sources of truth. Add one presentational mascot component and one isolated goal-analysis feature whose pure parsing and persistence code is testable without Electron; integrate the feature into the existing `MainArea` only after entitlement and conversation readiness are true.

**Tech Stack:** React 19, TypeScript, Zustand, Framer Motion, Tailwind CSS v4, Vitest/jsdom, i18next, Electron IPC.

---

## File map

**Create**

- `packages/desktop/src/renderer/components/GuideMascot.tsx`: one SVG skeleton with pointer tracking and real arm-group poses.
- `packages/desktop/src/renderer/features/goal-routing/goal-analysis.ts`: prompt construction, response parsing, validation, stable version key, and persistence.
- `packages/desktop/src/renderer/features/goal-routing/useGoalAnalysis.ts`: readiness-gated system-session orchestration.
- `packages/desktop/src/renderer/features/goal-routing/GoalRecommendationPanel.tsx`: recommendation, retry, preview, and confirmed creation UI.
- `packages/desktop/test/guide-mascot.test.tsx`: mascot pose and accessibility tests.
- `packages/desktop/test/goal-analysis.test.ts`: pure goal-analysis and persistence tests.
- `packages/desktop/test/goal-recommendation-panel.test.tsx`: recommendation and confirmation tests.

**Modify**

- `packages/core/src/stores/ui-store.ts`: default new profiles to light while preserving stored or settings-provided choices.
- `packages/core/test/ui-store-layout.test.ts`: theme default and explicit-theme preservation tests.
- `packages/desktop/src/renderer/context/ThemeProvider.tsx`: distinguish first-run default from an explicit saved theme.
- `packages/desktop/src/renderer/styles/theme.css`: light navigation, selection, onboarding, and progress tokens.
- `packages/desktop/src/renderer/layouts/Login/index.tsx`: two-zone light login and mascot focus states.
- `packages/desktop/src/renderer/layouts/Onboarding/index.tsx`: keep custom goal above the fold and reuse the mascot.
- `packages/desktop/src/renderer/lib/user-onboarding.ts`: add a stable goal version helper without changing stored profile version.
- `packages/desktop/test/onboarding-screen.test.tsx`: custom-goal-only submission and visible guidance.
- `packages/desktop/test/user-onboarding.test.ts`: stable goal version behavior.
- `packages/desktop/src/renderer/layouts/MainArea/StartupReadinessPanel.tsx`: semantic combined progress and 90-second recovery UI.
- `packages/desktop/src/renderer/layouts/MainArea/index.tsx`: render goal routing after readiness and disable AI input before readiness.
- `packages/desktop/src/renderer/App.tsx`: pass account/profile and entitlement context into `MainArea` without creating a second data source.
- `packages/desktop/src/renderer/lib/agent-builder.ts`: extend transactional creation through identity-file writing and duplicate protection.
- `packages/desktop/test/agent-builder.test.ts`: identity failure rollback and duplicate-confirmation tests.
- `packages/desktop/src/renderer/i18n/locales/*.json`: customer-facing text for login, onboarding, startup, goal recommendation, and errors.
- `docs/status/2026-09-15-basic-demo-progress.md`: record actual verification results and remaining installer rehearsal work.

## Task 1: Make light the safe first-run theme

**Files:**

- Modify: `packages/core/src/stores/ui-store.ts`
- Modify: `packages/core/test/ui-store-layout.test.ts`
- Modify: `packages/desktop/src/renderer/context/ThemeProvider.tsx`
- Modify: `packages/desktop/src/renderer/styles/theme.css`

- [ ] **Step 1: Write failing store tests**

Add tests proving a store with no saved setting starts with `theme === 'light'`, while `setTheme('dark')` and a loaded desktop setting still win.

```ts
it('uses light for a profile without an explicit theme', () => {
  const store = createUiStore(deps());
  expect(store.getState().theme).toBe('light');
});

it('keeps an explicit dark preference', () => {
  const store = createUiStore(deps());
  store.getState().setTheme('dark');
  expect(store.getState().theme).toBe('dark');
});
```

- [ ] **Step 2: Run the focused test and confirm the first case fails**

Run: `pnpm --filter @clawwork/core test -- ui-store-layout.test.ts`  
Expected: FAIL because the initial theme is currently `auto`.

- [ ] **Step 3: Change only the first-run default and light surface tokens**

Set the core initial value to `light`. Keep `ThemeProvider` hydration authoritative once settings load. Add semantic tokens such as `--surface-rail`, `--surface-assistant-rail`, `--surface-onboarding-accent`, and `--selection-soft`; components must consume variables rather than inline hex values.

- [ ] **Step 4: Run focused store and theme tests**

Run: `pnpm --filter @clawwork/core test -- ui-store-layout.test.ts && pnpm --filter @clawwork/desktop test -- theme-provider.test.tsx`  
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/core/src/stores/ui-store.ts packages/core/test/ui-store-layout.test.ts packages/desktop/src/renderer/context/ThemeProvider.tsx packages/desktop/src/renderer/styles/theme.css
git commit -m "feat(theme): default new users to light surfaces"
```

## Task 2: Build a physically coherent mascot

**Files:**

- Create: `packages/desktop/src/renderer/components/GuideMascot.tsx`
- Create: `packages/desktop/test/guide-mascot.test.tsx`

- [ ] **Step 1: Write failing component tests**

Render `GuideMascot` in `idle` and `covering` poses. Assert there are exactly two elements with `data-arm`, the covering pose applies a pose marker to those same elements, and no `data-floating-hand` element exists.

```tsx
expect(container.querySelectorAll('[data-arm]')).toHaveLength(2);
expect(container.querySelectorAll('[data-arm][data-pose="covering"]')).toHaveLength(2);
expect(container.querySelector('[data-floating-hand]')).toBeNull();
```

- [ ] **Step 2: Run the test and confirm the component is missing**

Run: `pnpm --filter @clawwork/desktop test -- guide-mascot.test.tsx`  
Expected: FAIL because `GuideMascot.tsx` does not exist.

- [ ] **Step 3: Implement one SVG skeleton**

Expose `pose: 'idle' | 'phone' | 'covering' | 'success'` and `trackPointer?: boolean`. Each arm is one `<motion.g data-arm>` containing upper arm, forearm, and hand paths. Animate the full group from the shoulder transform origin; never render a second hand layer. Limit pupil travel to a few SVG units and use `useReducedMotion()` to disable tracking and interpolate directly between static poses.

- [ ] **Step 4: Test pose transitions and reduced motion**

Run: `pnpm --filter @clawwork/desktop test -- guide-mascot.test.tsx`  
Expected: PASS with two arm groups in every pose.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/renderer/components/GuideMascot.tsx packages/desktop/test/guide-mascot.test.tsx
git commit -m "feat(onboarding): add coherent guide mascot motion"
```

## Task 3: Redesign the real login surface

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/Login/index.tsx`
- Create: `packages/desktop/test/login-screen.test.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`

- [ ] **Step 1: Write failing login interaction tests**

Mock OTP IPC. Assert the page has a light brand region and form region, focusing the code field changes the mascot to `covering`, blurring restores `idle`, and sending or verifying still calls the existing IPC with `+86` phone normalization.

- [ ] **Step 2: Run the login test before implementation**

Run: `pnpm --filter @clawwork/desktop test -- login-screen.test.tsx`  
Expected: FAIL on the missing two-region structure and mascot state.

- [ ] **Step 3: Replace the centered form with a responsive two-zone layout**

Keep `sendCode`, `submit`, cooldown, agreement links, and error mapping unchanged. Add a restrained brand explanation, device/account trust points, and `GuideMascot`. Bind phone focus to `phone`, code focus to `covering`, and successful verification to `success`. At narrow widths stack the regions without horizontal scrolling.

- [ ] **Step 4: Run login and renderer-copy checks**

Run: `pnpm --filter @clawwork/desktop test -- login-screen.test.tsx && pnpm check:renderer-copy && pnpm check:i18n`  
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/renderer/layouts/Login packages/desktop/src/renderer/components/GuideMascot.tsx packages/desktop/test/login-screen.test.tsx packages/desktop/src/renderer/i18n/locales
git commit -m "feat(login): ship light interactive sign-in experience"
```

## Task 4: Put the custom goal above the fold

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/Onboarding/index.tsx`
- Modify: `packages/desktop/src/renderer/lib/user-onboarding.ts`
- Modify: `packages/desktop/test/onboarding-screen.test.tsx`
- Modify: `packages/desktop/test/user-onboarding.test.ts`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`

- [ ] **Step 1: Add failing tests for custom-goal-only completion**

Set the textarea to `我想整理抖音素材，每周生成三个短视频脚本`, click continue without a preset, and assert `onComplete` receives an empty `useCases` array plus the trimmed goal. Add a pure test showing equal normalized goals yield the same stable version key.

- [ ] **Step 2: Run both tests and confirm the version helper is absent**

Run: `pnpm --filter @clawwork/desktop test -- onboarding-screen.test.tsx user-onboarding.test.ts`  
Expected: FAIL on the missing stable helper and new guidance contract.

- [ ] **Step 3: Recompose the onboarding page**

Use a light two-column desktop layout with purpose choices and custom input in the primary column, a pale mascot/preview region in the secondary column, and no black surface. Keep the existing `OnboardingProfile` schema. Export `goalAnalysisVersion(profile)` that hashes a normalized tuple of user ID, use cases, and custom goal using a deterministic non-cryptographic string hash suitable for local idempotency.

- [ ] **Step 4: Run onboarding tests and i18n checks**

Run: `pnpm --filter @clawwork/desktop test -- onboarding-screen.test.tsx user-onboarding.test.ts && pnpm check:i18n`  
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add packages/desktop/src/renderer/layouts/Onboarding packages/desktop/src/renderer/lib/user-onboarding.ts packages/desktop/test/onboarding-screen.test.tsx packages/desktop/test/user-onboarding.test.ts packages/desktop/src/renderer/i18n/locales
git commit -m "feat(onboarding): foreground custom user goals"
```

## Task 5: Add pure goal analysis and account-scoped persistence

**Files:**

- Create: `packages/desktop/src/renderer/features/goal-routing/goal-analysis.ts`
- Create: `packages/desktop/test/goal-analysis.test.ts`

- [ ] **Step 1: Write failing parser and persistence tests**

Cover a valid preset response, a valid custom draft, unknown assistant ID, missing fields, fenced JSON, one analysis per version, and a new analysis after the goal changes.

````ts
const result = parseGoalAnalysis(
  '```goal-analysis\n{"kind":"preset","assistantId":"content","summary":"短视频内容","reason":"需要选题和脚本","model":"deepseek-v4-flash","starters":["整理素材","生成选题","写脚本"]}\n```',
);
expect(result.kind).toBe('preset');
````

- [ ] **Step 2: Run the pure test and confirm imports fail**

Run: `pnpm --filter @clawwork/desktop test -- goal-analysis.test.ts`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement constrained types and parsing**

Define `PresetGoalAnalysis`, `CustomGoalAnalysis`, and `GoalAnalysisResult`. Whitelist preset IDs, require three non-empty starters, cap all customer-visible strings, require custom drafts to contain `name`, `description`, `identity`, and `model`, and reject extra executable instructions. Build a Chinese system prompt that asks for one fenced `goal-analysis` JSON block and explicitly forbids claiming that files were inspected.

- [ ] **Step 4: Implement versioned storage**

Use keys shaped as `partner-w:goal-analysis:v1:<userId>:<goalVersion>`. Export load/save functions with injected storage for tests. Invalid JSON returns `null`; successful results only are persisted.

- [ ] **Step 5: Run the pure test**

Run: `pnpm --filter @clawwork/desktop test -- goal-analysis.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/desktop/src/renderer/features/goal-routing/goal-analysis.ts packages/desktop/test/goal-analysis.test.ts
git commit -m "feat(goals): validate and persist assistant routing"
```

## Task 6: Gate real analysis on entitlement and startup readiness

**Files:**

- Create: `packages/desktop/src/renderer/features/goal-routing/useGoalAnalysis.ts`
- Create: `packages/desktop/test/use-goal-analysis.test.tsx`
- Modify: `packages/desktop/src/renderer/App.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`

- [ ] **Step 1: Write failing hook tests**

Inject a fake session adapter and assert no call occurs when the goal is empty, entitlement is false, or `conversationReady` is false. Assert exactly one `purpose: 'goal-analysis'` session starts when all gates become true, the result persists, and remounting with the same goal version does not start another session.

- [ ] **Step 2: Run the hook test and confirm failure**

Run: `pnpm --filter @clawwork/desktop test -- use-goal-analysis.test.tsx`  
Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement the readiness-gated hook**

Use `useSystemSession` through a small injectable adapter. Start with the selected gateway and default `main` agent only after all gates are true. Observe the final assistant message when streaming returns to active, parse it, persist success, and expose `idle | waiting | analyzing | ready | error` plus `retry()`. Guard the version with a module-level in-flight map so Strict Mode cannot double-call.

- [ ] **Step 4: Pass existing truth into MainArea**

Pass `onboardingAccount.userId`, `onboardingProfile`, `startupReadiness.conversationReady`, selected gateway/model data, and the existing commercial entitlement state. Do not add a second balance query; if App currently lacks a stable entitlement selector, gate on the existing commercial balance/license result already used by the composer.

- [ ] **Step 5: Run hook, startup, and TypeScript checks**

Run: `pnpm --filter @clawwork/desktop test -- use-goal-analysis.test.tsx startup-readiness.test.ts startup-readiness-screen.test.tsx && pnpm --filter @clawwork/desktop exec tsc --noEmit`  
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/desktop/src/renderer/features/goal-routing/useGoalAnalysis.ts packages/desktop/test/use-goal-analysis.test.tsx packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/layouts/MainArea/index.tsx
git commit -m "feat(goals): analyze saved goals when AI is ready"
```

## Task 7: Show recommendations and create custom assistants transactionally

**Files:**

- Create: `packages/desktop/src/renderer/features/goal-routing/GoalRecommendationPanel.tsx`
- Create: `packages/desktop/test/goal-recommendation-panel.test.tsx`
- Modify: `packages/desktop/src/renderer/lib/agent-builder.ts`
- Modify: `packages/desktop/test/agent-builder.test.ts`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`

- [ ] **Step 1: Write failing recommendation UI tests**

For a preset result, assert “使用这个助手” selects only after click and starter clicks fill rather than send. For a custom result, assert the Prompt preview is available, no mutation happens before confirmation, cancellation is side-effect free, and repeated confirmation while pending invokes creation once.

- [ ] **Step 2: Write failing transaction tests**

Extend `agent-builder.test.ts` so identity-file failure deletes the created agent and duplicate stable draft IDs return the existing result instead of creating another assistant.

- [ ] **Step 3: Run both files and confirm failure**

Run: `pnpm --filter @clawwork/desktop test -- goal-recommendation-panel.test.tsx agent-builder.test.ts`  
Expected: FAIL on missing UI and incomplete identity transaction.

- [ ] **Step 4: Extend the transaction boundary**

Extend `createAgentWithRollback` parameters with optional `identityContent` and injected `setAgentFile`. After model configuration, write `IDENTITY.md`; if it fails, delete the created agent with files. Accept a stable draft key and check the fresh catalog before creation to prevent duplicates. Return the created `agentId` on success.

- [ ] **Step 5: Implement the recommendation panel**

Render compact states for waiting, analyzing, preset, custom, and error. Existing assistant selection uses `useUiStore.setSelectedAgent`; starter actions populate the current composer draft. Custom creation derives a safe workspace slug, resolves the workspace base path, calls the transaction helper, forces an agent catalog refresh, selects the created ID, and leaves the generated goal tasks visible.

- [ ] **Step 6: Run focused tests and i18n checks**

Run: `pnpm --filter @clawwork/desktop test -- goal-recommendation-panel.test.tsx agent-builder.test.ts && pnpm check:i18n`  
Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add packages/desktop/src/renderer/features/goal-routing packages/desktop/src/renderer/lib/agent-builder.ts packages/desktop/test/goal-recommendation-panel.test.tsx packages/desktop/test/agent-builder.test.ts packages/desktop/src/renderer/layouts/MainArea/index.tsx packages/desktop/src/renderer/i18n/locales
git commit -m "feat(goals): confirm and create tailored assistants"
```

## Task 8: Refine in-workspace startup progress

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/MainArea/StartupReadinessPanel.tsx`
- Modify: `packages/desktop/test/startup-readiness-screen.test.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`

- [ ] **Step 1: Add failing semantic progress tests**

Assert the shell remains rendered while readiness is false, composer controls are disabled, progress represents AI plus assistant phases rather than assistants alone, and a fake 90-second timer reveals explanation and retry.

- [ ] **Step 2: Run the readiness screen test**

Run: `pnpm --filter @clawwork/desktop test -- startup-readiness-screen.test.tsx`  
Expected: FAIL on combined progress and composer lock assertions.

- [ ] **Step 3: Implement honest combined progress**

Derive a four-stage presentation from existing readiness fields: connection, model catalog, assistants completed, ready. Use only real booleans/counts. Add `aria-busy`, stage text, percentage text, retry, and an expandable technical detail region. Keep the full application shell mounted.

- [ ] **Step 4: Disable only AI-dependent controls**

During startup, allow navigation and local history browsing; disable send/model actions and show why near the composer. When `conversationReady` changes to true, enable the existing composer without remounting or discarding its draft.

- [ ] **Step 5: Run readiness and MainArea tests**

Run: `pnpm --filter @clawwork/desktop test -- startup-readiness-screen.test.tsx startup-readiness.test.ts`  
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add packages/desktop/src/renderer/layouts/MainArea/StartupReadinessPanel.tsx packages/desktop/src/renderer/layouts/MainArea/index.tsx packages/desktop/test/startup-readiness-screen.test.tsx packages/desktop/src/renderer/i18n/locales
git commit -m "feat(startup): prepare AI inside the visible workspace"
```

## Task 9: Verify model, quota, tools, and assistant-specific behavior did not regress

**Files:**

- Modify only if a failing test demonstrates a defect in the scoped flow.
- Modify: `docs/status/2026-09-15-basic-demo-progress.md`

- [ ] **Step 1: Run focused commercial and interaction suites**

Run: `pnpm --filter @clawwork/desktop test -- commercial-default-model.test.ts model-display.test.ts chat-message-model-badge.test.tsx quota-display.test.ts usage-from-server.test.ts tool-activity.test.ts tool-call-summary.test.tsx assistant-workspace-welcome.test.tsx`  
Expected: PASS; default selection and reply labels remain `deepseek-v4-flash`, quota UI remains “remaining”, tool calls remain semantically grouped, and assistants keep distinct welcome content.

- [ ] **Step 2: Run repository checks**

Run: `pnpm check:architecture && pnpm check:renderer-copy && pnpm check:i18n && pnpm typecheck && pnpm typecheck:tests`  
Expected: all commands exit 0.

- [ ] **Step 3: Run the full test baseline**

Run: `pnpm test`  
Expected: all packages pass with no failed tests; record the actual final count rather than retaining the old 862 figure.

- [ ] **Step 4: Build the desktop application**

Run: `pnpm --filter @clawwork/desktop build`  
Expected: renderer, preload, and main builds exit 0.

- [ ] **Step 5: Update the status document with evidence**

Record the exact test count, build result, remaining clean-environment rehearsal, and whether the Windows installer has been rebuilt. Do not claim the installer is current until `build:win` finishes successfully.

- [ ] **Step 6: Commit verification documentation**

```powershell
git add docs/status/2026-09-15-basic-demo-progress.md
git commit -m "docs: report light onboarding demo verification"
```

## Task 10: Launch and visually review the real Demo

**Files:**

- Modify only defects found during the review, with a targeted regression test added first.

- [ ] **Step 1: Start the real desktop app**

Run: `pnpm dev`  
Expected: Electron opens without a renderer exception.

- [ ] **Step 2: Review at approximately 1266×800 and a wider desktop size**

Check login, phone/code focus, physical arm movement, purpose selection, custom-goal-only continuation, activation, visible shell during startup, 90-second recovery state using test controls, recommendation, custom draft confirmation, and assistant selection.

- [ ] **Step 3: Rehearse with real services**

Use a non-restricted fresh mobile number and an unused activation path. Confirm SMS arrival, activation/account binding, `deepseek-v4-flash` request and reply labels, real balance decrement, restart persistence, and no requirement for a development command or database edit inside the user flow.

- [ ] **Step 4: Fix each observed defect test-first**

For each defect, add one reproducing test, run it to see the failure, apply the smallest scoped correction, and rerun the focused test before continuing the rehearsal.

- [ ] **Step 5: Run final checks after visual fixes**

Run: `pnpm check && pnpm --filter @clawwork/desktop build`  
Expected: all checks and the production build exit 0.

- [ ] **Step 6: Create the review commit**

```powershell
git add packages/desktop docs/status/2026-09-15-basic-demo-progress.md
git commit -m "fix(demo): polish verified first-use flow"
```

## Rollback and delivery rules

- The immutable pre-change recovery point is `demo-before-light-onboarding-v3-20260915` at `ed750e5`.
- Do not delete or overwrite `docs/prototypes/partner-w-login-to-workspace-v2.html`; it remains the comparison artifact.
- Do not rewrite authentication, billing, SMS, gateway, or model protocols in this plan.
- Do not let target analysis scan the computer automatically. Files require explicit user selection or upload.
- Do not build a Windows installer until the real desktop Demo passes the focused and full verification steps.
- Keep each task in its own commit so the user can retain visual improvements while reverting goal routing or vice versa.
