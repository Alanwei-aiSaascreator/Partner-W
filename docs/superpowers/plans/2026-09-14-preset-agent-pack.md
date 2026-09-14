# Preset Agent Pack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add six real, reviewed Rongying Cube agents and an idempotent welcome-screen installer.

**Architecture:** Keep the preset catalog and prompt assets bundled with the renderer. A dependency-injected installer performs gateway mutations and rolls back incomplete new agents. The welcome screen owns only presentation state and refreshes the existing gateway catalog after installation.

**Tech Stack:** Electron 34, React 19, TypeScript, OpenClaw gateway RPC, Vitest, react-i18next.

---

### Task 1: Record open-source provenance

**Files:**

- Create: `docs/open-source-agent-provenance.md`

- [ ] Record each downloaded repository URL, pinned commit, license, reviewed files, and whether text was incorporated.
- [ ] Exclude repositories without a repository-level license from production text reuse.
- [ ] Verify the document contains no missing revision or license fields.

### Task 2: Define the preset catalog and prompts

**Files:**

- Create: `packages/desktop/test/preset-agents.test.ts`
- Create: `packages/desktop/src/renderer/lib/preset-agents.ts`
- Create: `packages/desktop/src/renderer/preset-agents/*/IDENTITY.md`
- Create: `packages/desktop/src/renderer/preset-agents/*/SOUL.md`

- [ ] Write a failing test expecting exactly the six approved stable IDs, unique creation names, two non-empty files per role, and the shared truthfulness/language rules.
- [ ] Run `pnpm --filter @clawwork/desktop exec vitest run test/preset-agents.test.ts` and confirm it fails because the catalog module is missing.
- [ ] Add the typed immutable catalog and original role prompt assets.
- [ ] Run the same test and confirm it passes.

### Task 3: Build the idempotent installer

**Files:**

- Create: `packages/desktop/test/preset-agent-installer.test.ts`
- Create: `packages/desktop/src/renderer/lib/preset-agent-installer.ts`

- [ ] Write failing tests showing that existing stable IDs are skipped, missing roles are created and configured, and failed configuration rolls back only the newly created agent.
- [ ] Run `pnpm --filter @clawwork/desktop exec vitest run test/preset-agent-installer.test.ts` and confirm it fails because the installer is missing.
- [ ] Implement `installPresetAgentPack` with injected `createAgent`, `updateAgent`, `setAgentFile`, and `deleteAgent` operations.
- [ ] Return a structured summary containing installed, skipped, and failed stable IDs.
- [ ] Run the installer tests and confirm they pass.

### Task 4: Add localized setup control

**Files:**

- Create: `packages/desktop/src/renderer/layouts/MainArea/PresetAgentPackControl.tsx`
- Create: `packages/desktop/test/preset-agent-pack-control.test.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`

- [ ] Write a failing component test for the ready, installing, and retry states.
- [ ] Add all user-facing copy to i18n.
- [ ] Implement the compact setup row with one primary action and accessible status text.
- [ ] Run the component test and confirm it passes.

### Task 5: Connect installation to the welcome screen

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/MainArea/WelcomeScreen.tsx`
- Modify: `packages/desktop/test/welcome-screen.test.tsx`

- [ ] Extend the welcome-screen test so missing presets show setup, installation calls the gateway APIs, and success refreshes the catalog.
- [ ] Obtain the existing workspace root, build isolated preset paths, call the installer, and refresh `agents.list`.
- [ ] Hide setup when all six stable IDs already exist.
- [ ] Run the welcome and installer tests together.

### Task 6: Verify and commit

**Files:**

- Modify only files listed above if verification finds a batch-specific defect.

- [ ] Run targeted Vitest tests for preset agents, installer, setup control, welcome screen, onboarding, and chat send.
- [ ] Run desktop TypeScript, ESLint, formatting, architecture, renderer-copy, and i18n checks.
- [ ] Run the production desktop build.
- [ ] Compare UI-contract output with the five existing baseline violations and remove any new violation.
- [ ] Commit with `feat(agents): add preset assistant pack` and push `feat/stage3b-demo-polish`.
