# Local File and Artifact Delivery Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, restart-safe flow in which a user adds local files or a folder to one assistant task, the assistant processes those materials, and real output files appear as actionable artifacts.

**Architecture:** Electron main becomes the authority for task-scoped folder grants and native file import. SQLite stores grants and artifact metadata, while task folders store copied inputs and generated outputs. Focused renderer hooks expose materials and artifacts to the existing assistant welcome, composer, message, and right-panel surfaces without moving filesystem trust into React.

**Tech Stack:** TypeScript, Electron IPC/preload, React 19, Zustand, SQLite/better-sqlite3, Drizzle ORM, Vitest, Testing Library, Playwright, pnpm.

---

## File map

- `packages/shared/src/types.ts`: shared `TaskContextSource`, imported material and artifact availability types.
- `packages/desktop/src/main/db/schema.ts`: Drizzle definition for `task_context_sources`.
- `packages/desktop/src/main/db/index.ts`: idempotent SQLite table/index creation.
- `packages/desktop/src/main/context/source-service.ts`: create/list/revoke/revalidate grants and resolve a granted relative path safely.
- `packages/desktop/src/main/context/file-import.ts`: native multi-file selection and streaming copy into task `inbox`.
- `packages/desktop/src/main/ipc/context-handlers.ts`: task-scoped context and import IPC handlers.
- `packages/desktop/src/main/artifact/reconcile.ts`: discover real output files and reconcile them with `artifacts`.
- `packages/desktop/src/main/ipc/artifact-handlers.ts`: artifact availability, reconciliation and native Save As handlers.
- `packages/desktop/src/preload/index.ts` and `packages/desktop/src/preload/clawwork.d.ts`: typed renderer bridge.
- `packages/desktop/src/renderer/components/ChatInput/useTaskMaterials.ts`: task material loading, grant/import/remove and validity state.
- `packages/desktop/src/renderer/components/ChatInput/index.tsx`: compose the new materials UI without owning filesystem rules.
- `packages/desktop/src/renderer/components/TaskMaterials.tsx`: visible task materials and permission state.
- `packages/desktop/src/renderer/components/ArtifactCard.tsx`: shared open, reveal and Save As actions.
- `packages/desktop/src/renderer/layouts/MainArea/AssistantWorkspaceWelcome.tsx`: assistant-specific task entry connected to materials.
- `packages/desktop/src/renderer/layouts/RightPanel/index.tsx`: reuse artifact cards and show missing-file state.
- `packages/desktop/src/renderer/components/ChatMessage.tsx`: show newly generated artifact cards below the matching reply.
- `packages/desktop/src/renderer/i18n/locales/*.json`: complete copy for materials, grants, errors and artifact actions.
- `packages/desktop/test/*`: main-process service and handler tests.
- `packages/desktop/src/renderer/**/*.test.tsx`: renderer behavior tests.
- `e2e/local-file-artifact-loop.spec.ts`: real application acceptance path.

### Task 1: Add persistent task context source contracts

**Files:**

- Modify: `packages/shared/src/types.ts`
- Modify: `packages/desktop/src/main/db/schema.ts`
- Modify: `packages/desktop/src/main/db/index.ts`
- Test: `packages/desktop/test/db-context-sources.test.ts`

- [ ] **Step 1: Write the failing database migration test**

Create a temporary workspace, initialize the database twice, then assert the table and unique index exist:

```ts
it('creates task_context_sources idempotently', () => {
  initDatabase(workspace);
  reinitDatabase(workspace);
  const sqlite = getSqlite();
  const columns = sqlite.prepare('PRAGMA table_info(task_context_sources)').all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).toEqual([
    'id',
    'task_id',
    'kind',
    'absolute_path',
    'display_name',
    'created_at',
    'last_seen_at',
  ]);
  const index = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'task_context_sources_task_path'")
    .get();
  expect(index).toBeTruthy();
});
```

- [ ] **Step 2: Run the focused test and verify the missing-table failure**

Run: `pnpm --filter @clawwork/desktop test -- db-context-sources.test.ts`

Expected: FAIL because `task_context_sources` does not exist.

- [ ] **Step 3: Add shared types and the idempotent schema**

