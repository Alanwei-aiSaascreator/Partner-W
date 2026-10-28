# Partner-W Preset Agent Pack Design

**Date:** 2026-09-14

## Goal

Turn the approved seven-role product structure into real OpenClaw agents. A user keeps the existing `main` agent as Compass Assistant and can install six focused assistants from the welcome screen.

## Product behavior

The welcome screen shows one compact setup row when one or more partner-w assistants are missing. The row explains that setup adds focused assistants and provides one primary action. During installation it shows progress. After success the gateway catalog refreshes and the existing assistant selector displays all available agents.

The six installed assistants are:

| Stable ID             | Product role          | Primary work                                            |
| --------------------- | --------------------- | ------------------------------------------------------- |
| `partner-w-content`   | Content Creation      | topics, structure, drafting, rewriting                  |
| `partner-w-video`     | Video Production      | scripts, storyboards, shot lists, edit plans            |
| `partner-w-office`    | Office Productivity   | documents, meetings, reports, tables                    |
| `partner-w-ecommerce` | E-commerce Operations | listings, comparisons, service replies, operating plans |
| `partner-w-research`  | Learning and Research | question framing, evidence, summaries, study plans      |
| `partner-w-family`    | Home and Family       | meals, travel, schedules, family activities             |

The app continues to present `main` as Compass Assistant. This batch does not overwrite files in `main`, change the gateway default agent, install third-party executable skills, or add an online agent marketplace.

## Open-source intake

Reference repositories are downloaded outside the application repository. Only repositories with a verified commercial-friendly license may contribute text. The production prompts are original Partner-W adaptations with source, revision, license, and usage notes recorded in `docs/open-source-agent-provenance.md`.

The app ships a reviewed snapshot. It never downloads prompts from GitHub at runtime.

## Agent definition

Each preset is an immutable definition containing a stable ID, a stable ASCII creation name, a localized display-name key, an emoji, a short capability summary, `IDENTITY.md`, and `SOUL.md`.

Each `SOUL.md` follows the same operating contract:

1. identify the user's desired result;
2. ask only for missing information that changes the result;
3. produce a usable first draft early;
4. distinguish supplied facts, assumptions, and unknowns;
5. finish with concrete next actions;
6. answer in the user's language, defaulting to Simplified Chinese.

Role-specific prompts add task intake, workflow, output formats, quality checks, and boundaries. They avoid fictional biographies, exaggerated credentials, forced catchphrases, and game language.

## Installer

The installer receives the current gateway catalog and injected gateway operations. It compares stable IDs and installs only missing presets. For each missing preset it:

1. creates the agent with its stable ASCII name and isolated workspace;
2. updates the display name;
3. writes `IDENTITY.md`;
4. writes `SOUL.md`.

If a newly created agent cannot be fully configured, the installer deletes that new agent and reports the failed role. Already existing agents are not rewritten. Running installation again therefore repairs only missing roles and does not duplicate successful roles.

## Workspace layout

Preset workspaces live below the user's existing workspace root:

```text
<workspace-root>/partner-w-agents/<stable-id>
```

## UI and error handling

The setup row has four states: ready, installing, incomplete, and complete. It is disabled while the gateway or workspace root is unavailable. A partial failure names the roles that failed and leaves the action available for retry. Success refreshes `agents.list`; the row disappears once all six stable IDs are present.

No fake progress numbers, role levels, unlock language, or market-style cards are introduced.

## Verification

- catalog tests verify the six stable IDs and prompt structure;
- installer tests verify missing-only creation, file writes, rollback, and retry behavior;
- welcome-screen tests verify setup visibility, disabled state, installation, and refresh;
- TypeScript, architecture, renderer-copy, i18n, UI-contract comparison, and production build run before completion.
