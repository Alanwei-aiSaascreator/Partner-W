# Message Persistence Architecture — Full Reference

> This file contains the detailed architecture. The CRITICAL invariant (single-writer table + prohibited patterns) is in `docs/agent-rules/message-persistence.md`.

## Assistant Message State Machine

```
                                         sync succeeds
  ┌────────┐  first delta  ┌───────────┐  state=final  ┌─────────┐  ──────────►  ┌───────────┐
  │  idle  │ ────────────► │ streaming │ ────────────► │ pending │               │ canonical │
  └────────┘               └───────────┘               └─────────┘  ◄──────────  └───────────┘
                                                           │        sync fails       ▲
                                                           └─► retry (backoff) ──────┘
                                                           └─► reconnect ────────────┘
                                                           └─► startup sync ─────────┘
```

| State     | Storage                          | In DB | In UI                          |
| --------- | -------------------------------- | ----- | ------------------------------ |
| streaming | `streamingByTask[taskId]`        | No    | Yes (live text)                |
| pending   | `pendingAssistantByTask[taskId]` | No    | Yes (finalized, awaiting sync) |
| canonical | `messagesByTask[taskId]`         | Yes   | Yes (persisted history)        |

**Invariant**: These three storages never contain the same message simultaneously. Streaming becomes pending on `final`. Pending becomes canonical on sync success. Pending is cleared (not promoted) on `error`/`aborted`.

## Key Functions and Their Roles

| Function              | Role                                                                                                                                                      | MUST NOT                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `finalizeStream`      | State transition: streaming → pending. Clears streaming buffers unconditionally.                                                                          | Write to DB. Write to `messagesByTask`.                                             |
| `syncSessionMessages` | Runtime sync: pending → canonical. Fetches `chat.history`, persists to DB, calls `promotePending`. Serialized per task.                                   | Be called for `error`/`aborted` events.                                             |
| `syncFromGateway`     | Startup sync: recover history from Gateway on connect. For existing tasks, only syncs assistant messages. For new tasks, syncs all.                       | Write user messages for existing tasks (ChatInput is the sole user message writer). |
| `promotePending`      | Atomic Zustand update: append canonical to `messagesByTask` + merge pending's `thinkingContent`/`toolCalls`/`runId` + clear pending. Single `set()` call. | Execute as two separate updates (would cause UI flicker/duplication).               |
| `retrySyncPending`    | On Gateway reconnect, retries sync for all tasks with pending messages.                                                                                   | —                                                                                   |

## Sync Timing

- **Runtime sync**: Triggered immediately after each `state === 'final'` event. Retries with backoff (2s, 4s, 8s) on failure.
- **Startup sync**: Triggered once on first Gateway connect. Recovers messages that were pending when the app crashed.
- **Reconnect sync**: `retrySyncPending()` retries all pending tasks when Gateway reconnects.

## DB Unique Index

`messages_dedup ON messages(task_id, session_key, role, timestamp) WHERE role <> 'system'` is the single-writer idempotency guard for user and assistant messages. These roles keep their existing canonical tuple identity; a repeated write updates the existing row and retains its ID for artifact references. The IPC upsert uses a literal `targetWhere` matching the partial index predicate so SQLite can identify the conflict target.

Client-generated system messages use `messages.id` as their identity. Distinct IDs persist independently even when task, session, content and timestamp are identical. Replaying an ID updates that row; it does not replace the row or change its task, session or role. The IPC handler rejects reuse of any message ID with different task, session or role ownership before writing. Persisted system rows are looked up by ID; canonical user and assistant rows are looked up by their tuple.

Database startup replaces the previous all-role index inside one transaction. Migration preserves existing message rows, IDs, artifact foreign keys and FTS entries. If canonical conflicts prevent creating the index, the prior indexes remain intact and startup reports the error. This migration cannot recover system-message content already overwritten by an older release.

### Downgrade Compatibility

Older clients unconditionally recreate the all-role index at startup. After this migration has allowed two system messages in the same millisecond, an older client's index creation fails with a unique-constraint error. If no collision exists yet, that client can still reopen the workspace and resume the old overwriting behavior. Keep upgraded workspaces on a client containing this repair. To use an older client, use a separate copy of a pre-upgrade backup; do not delete system-message history to make the older index succeed.

## Protocol Limitation

OpenClaw Gateway `chat.history` does not return per-message IDs. The Gateway's `timestamp` (epoch ms) is the closest to a stable message identifier. The `runId` is present in streaming events but not in history responses. This is why single-writer architecture is necessary — without message IDs, any dual-write scheme requires fragile dedup.

## Past Bug Patterns

| Pattern                                 | Root Cause                                                                                                                                                              | Fix                                                                                                                                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assistant message doubled after restart | `finalizeStream` AND `syncFromGateway` both wrote assistant messages to DB (dual-write). Content/timestamp differed between streaming accumulation and Gateway history. | Eliminated dual-write: `finalizeStream` only writes to Zustand pending state; sync path is the sole DB writer for assistant messages. See "Message Persistence Architecture" section. |
| Startup hydration duplicates            | Race between `hydrateFromLocal` and `syncFromGateway`                                                                                                                   | Serialized via `hydrationPromise` + DB unique index (#126)                                                                                                                            |
