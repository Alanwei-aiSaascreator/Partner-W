# Blocking Startup Readiness Design

**Date:** 2026-09-15

## Goal

Make first launch trustworthy and predictable. Partner-W prepares the AI gateway, commercial model catalog, and six bundled assistants in parallel, shows honest progress, and opens the main workspace only when all three capabilities are ready.

## Problem

The current application can enter the workspace before the gateway has returned its model catalog. The composer then briefly presents an empty model state even though the service is still starting. Preset assistants are also configured from a separate welcome-screen card, which makes one startup process look like two unrelated setup tasks.

Production logs show a second defect: all six preset assistants were created successfully, but the renderer kept an earlier `{main}` agent catalog. `fetchAgentsForGateway` skips whenever any cached catalog exists, so the post-install refresh does not reach the gateway. A retry then calls `agents.create` for assistants that already exist and reports all six as failures. The product must refresh and reconcile the catalog before deciding that assistants are missing.

## Approved Product Behavior

This is the blocking B flow. The app starts the gateway, fetches models, and verifies or installs the bundled assistant pack concurrently. Authentication and first-use role selection remain available while preparation runs. After those steps, the application shows a dedicated readiness screen until every required capability is ready.

The expected first-launch duration is 50–70 seconds on a normal network and up to 90–120 seconds on a slow connection. Later launches usually take 30–45 seconds. These are explanatory estimates, not fake countdowns or simulated progress.

The application enters the main workspace only when:

1. the selected gateway is connected;
2. its catalog contains at least one usable commercial model;
3. all six stable preset assistant IDs are present in a freshly fetched gateway catalog.

## Startup Screen

The screen keeps the established Partner-W shell and Windows-following theme. It uses one centered preparation panel with two clear capability rows:

- **AI service** shows gateway startup, model preparation, ready, or an actionable model error;
- **Common assistants** shows a real `n / 6` count, the assistant currently being configured, a progress bar based only on completed assistant definitions, ready, or a named failure.

The panel explains that first launch may take about one minute and that the user can leave the application open. It does not show a spinner without text, invent percentages, add game language, or expose gateway and RPC implementation terms.

When the gateway or model catalog cannot become ready, the screen provides one retry action that restarts readiness checks. When assistant installation fails, it names the roles still missing and offers retry. Existing roles are never recreated or overwritten.

## Data Flow

`App` owns one startup-readiness hook. The hook is mounted as soon as the workspace is configured, including while authentication and onboarding screens are visible, so preparation overlaps user input. The hook reads gateway connection and model catalog state from the existing UI store and owns only preset-assistant reconciliation state.

After the selected gateway connects, the hook performs a forced agent-catalog refresh. It compares the fresh IDs with the six immutable bundled definitions. If roles are missing, it calls the existing preset installer, reports its real progress, then performs another forced refresh. Readiness is derived from the store plus installer state; the startup screen does not maintain a second model or gateway source of truth.

The renderer gateway adapter gains an explicit forced-refresh operation. The core dispatcher continues to cache ordinary agent-list requests, while a forced request bypasses the cache and replaces the catalog with the gateway response.

## Concurrency and Idempotence

Only one preset reconciliation may run per gateway at a time. React Strict Mode, reconnects, and repeated renders must join or ignore the in-flight operation rather than create duplicate assistants.

Every reconciliation starts from a fresh catalog. The installer skips stable IDs already present and writes only missing assistants. A post-create `already exists` response is reconciled by refreshing the catalog; if the stable ID is present, that role counts as complete. A retry therefore repairs missing roles without touching successful roles.

Preset `IDENTITY.md` and `SOUL.md` files remain packaged with the desktop application. Runtime startup does not download prompts, skills, or agent definitions from GitHub.

## Integration with Existing Screens

The welcome screen no longer owns a manual “configure common assistants” card or installation state. First-use role selection still personalizes the initial experience, but the six common assistants are part of the product and require no separate user decision.

The persistent assistant rail uses the refreshed catalog. Once the readiness gate opens, the rail must immediately contain Compass Assistant (`main`) plus all six bundled assistants.

## Accessibility and Localization

The preparation panel uses semantic status text, `aria-live="polite"` for changing state, `aria-busy` while work is active, and keyboard-accessible retry buttons. Status is communicated with text and icons as well as color. Customer-facing copy is present in all desktop locales with key parity.

## Non-goals

- No Stage 3A license-file discovery, activation RPC, USB code deletion, or activation-limit redesign.
- No online assistant marketplace or runtime GitHub download.
- No changes to billing, SMS authentication, model pricing, or the gateway protocol.
- No overwrite of an existing preset assistant's user-edited files.

## Acceptance Criteria

1. A cold start never calls a missing catalog “no models”; it shows gateway or model preparation.
2. After authentication and onboarding, the main workspace remains blocked until gateway, models, and all six assistants are ready.
3. The assistant row shows real completed count and current role; successful roles are not repeated during retry.
4. A pre-existing stale `{main}` catalog is forcibly refreshed before installation and again afterward.
5. If all six assistants already exist, startup performs no create or file-write calls.
6. Duplicate lifecycle triggers cannot start two installers for the same gateway.
7. Failure copy names missing roles and retry resumes from a freshly fetched catalog.
8. The welcome screen contains no separate assistant setup card.
9. On success, the persistent assistant rail shows `main` and all six bundled assistants without reloading the app.
10. Light, dark, TypeScript, i18n, targeted tests, production build, and the repository's established verification baseline are checked before completion.