Add these contracts to `packages/shared/src/types.ts`:

```ts
export type TaskContextSourceKind = 'folder';

export interface TaskContextSource {
  id: string;
  taskId: string;
  kind: TaskContextSourceKind;
  absolutePath: string;
  displayName: string;
  createdAt: string;
  lastSeenAt: string;
  availability: 'available' | 'missing';
}

export interface ImportedTaskFile {
  fileName: string;
  localPath: string;
  mimeType: string;
  size: number;
}

export type ImportFileRejectionReason = 'unsupported' | 'too-large' | 'unavailable' | 'copy-failed';

export interface ImportFilesResult {
  imported: ImportedTaskFile[];
  rejected: Array<{ fileName: string; reason: ImportFileRejectionReason }>;
}
```

Define the Drizzle table with the same column names and create this SQL in `openDatabaseAt`:

```sql
CREATE TABLE IF NOT EXISTS task_context_sources (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind = 'folder'),
  absolute_path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS task_context_sources_task_path
ON task_context_sources(task_id, absolute_path);
```

- [ ] **Step 4: Run the migration test and typecheck the shared and desktop packages**

Run: `pnpm --filter @clawwork/desktop test -- db-context-sources.test.ts && pnpm --filter @clawwork/shared exec tsc -b && pnpm --filter @clawwork/desktop exec tsc --noEmit`

Expected: PASS with no TypeScript errors.

- [ ] **Step 5: Commit the schema slice**

```bash
git add packages/shared/src/types.ts packages/desktop/src/main/db/schema.ts packages/desktop/src/main/db/index.ts packages/desktop/test/db-context-sources.test.ts
git commit -m "feat(context): persist task folder grants"
```

### Task 2: Make Electron main the folder-grant authority

**Files:**

- Create: `packages/desktop/src/main/context/source-service.ts`
- Modify: `packages/desktop/src/main/ipc/context-handlers.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/clawwork.d.ts`
- Test: `packages/desktop/test/context-source-service.test.ts`
- Test: `packages/desktop/test/context-handlers.test.ts`

- [ ] **Step 1: Write failing service tests for grant, restore, revoke and path escape**

Cover these exact behaviors:

```ts
it('resolves only files below a grant owned by the same task', () => {
  const source = createFolderSource({ taskId: 'task-1', absolutePath: allowedFolder });
  expect(resolveGrantedFile('task-1', source.id, 'notes/a.txt')).toBe(realAllowedFile);
  expect(() => resolveGrantedFile('task-2', source.id, 'notes/a.txt')).toThrow('context source not granted');
  expect(() => resolveGrantedFile('task-1', source.id, '../secret.txt')).toThrow('path outside granted folder');
});

it('reports a restored missing folder without deleting its record', () => {
  const source = createFolderSource({ taskId: 'task-1', absolutePath: missingFolder });
  expect(listTaskContextSources('task-1')).toEqual([
    expect.objectContaining({ id: source.id, availability: 'missing' }),
  ]);
});

it('revokes the grant and blocks later reads', () => {
  const source = createFolderSource({ taskId: 'task-1', absolutePath: allowedFolder });
  revokeTaskContextSource('task-1', source.id);
  expect(() => resolveGrantedFile('task-1', source.id, 'a.txt')).toThrow('context source not granted');
});
```

On platforms that permit test symlinks, add a symlink inside the grant pointing outside and assert it is rejected after `realpathSync`.

- [ ] **Step 2: Run the service tests and verify module-not-found failure**

Run: `pnpm --filter @clawwork/desktop test -- context-source-service.test.ts context-handlers.test.ts`

Expected: FAIL because the service and task-scoped handlers are absent.

- [ ] **Step 3: Implement the focused service API**

Export only this public surface from `source-service.ts`:

```ts
export function createFolderSource(input: { taskId: string; absolutePath: string }): TaskContextSource;
export function listTaskContextSources(taskId: string): TaskContextSource[];
export function revokeTaskContextSource(taskId: string, sourceId: string): boolean;
export function resolveGrantedFile(taskId: string, sourceId: string, relativePath: string): string;
export function listGrantedFiles(taskId: string, sourceId: string, query?: string): FileIndexEntry[];
```

