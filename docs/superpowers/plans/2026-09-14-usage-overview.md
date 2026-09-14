# Usage Overview Implementation Plan

**Goal:** Add a permanent usage-overview entry and reshape the existing Dashboard for a mass-market user while preserving verified billing data.

**Architecture:** Reuse the existing `dashboard` main view and its server-backed model usage. LeftNav owns discoverability; Dashboard combines local aggregate data with the commercial account overview, while detailed pricing remains opt-in inside each model row.

**Tech Stack:** Electron, React, TypeScript, Zustand, Vitest, react-i18next, Recharts, Lucide.

### Task 1: Add a permanent navigation entry

- [ ] Add a failing component test for expanded and collapsed usage-overview navigation.
- [ ] Add the Dashboard entry beside other primary navigation actions.
- [ ] Verify click behavior, accessible name, and active state.

### Task 2: Build the user-facing overview hierarchy

- [ ] Add a failing Dashboard component test with local stats, account quota, assistants, and model usage fixtures.
- [ ] Add page title, refresh action, four summary cards, common-assistant list, and account quota card.
- [ ] Mark local and account data scopes accurately.
- [ ] Keep missing account data distinct from a zero balance.

### Task 3: Simplify model consumption without losing transparency

- [ ] Default each model row to model, provider, calls, tokens, and charged credits.
- [ ] Add a user-controlled billing-details disclosure.
- [ ] Preserve the existing billing calculation labels and source data.
- [ ] Keep unavailable and empty model states distinct.

### Task 4: Retain recent usage trends

- [ ] Keep the 30-day input, output, credit, and daily trend view.
- [ ] Place it after the user-facing summary and label it as account data.
- [ ] Retain the empty trend state.

### Task 5: Verify and ship

- [ ] Run targeted Dashboard and navigation tests.
- [ ] Run desktop type checks, i18n, architecture, copy, targeted lint, and formatting checks.
- [ ] Run the desktop production build.
- [ ] Confirm UI-contract has no new failures beyond the known baseline.
- [ ] Inspect Dashboard in light and dark themes at approximately 1266×800.
- [ ] Commit and push `feat/stage3b-demo-polish`.