Canonicalize paths with `realpathSync`, compare with `resolve(root) + sep`, reject absolute `relativePath` values, and reuse `scanFolder` plus `readContextFile` only after the grant lookup succeeds.

- [ ] **Step 4: Replace renderer-supplied folder lists with task-scoped IPC**

Register these handlers:

```ts
context:grant-folder       { taskId }
context:list-sources       { taskId }
context:revoke-source      { taskId, sourceId }
context:list-source-files  { taskId, sourceId, query? }
context:read-source-file   { taskId, sourceId, relativePath }
```

`context:grant-folder` must open the native directory picker and call `createFolderSource`; canceled selection returns `{ ok: true, result: null }`. Remove public preload access to the old `readContextFile(absolutePath, folders)` contract after all callers move in Task 4.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @clawwork/desktop test -- context-source-service.test.ts context-handlers.test.ts && pnpm --filter @clawwork/desktop exec tsc --noEmit`

Expected: PASS and no renderer-visible method accepts an arbitrary allowlist of absolute folders.

- [ ] **Step 6: Commit the security boundary**

```bash
git add packages/desktop/src/main/context/source-service.ts packages/desktop/src/main/ipc/context-handlers.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/clawwork.d.ts packages/desktop/test/context-source-service.test.ts packages/desktop/test/context-handlers.test.ts
git commit -m "feat(context): enforce task scoped folder access"
```

### Task 3: Import selected files through the main process

**Files:**

- Create: `packages/desktop/src/main/context/file-import.ts`
- Modify: `packages/desktop/src/main/ipc/context-handlers.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/clawwork.d.ts`
- Test: `packages/desktop/test/context-file-import.test.ts`

- [ ] **Step 1: Write failing import tests**

Use temporary source and workspace folders and assert:

```ts
it('copies multiple supported files into the task inbox with unique names', async () => {
  const result = await importTaskFiles({
    workspacePath,
    taskId: 'task-1',
    sourcePaths: [firstReport, secondReport],
  });
  expect(result.imported.map((file) => file.fileName)).toEqual(['report.docx', 'report-2.docx']);
  expect(result.imported.every((file) => file.localPath.startsWith('task-1/inbox/'))).toBe(true);
  expect(result.rejected).toEqual([]);
});

it('rejects an oversized or unsupported file without copying it', async () => {
  const result = await importTaskFiles({ workspacePath, taskId: 'task-1', sourcePaths: [unsupportedExe] });
  expect(result.rejected).toEqual([{ fileName: 'unsafe.exe', reason: 'unsupported' }]);
  expect(readdirSync(inbox)).toEqual([]);
});
```

Also cover canceled selection, safe-name handling and a source disappearing between selection and copy.

- [ ] **Step 2: Run the test and verify the missing importer failure**

Run: `pnpm --filter @clawwork/desktop test -- context-file-import.test.ts`

Expected: FAIL because `file-import.ts` is absent.

- [ ] **Step 3: Implement native selection and streaming copy**

Implement:

```ts
export async function importTaskFiles(input: {
  workspacePath: string;
  taskId: string;
  sourcePaths: string[];
}): Promise<ImportFilesResult>;

export function listImportedTaskFiles(workspacePath: string, taskId: string): ImportedTaskFile[];
```

Use `copyFile` from `node:fs/promises`, `ensureTaskDir`, an `inbox` subdirectory, `uniqueFileName`, `classifyTier`, `getMimeType`, and a 100 MB per-file ceiling. Return one `ImportedTaskFile` per successful copy and one structured rejection per failed file while keeping successfully copied siblings visible. `listImportedTaskFiles` scans only the task's workspace-safe `inbox`, allowing the renderer to restore imported inputs after restart.

- [ ] **Step 4: Add the typed `context:import-files` bridge**

The import IPC handler accepts `{ taskId }`, opens `showOpenDialog` with `openFile` and `multiSelections`, then calls the importer. Add `context:list-imported-files` accepting `{ taskId }` and returning the workspace-safe inbox listing. Both use these shared types:

```ts
type ImportFilesResult = import('@clawwork/shared').ImportFilesResult;
```

- [ ] **Step 5: Run focused tests and typecheck**

Run: `pnpm --filter @clawwork/desktop test -- context-file-import.test.ts context-handlers.test.ts && pnpm --filter @clawwork/desktop exec tsc --noEmit`

Expected: PASS, including partial success with explicit rejected-file reasons.

- [ ] **Step 6: Commit native file import**

```bash
git add packages/desktop/src/main/context/file-import.ts packages/desktop/src/main/ipc/context-handlers.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/clawwork.d.ts packages/desktop/test/context-file-import.test.ts packages/desktop/test/context-handlers.test.ts
git commit -m "feat(context): import task files natively"
```

### Task 4: Add restart-safe task materials state and UI

**Files:**

- Create: `packages/desktop/src/renderer/components/ChatInput/useTaskMaterials.ts`
- Create: `packages/desktop/src/renderer/components/TaskMaterials.tsx`
- Modify: `packages/desktop/src/renderer/components/ChatInput/index.tsx`
- Modify: `packages/desktop/src/renderer/components/ChatInput/useChatSend.ts`
- Delete: `packages/desktop/src/renderer/components/ChatInput/useContextFolders.ts`
- Test: `packages/desktop/src/renderer/components/ChatInput/useTaskMaterials.test.tsx`
- Test: `packages/desktop/src/renderer/components/TaskMaterials.test.tsx`
- Test: `packages/desktop/src/renderer/components/ChatInput/useChatSend.test.tsx`

- [ ] **Step 1: Write failing hook and component tests**

Assert the hook reloads sources when `activeTaskId` changes, a missing source stays visible, revoke updates both main and renderer state, and imported files appear without base64 conversion in React:

```tsx
expect(screen.getByText('季度报表')).toBeInTheDocument();
expect(screen.getByText('需要重新选择')).toBeInTheDocument();
await user.click(screen.getByRole('button', { name: '移除季度报表' }));
expect(api.revokeTaskContextSource).toHaveBeenCalledWith('task-1', 'source-1');
```

For sending, assert selected source files call `readTaskContextFile(taskId, sourceId, relativePath)` and the old arbitrary `folders` array is never passed.

- [ ] **Step 2: Run focused renderer tests and verify failure**

Run: `pnpm --filter @clawwork/desktop test -- useTaskMaterials.test.tsx TaskMaterials.test.tsx useChatSend.test.tsx`

Expected: FAIL because the hook/component and secure send contract are absent.

- [ ] **Step 3: Implement `useTaskMaterials` as the sole renderer coordinator**

The hook returns this stable interface:

```ts
interface TaskMaterialsController {
  sources: TaskContextSource[];
  importedFiles: ImportedTaskFile[];
  selectedImportedFiles: ImportedTaskFile[];
  sourceFiles: FileIndexEntry[];
  loading: boolean;
  grantFolder(): Promise<void>;
  importFiles(): Promise<void>;
  toggleImportedFile(localPath: string): void;
  removeImportedFileFromDraft(localPath: string): void;
  revokeSource(sourceId: string): Promise<void>;
  loadSourceFiles(sourceId: string, query?: string): Promise<void>;
}
```

Load grants from SQLite and imported files from the task inbox through preload on each task change. Newly imported files become selected for the current draft; removing a chip removes it from the draft, not from disk or earlier messages. Message attachments continue to persist which copied inputs were actually sent; do not upload absolute source paths.

- [ ] **Step 4: Build the reusable visible materials strip**

`TaskMaterials` renders imported file chips and folder grant chips with available/missing status. It exposes only callbacks and shared types; it must not call preload directly. Use existing semantic buttons and CSS variables, with no black surface or raw filesystem command text.

- [ ] **Step 5: Integrate the two first-level plus-menu actions and secure send path**

Replace the hidden browser file input as the primary desktop path with `importFiles()`. Keep paste support as an attachment convenience. Replace `useContextFolders` with `useTaskMaterials`, and make the mention picker identify local files by `sourceId + relativePath`. Before send, read each selected imported copy with the existing workspace-safe `readInboxFile(localPath)` bridge, add its base64 and MIME type to gateway attachments, and persist the same `localPath` in the visible message attachment. Clear only the draft selection after a successful dispatch; copied inbox files remain available for restart and reuse.

- [ ] **Step 6: Run renderer tests, i18n check and typecheck**

Run: `pnpm --filter @clawwork/desktop test -- useTaskMaterials.test.tsx TaskMaterials.test.tsx useChatSend.test.tsx && pnpm check:i18n && pnpm --filter @clawwork/desktop exec tsc --noEmit`

Expected: PASS and no call site remains for `readContextFile(absolutePath, folders)`.

- [ ] **Step 7: Commit the task-material experience**

```bash
git add packages/desktop/src/renderer/components/ChatInput packages/desktop/src/renderer/components/TaskMaterials.tsx packages/desktop/src/renderer/i18n/locales packages/desktop/src/renderer/components/TaskMaterials.test.tsx
git commit -m "feat(chat): add restart safe task materials"
```

### Task 5: Reconcile real generated files into artifacts

**Files:**

- Create: `packages/desktop/src/main/artifact/reconcile.ts`
- Modify: `packages/desktop/src/main/ipc/artifact-handlers.ts`
- Modify: `packages/desktop/src/main/ipc/data-handlers.ts`
- Test: `packages/desktop/test/artifact-reconcile.test.ts`
- Test: `packages/desktop/test/data-handlers-artifacts.test.ts`

- [ ] **Step 1: Write failing reconciliation tests**

Create a task folder containing an `inbox` file, a hidden file, a zero-byte temporary file, and a real `总结.docx`, then assert only the real output is registered:

```ts
const saved = await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1' });
expect(saved).toEqual([expect.objectContaining({ name: '总结.docx', type: 'file', localPath: 'task-1/总结.docx' })]);
expect(await reconcileTaskArtifacts({ workspacePath, taskId: 'task-1', messageId: 'msg-1' })).toEqual([]);
```

Add tests for a file whose size changes during the first stability check and for an externally deleted artifact.

- [ ] **Step 2: Run reconciliation tests and verify missing-module failure**

Run: `pnpm --filter @clawwork/desktop test -- artifact-reconcile.test.ts data-handlers-artifacts.test.ts`

Expected: FAIL because reconciliation is not implemented.

- [ ] **Step 3: Implement stable output discovery**

Export:

```ts
export async function reconcileTaskArtifacts(input: {
  workspacePath: string;
  taskId: string;
  messageId: string;
}): Promise<Artifact[]>;

export function getArtifactAvailability(localPath: string, workspacePath: string): 'available' | 'missing';
```

Scan only the task directory, skip `inbox`, dot files, names ending in `.tmp`, `.part` or `~`, and zero-byte files. Compare size and mtime twice with one bounded 250 ms retry. Use `sourceKey = workspace-file:<normalized-relative-path>:<size>:<mtimeMs>` and insert without copying the file onto itself.

- [ ] **Step 4: Trigger reconciliation at the actual completed-turn boundary**

After an assistant final message has been persisted and existing `autoExtractArtifacts` completes, call reconciliation with that message id. Emit `artifact:saved` once for each new row. A reconciliation error is logged as `artifact_reconcile_failed` and does not change the successful chat result.

- [ ] **Step 5: Run tests and typecheck**

Run: `pnpm --filter @clawwork/desktop test -- artifact-reconcile.test.ts data-handlers-artifacts.test.ts artifact-handlers.test.ts && pnpm --filter @clawwork/desktop exec tsc --noEmit`

Expected: PASS with no duplicate artifact event on history reload or repeated final events.

- [ ] **Step 6: Commit artifact reconciliation**

```bash
git add packages/desktop/src/main/artifact/reconcile.ts packages/desktop/src/main/ipc/artifact-handlers.ts packages/desktop/src/main/ipc/data-handlers.ts packages/desktop/test/artifact-reconcile.test.ts packages/desktop/test/data-handlers-artifacts.test.ts
git commit -m "feat(artifacts): register generated workspace files"
```

### Task 6: Add artifact availability and Save As actions

**Files:**

- Modify: `packages/shared/src/types.ts`
- Modify: `packages/desktop/src/main/ipc/artifact-handlers.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/clawwork.d.ts`
- Create: `packages/desktop/src/renderer/components/ArtifactCard.tsx`
- Modify: `packages/desktop/src/renderer/layouts/RightPanel/index.tsx`
- Modify: `packages/desktop/src/renderer/components/ChatMessage.tsx`
- Test: `packages/desktop/test/artifact-handlers.test.ts`
- Test: `packages/desktop/src/renderer/components/ArtifactCard.test.tsx`

- [ ] **Step 1: Write failing handler and card tests**

Handler tests must assert Save As uses `dialog.showSaveDialog`, cancellation is success with `result: null`, and the copy never silently overwrites without the native dialog result. Card tests assert all three actions and missing state:

```tsx
expect(screen.getByRole('button', { name: '打开文件' })).toBeEnabled();
expect(screen.getByRole('button', { name: '打开所在目录' })).toBeEnabled();
expect(screen.getByRole('button', { name: '另存为' })).toBeEnabled();
rerender(<ArtifactCard artifact={{ ...artifact, availability: 'missing' }} />);
expect(screen.getByText('文件已不在本机')).toBeInTheDocument();
expect(screen.getByRole('button', { name: '打开文件' })).toBeDisabled();
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `pnpm --filter @clawwork/desktop test -- artifact-handlers.test.ts ArtifactCard.test.tsx`

Expected: FAIL because Save As and availability UI do not exist.

- [ ] **Step 3: Implement typed availability and Save As IPC**

Extend renderer-facing artifacts with optional `availability?: 'available' | 'missing'` so existing artifact constructors remain compatible. `artifact:list` always computes it from the workspace-safe resolved path. Add `artifact:save-as` accepting only `localPath`; resolve it with the existing workspace boundary guard, open the native Save As dialog using the artifact name, then `copyFile` to the selected destination.

- [ ] **Step 4: Build and reuse `ArtifactCard`**

Render thumbnail, name, format, size, relative time, status and three actions. The card calls callbacks passed by its parent; it does not know task stores or database details. Use it below the matching assistant reply and in `RightPanel`.

- [ ] **Step 5: Run tests, i18n and typecheck**

Run: `pnpm --filter @clawwork/desktop test -- artifact-handlers.test.ts ArtifactCard.test.tsx ChatMessage.test.tsx && pnpm check:i18n && pnpm --filter @clawwork/desktop exec tsc --noEmit`

Expected: PASS, canceled Save As is silent, and missing artifacts remain visible.

- [ ] **Step 6: Commit artifact actions**

```bash
git add packages/shared/src/types.ts packages/desktop/src/main/ipc/artifact-handlers.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/clawwork.d.ts packages/desktop/src/renderer/components/ArtifactCard.tsx packages/desktop/src/renderer/layouts/RightPanel/index.tsx packages/desktop/src/renderer/components/ChatMessage.tsx packages/desktop/src/renderer/i18n/locales packages/desktop/test/artifact-handlers.test.ts packages/desktop/src/renderer/components/ArtifactCard.test.tsx
git commit -m "feat(artifacts): add open reveal and save as actions"
```

### Task 7: Connect professional assistant guidance to the closed loop

**Files:**

- Modify: `packages/desktop/src/renderer/layouts/MainArea/AssistantWorkspaceWelcome.tsx`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: `packages/desktop/src/renderer/lib/preset-agents.ts`
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`
- Test: `packages/desktop/src/renderer/layouts/MainArea/AssistantWorkspaceWelcome.test.tsx`
- Test: `packages/desktop/src/renderer/layouts/MainArea/MainArea.test.tsx`

- [ ] **Step 1: Write failing welcome-flow tests**

For `partner-w-office`, assert the page renders its own description, four office starters, Add File and Add Folder actions, and selecting a starter fills the task composer without sending automatically. Repeat a table-driven identity assertion for all seven built-in assistants so no page falls back to the main assistant name.

- [ ] **Step 2: Run tests and verify missing action failure**

Run: `pnpm --filter @clawwork/desktop test -- AssistantWorkspaceWelcome.test.tsx MainArea.test.tsx`

Expected: FAIL because the welcome surface cannot yet add task materials.

- [ ] **Step 3: Extend the welcome component through explicit callbacks**

Use this component boundary:

```ts
interface AssistantWorkspaceWelcomeProps {
  definition: AssistantWorkspaceDefinition;
  onSelectPrompt(prompt: string): void;
  onAddFiles(): void;
  onAddFolder(): void;
  materials: ReactNode;
}
```

Keep assistant-specific text in `preset-agents.ts` and i18n. Do not duplicate filesystem logic or create seven separate chat implementations.

- [ ] **Step 4: Keep tool progress semantic and bounded**

Reuse the existing grouped tool-activity renderer. Add only the four phase labels required by the design and a regression test proving ten raw `ls`/`read` calls render as one expandable `读取资料` group rather than ten full-width rows.

- [ ] **Step 5: Run UI tests, i18n, architecture and typecheck**

Run: `pnpm --filter @clawwork/desktop test -- AssistantWorkspaceWelcome.test.tsx MainArea.test.tsx tool-activity && pnpm check:i18n && pnpm check:architecture && pnpm --filter @clawwork/desktop exec tsc --noEmit`

Expected: PASS for all seven assistant identities and grouped progress.

- [ ] **Step 6: Commit assistant integration**

```bash
git add packages/desktop/src/renderer/layouts/MainArea packages/desktop/src/renderer/lib/preset-agents.ts packages/desktop/src/renderer/i18n/locales packages/desktop/src/renderer/components
git commit -m "feat(assistants): guide file to artifact tasks"
```

### Task 8: Verify the complete source and packaged flow

**Files:**

- Create: `e2e/local-file-artifact-loop.spec.ts`
- Modify: `docs/status/2026-09-15-basic-demo-progress.md`
- Modify: `docs/status/2026-09-15-demo-bug-fix-log.md`

- [ ] **Step 1: Add the end-to-end regression**

Use a temporary user-data directory and fixture workspace. The E2E test must cover: open high-efficiency office assistant, import a fixture document, grant a fixture folder, send a deterministic fake-gateway task, create a real result file, display one artifact card, invoke open/reveal handlers through test seams, reload the window, and confirm materials and artifact recovery. A second case sets quota to zero and asserts no model or tool dispatch occurs.

- [ ] **Step 2: Run the new E2E test in source mode**

Run: `pnpm exec playwright test --config=e2e/playwright.config.ts e2e/local-file-artifact-loop.spec.ts`

Expected: PASS for normal and zero-quota cases.

- [ ] **Step 3: Run the complete quality gate**

Run: `pnpm check:i18n && pnpm check:architecture && pnpm typecheck && pnpm test && pnpm --filter @clawwork/desktop build`

Expected: all existing and new tests pass, every typecheck passes, architecture guardrails pass, and Electron production build completes.

- [ ] **Step 4: Build the Windows installer**

Run: `pnpm --filter @clawwork/desktop build:win`

Expected: a Windows x64 installer, `latest.yml` and blockmap are created from the current commit. Record their names, timestamps, sizes and SHA-256 values in the progress report.

- [ ] **Step 5: Perform the clean-environment manual acceptance**

Use a fresh Windows user-data directory and no development commands inside the product. Complete the exact seven-step acceptance in the design: import Word/PDF/Excel, generate a real summary, inspect grouped progress, open/reveal/Save As, restart and recover, invalidate a folder, then repeat with zero quota.

- [ ] **Step 6: Update status evidence and commit**

Record exact test counts, installer identity, manual outcomes and any remaining limitation. Then commit only the E2E and status files:

```bash
git add e2e/local-file-artifact-loop.spec.ts docs/status/2026-09-15-basic-demo-progress.md docs/status/2026-09-15-demo-bug-fix-log.md
git commit -m "test(demo): verify local file artifact loop"
```

## Final completion gate

Before calling the feature complete, verify all eight task commits exist, `git status --short` is empty, the full quality gate is green, the current commit is present in the packaged build record, and the clean-environment acceptance contains evidence for both a successful real-file task and a blocked zero-quota task.
