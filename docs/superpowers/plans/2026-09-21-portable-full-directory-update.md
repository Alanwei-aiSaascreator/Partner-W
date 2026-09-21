# Portable Full-Directory Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a signed, resumable U-disk update path that prepares a complete 荣盈魔方 program directory in the background, swaps it through an external Windows launcher, and automatically rolls back without touching portable data or workspace directories.

**Architecture:** Keep installed-app updates on `electron-updater`, but route recognized portable runs to a new typed preparation service. The Electron app verifies a signed manifest, downloads and safely extracts a complete program directory on the same volume, then hands a verified transaction to a small Go launcher outside the replaceable directory. The launcher re-verifies the signed receipt and staged tree, performs an idempotent directory swap, waits for an application health receipt, and rolls back on failure.

**Tech Stack:** TypeScript 5.7, Electron 34, React 19, Vitest 3, Node crypto/fs/net APIs, `yauzl` for entry-by-entry ZIP extraction, Go 1.25 standard library for the launcher, Ed25519, RFC 8785-compatible canonical JSON over the restricted manifest schema, pnpm, electron-builder, GitHub Actions.

---

## Execution boundaries

- Work only in `D:\Desktop\new project\mofang-compass\mofang-compass-desktop\.worktrees\fix-local-credential-exposure`.
- Before every commit run `git log -1 --oneline` because other sessions may advance the branch.
- Use explicit pathspecs. Never run `git add -A`.
- The main checkout currently has unrelated i18n edits. Do not copy, discard, stage, or reformat them.
- Do not package a customer candidate, upload an update manifest, change the production feed, or publish a release without a separate user authorization.
- A local ZIP fixture and a locally built launcher are test artifacts, not a customer package.
- Keep `荣盈魔方-运行数据`, `荣盈魔方工作区`, and `.荣盈魔方更新` outside every replaceable-tree operation.
- Existing 0.0.25 packages remain manual-update packages. The first launcher-enabled base package must be distributed manually once.

## File map

### Shared contract

- Create `packages/shared/src/portable-update.ts`: manifest, file-list, transaction, public-state, error-code, and canonicalization contract.
- Create `packages/shared/test/portable-update.test.ts`: parser, canonicalization, state-transition, and redaction tests.
- Modify `packages/shared/src/index.ts`: export the contract.

### Electron main process

- Create `packages/desktop/src/main/update/portable-manifest.ts`: Ed25519 verification, version/channel/launcher gates.
- Create `packages/desktop/src/main/update/portable-package.ts`: download, space budget, safe ZIP extraction, exact-tree verification.
- Create `packages/desktop/src/main/update/portable-state.ts`: atomic state persistence and prepare-stage recovery.
- Create `packages/desktop/src/main/update/portable-update-service.ts`: portable check/download/cancel/handoff orchestration.
- Create `packages/desktop/src/main/update/portable-health.ts`: post-swap health receipt coordinator.
- Modify `packages/desktop/src/main/auto-updater.ts`: delegate portable runs instead of returning `portable-manual-update`.
- Modify `packages/desktop/src/main/ipc/update-handlers.ts`: expose typed portable state and renderer-ready acknowledgement.
- Modify `packages/desktop/src/main/index.ts`: initialize the service and report main/database/window readiness.

### Preload and renderer

- Modify `packages/desktop/src/preload/index.ts` and `packages/desktop/src/preload/clawwork.d.ts`: expose minimal update state APIs.
- Modify `packages/desktop/src/renderer/features/internal-beta/update-service.ts`: consume the expanded main-process state.
- Modify `packages/desktop/src/renderer/features/internal-beta/update-errors.ts`: map stable error codes to actions.
- Modify `packages/desktop/src/renderer/lib/update-status.ts`: make the main-process public state the UI truth source.
- Modify `packages/desktop/src/renderer/layouts/Settings/sections/AboutSection.tsx`: show download, verify, extract, ready, rollback, and retry states.
- Modify `packages/desktop/src/renderer/App.tsx`: send one renderer-ready acknowledgement.
- Modify all nine files under `packages/desktop/src/renderer/i18n/locales/`: add user-facing copy.

### External launcher

- Create `launcher/go.mod`: pinned Go toolchain, no runtime dependency.
- Create `launcher/internal/update/model.go`: JSON contract matching TypeScript.
- Create `launcher/internal/update/verify.go`: signature, path, and file-tree verification.
- Create `launcher/internal/update/state.go`: atomic state reads/writes and lock ownership.
- Create `launcher/internal/update/swap.go`: idempotent swap, recovery, health wait, rollback.
- Create `launcher/internal/update/*_test.go`: table and real-directory tests with fault injection.
- Create `launcher/internal/ui/windows.go`: minimal Windows status/error surface.
- Create `launcher/cmd/mofang-launcher/main.go`: startup, recovery, normal launch, and apply-update entrypoint.

### Release and delivery tooling

- Create `scripts/lib/portable-update-release.mjs` and test: exact file manifest, hashes, canonical signing payload, release validation.
- Create `scripts/make-portable-update.mjs`: build a local signed update fixture or authorized release artifact.
- Create `scripts/build-portable-launcher.mjs`: build the Windows launcher with the embedded public key.
- Create `scripts/assemble-udisk-delivery.mjs`: assemble the launcher-enabled base layout.
- Create `scripts/templates/udisk-readme.txt`: deterministic customer instructions.
- Modify `scripts/lib/udisk-delivery.mjs`, its test, `scripts/make-udisk-archive.mjs`, and archive tests: require the EXE launcher and continue rejecting `.bat`.
- Modify `package.json`, `.github/workflows/pr-check.yml`, and `.github/workflows/release.yml`: add Go tests/build and protected release inputs.
- Create `docs/runbooks/portable-update-release.md` and `docs/runbooks/portable-update-real-disk-acceptance.md`.

## Task 1: Shared portable-update contract

**Files:**

- Create: `packages/shared/src/portable-update.ts`
- Create: `packages/shared/test/portable-update.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the failing contract tests**

Add named tests covering canonical key ordering, Unicode values, unsafe numbers, schema parsing, secret-field rejection, allowed transitions, and public-state redaction. Use this fixture shape:

```ts
const manifest = {
  schemaVersion: 1,
  channel: 'internal',
  version: '0.0.26',
  minLauncherVersion: '1.0.0',
  packageUrl: 'https://api.rongyinghudong.com/updates/internal/0.0.26/portable.zip',
  packageSize: 1024,
  packageSha256: 'a'.repeat(64),
  fileManifestSha256: 'b'.repeat(64),
  publishedAt: '2026-09-21T00:00:00.000Z',
  mandatory: false,
  signature: 'c2lnbmF0dXJl',
} as const;
```

Assert that the public state contains only `phase`, versions, numeric progress, `errorCode`, and `updatedAt`; keys matching `/token|password|key|path|url|signature/i` must be absent.

- [ ] **Step 2: Run the tests and capture RED**

Run:

```powershell
pnpm --filter @clawwork/shared exec vitest run test/portable-update.test.ts
```

Expected: non-zero exit because `../src/portable-update.js` does not exist.

- [ ] **Step 3: Implement the exact contract**

Define these exports in `portable-update.ts`:

```ts
export const PORTABLE_UPDATE_SCHEMA_VERSION = 1 as const;

export type PortableUpdateChannel = 'stable' | 'internal';
export type PortableUpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying-archive'
  | 'extracting'
  | 'verifying-files'
  | 'ready'
  | 'applying'
  | 'awaiting-health'
  | 'committed'
  | 'rolled-back'
  | 'error';

export type PortableUpdateErrorCode =
  | 'network'
  | 'feed-response'
  | 'signature-invalid'
  | 'manifest-invalid'
  | 'unsupported-policy'
  | 'launcher-incompatible'
  | 'disk-space'
  | 'volume-readonly'
  | 'package-integrity'
  | 'archive-unsafe'
  | 'file-integrity'
  | 'file-in-use'
  | 'launcher-start-failed'
  | 'health-timeout'
  | 'rollback-failed'
  | 'cancelled'
  | 'unknown';

export interface PortableUpdateManifestV1 {
  schemaVersion: 1;
  channel: PortableUpdateChannel;
  version: string;
  minLauncherVersion: string;
  packageUrl: string;
  packageSize: number;
  packageSha256: string;
  fileManifestSha256: string;
  publishedAt: string;
  mandatory: false;
  signature: string;
}

export interface PortableUpdateFileEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface PortableUpdateFileManifestV1 {
  schemaVersion: 1;
  version: string;
  files: PortableUpdateFileEntry[];
}

export interface PortableUpdatePublicState {
  phase: PortableUpdatePhase;
  currentVersion: string;
  targetVersion?: string;
  transferred?: number;
  total?: number;
  percent?: number;
  errorCode?: PortableUpdateErrorCode;
  updatedAt: number;
}
```

Also implement and export:

```ts
export function canonicalizeJson(value: unknown): string;
export function parsePortableUpdateManifest(value: unknown): PortableUpdateManifestV1;
export function parsePortableFileManifest(value: unknown): PortableUpdateFileManifestV1;
export function assertPortableTransition(from: PortableUpdatePhase, to: PortableUpdatePhase): void;
export function toPortableUpdatePublicState(input: PortableUpdatePublicState): PortableUpdatePublicState;
```

`canonicalizeJson` must accept only null, booleans, strings, finite safe integers, arrays, and plain objects; sort object keys; reject `undefined`, floats, unsafe integers, non-plain prototypes, and cycles. `parsePortableUpdateManifest` must require HTTPS, 64-character lowercase hex hashes, valid ISO time, strict SemVer, positive integer size, and `mandatory === false`.

- [ ] **Step 4: Export and run GREEN**

Add `export * from './portable-update.js';` to `packages/shared/src/index.ts`, then run:

```powershell
pnpm --filter @clawwork/shared exec vitest run test/portable-update.test.ts
pnpm --filter @clawwork/shared exec tsc --noEmit -p tsconfig.test.json
```

Expected: all named tests pass and TypeScript reports zero errors.

- [ ] **Step 5: Mutation-check the canonicalizer and redactor**

Temporarily remove key sorting and temporarily spread an input object into public state. Each mutation must make its named test fail. Restore byte-for-byte, rerun GREEN, and record both failure names in the task log.

- [ ] **Step 6: Commit**

```powershell
git add -- packages/shared/src/portable-update.ts packages/shared/test/portable-update.test.ts packages/shared/src/index.ts
git commit -m "feat(update): define portable update protocol"
```

## Task 2: Signed manifest verification and update decision

**Files:**

- Create: `packages/desktop/src/main/update/portable-manifest.ts`
- Create: `packages/desktop/test/portable-update-manifest.test.ts`
- Modify: `packages/desktop/electron.vite.config.ts`
- Create: `packages/desktop/src/main/build-constants.d.ts`

- [ ] **Step 1: Write failing signature and policy tests**

Generate an Ed25519 key pair inside the test with `generateKeyPairSync('ed25519')`. Sign the canonical manifest payload after removing `signature`. Cover:

- valid signature and a newer same-channel version;
- one-byte manifest mutation;
- malformed Base64 signature;
- downgrade/equal version;
- channel mismatch;
- `mandatory: true` rejected as `unsupported-policy`;
- launcher below `minLauncherVersion`;
- missing build-time public key fails closed.

The decision API must have this signature:

```ts
export function verifyAndDecidePortableUpdate(input: {
  rawManifest: unknown;
  publicKeyBase64: string;
  currentVersion: string;
  currentChannel: PortableUpdateChannel;
  launcherVersion: string;
}): { kind: 'available'; manifest: PortableUpdateManifestV1 } | { kind: 'current' };
```

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-manifest.test.ts
```

Expected: import failure for `portable-manifest.ts`.

- [ ] **Step 3: Implement verification**

Use Node `createPublicKey` and `verify` with Ed25519. Decode `publicKeyBase64` as DER SPKI. Verify the canonical UTF-8 payload before applying version or URL fields. Map validation failures to a local `PortableUpdateFailure` carrying only `PortableUpdateErrorCode`.

Define a build constant:

```ts
declare const __MOFANG_UPDATE_PUBLIC_KEY_B64__: string;
```

In `electron.vite.config.ts`, inject the key only into the main build:

```ts
define: {
  __MOFANG_UPDATE_PUBLIC_KEY_B64__: JSON.stringify(process.env.MOFANG_UPDATE_PUBLIC_KEY_B64 ?? ''),
},
```

Do not expose it through preload. The key is public, but the renderer does not need it.

- [ ] **Step 4: Run GREEN and mutations**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-manifest.test.ts
pnpm --filter @clawwork/desktop exec tsc --noEmit -p tsconfig.test.json
```

Mutate `verify(...)` to `true` and mutate the version comparison to accept equality. Both named tests must fail; restore and rerun.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/desktop/src/main/update/portable-manifest.ts packages/desktop/test/portable-update-manifest.test.ts packages/desktop/electron.vite.config.ts packages/desktop/src/main/build-constants.d.ts
git commit -m "feat(update): verify signed portable manifests"
```

## Task 3: Safe package download, extraction, and exact-tree verification

**Files:**

- Create: `packages/desktop/src/main/update/portable-package.ts`
- Create: `packages/desktop/test/portable-update-package.test.ts`
- Modify: `packages/desktop/package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1: Add the ZIP reader dependency**

Run:

```powershell
pnpm --filter @clawwork/desktop add yauzl
pnpm --filter @clawwork/desktop add -D @types/yauzl
```

Do not add an extraction wrapper that writes entries before the application validates their paths.

- [ ] **Step 2: Write failing tests with real ZIP fixtures**

Create ZIP fixtures in the test temp directory and cover:

- streaming download progress and `AbortSignal` cancellation;
- package byte count and SHA-256;
- insufficient-space rejection before download;
- absolute path, `..`, drive path, UNC path, duplicate normalized path, case collision, Windows device name, and forbidden sibling names;
- symlink/reparse-style entry rejection;
- exact file-list success;
- missing, extra, wrong-size, and wrong-hash files;
- extraction failure leaves no promoted stage directory;
- protected data/workspace directories remain byte-identical.

Use dependency injection for `fetch`, `availableBytes`, and file operations so named failure paths are deterministic.

- [ ] **Step 3: Run RED**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-package.test.ts
```

Expected: import failure for `portable-package.ts`.

- [ ] **Step 4: Implement focused APIs**

Export exactly these operations:

```ts
export async function calculatePortableSpaceBudget(input: {
  packageSize: number;
  expandedSize: number;
  currentProgramSize: number;
}): Promise<number>;

export async function downloadPortablePackage(input: {
  url: string;
  destinationPart: string;
  expectedSize: number;
  expectedSha256: string;
  signal: AbortSignal;
  onProgress: (transferred: number, total: number) => void;
}): Promise<void>;

export async function extractPortablePackage(input: {
  archivePath: string;
  temporaryRoot: string;
  fileManifest: PortableUpdateFileManifestV1;
}): Promise<{ programRoot: string }>;

export async function verifyPortableProgramTree(input: {
  programRoot: string;
  fileManifest: PortableUpdateFileManifestV1;
}): Promise<void>;
```

Open ZIPs with `lazyEntries: true`. Normalize every entry with `path.win32`, reject it before opening an output fd, create files with exclusive mode, stream to the fd, then `lstat` the complete tree and reject all non-file/non-directory entries. The exact-tree comparison must sort normalized relative paths and reject extras as well as omissions.

- [ ] **Step 5: Run GREEN and fault mutations**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-package.test.ts test/portable-update-swap.test.ts
```

Mutate away the `..` rejection and the extra-file comparison. The corresponding named tests must fail. Restore and rerun.

- [ ] **Step 6: Commit**

```powershell
git add -- packages/desktop/src/main/update/portable-package.ts packages/desktop/test/portable-update-package.test.ts packages/desktop/package.json pnpm-lock.yaml
git commit -m "feat(update): prepare portable packages safely"
```

## Task 4: Atomic state store and background preparation service

**Files:**

- Create: `packages/desktop/src/main/update/portable-state.ts`
- Create: `packages/desktop/src/main/update/portable-update-service.ts`
- Create: `packages/desktop/test/portable-update-state.test.ts`
- Create: `packages/desktop/test/portable-update-service.test.ts`

- [ ] **Step 1: Write failing atomic-state tests**

Cover temp-file-plus-rename persistence, monotonically increasing `updatedAt`, corrupt JSON quarantine, transaction-specific cleanup, stale prepare recovery, same-volume enforcement, protected-path rejection, and public-state redaction.

Use this persisted shape:

```ts
export interface PortableUpdateTransactionV1 {
  schemaVersion: 1;
  transactionId: string;
  phase: PortableUpdatePhase;
  currentVersion: string;
  targetVersion: string;
  channel: PortableUpdateChannel;
  updateRoot: string;
  archivePath: string;
  stagedProgramPath: string;
  currentProgramPath: string;
  backupProgramPath: string;
  manifestPath: string;
  fileManifestPath: string;
  healthPath: string;
  errorCode?: PortableUpdateErrorCode;
  updatedAt: number;
}
```

- [ ] **Step 2: Write failing service tests**

Inject manifest fetch, package operations, clock, UUID, and state store. Test one-call deduplication, progress transitions, cancellation, retry after a network failure, permanent rejection after signature failure, no auto-download before user intent, and `ready` only after archive plus exact-tree verification.

- [ ] **Step 3: Run RED**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-state.test.ts test/portable-update-service.test.ts
```

- [ ] **Step 4: Implement the store and service**

The service public surface is:

```ts
export interface PortableUpdateService {
  getState(): PortableUpdatePublicState;
  subscribe(listener: (state: PortableUpdatePublicState) => void): () => void;
  check(): Promise<PortableUpdatePublicState>;
  prepare(): Promise<{ ok: true } | { ok: false; errorCode: PortableUpdateErrorCode }>;
  cancel(): { ok: true } | { ok: false; errorCode: PortableUpdateErrorCode };
  requestRestart(): Promise<{ ok: true } | { ok: false; errorCode: PortableUpdateErrorCode }>;
}
```

`requestRestart` may only accept a `ready` transaction. It writes the final handoff state, starts the external launcher with `--apply <absolute-state-path>`, and requests a normal Electron quit only after launcher process creation succeeds.

- [ ] **Step 5: Run GREEN and mutation checks**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-state.test.ts test/portable-update-service.test.ts
```

Mutate the service to emit `ready` before file verification and mutate cleanup to target the whole update root. Both guard tests must fail. Restore and rerun.

- [ ] **Step 6: Commit**

```powershell
git add -- packages/desktop/src/main/update/portable-state.ts packages/desktop/src/main/update/portable-update-service.ts packages/desktop/test/portable-update-state.test.ts packages/desktop/test/portable-update-service.test.ts
git commit -m "feat(update): add portable preparation state machine"
```

## Task 5: Go launcher contract, signature, and tree verifier

**Files:**

- Create: `launcher/go.mod`
- Create: `launcher/internal/update/model.go`
- Create: `launcher/internal/update/canonical.go`
- Create: `launcher/internal/update/verify.go`
- Create: `launcher/internal/update/verify_test.go`
- Create: `launcher/testdata/`

- [ ] **Step 1: Pin the toolchain and write cross-language fixtures**

Use:

```go
module mofang-compass/portable-launcher

go 1.25.0
```

Generate one manifest, signature, public key, file manifest, and program tree in the TypeScript test from Task 2, then commit only non-secret public fixtures under `launcher/testdata`. The Go test must verify the TypeScript-generated signature and canonical bytes.

- [ ] **Step 2: Write failing Go tests**

Cover valid cross-language signature, mutated manifest, malformed signature, unsafe transaction paths, protected directory names, exact tree, extra file, missing file, wrong hash, and reparse/symlink rejection.

Run:

```powershell
go -C launcher test ./internal/update -run 'TestVerify|TestCanonical' -count=1
```

Expected: compile failure because implementation files do not exist.

- [ ] **Step 3: Implement the strict model and canonicalizer**

Use structs with explicit JSON tags matching Task 1. Parse with `json.Decoder.DisallowUnknownFields()`. Canonicalization supports only the manifest schema's null, boolean, string, safe integer, array, and object values; object keys sort by UTF-16 code units and strings encode as JSON UTF-8 without HTML escaping.

Expose:

```go
func ReadTransaction(path string) (TransactionV1, error)
func VerifySignedManifest(manifest SignedManifestV1, publicKey ed25519.PublicKey) error
func VerifyProgramTree(programRoot string, files FileManifestV1) error
func ValidateTransactionPaths(tx TransactionV1) error
```

- [ ] **Step 4: Run GREEN and cross-language mutation**

```powershell
go -C launcher test ./internal/update -run 'TestVerify|TestCanonical' -count=1
```

Mutate the TypeScript fixture by one byte and prove the Go test fails at signature verification. Restore the fixture.

- [ ] **Step 5: Commit**

```powershell
git add -- launcher/go.mod launcher/internal/update/model.go launcher/internal/update/canonical.go launcher/internal/update/verify.go launcher/internal/update/verify_test.go launcher/testdata
git commit -m "feat(launcher): verify portable update handoffs"
```

## Task 6: Go launcher swap, recovery, lock, and health wait

**Files:**

- Create: `launcher/internal/update/state.go`
- Create: `launcher/internal/update/lock.go`
- Create: `launcher/internal/update/swap.go`
- Create: `launcher/internal/update/state_test.go`
- Create: `launcher/internal/update/swap_test.go`

- [ ] **Step 1: Write a table of filesystem states before implementation**

Test all combinations of current, staged, and backup directory existence for `ready`, `applying`, and `awaiting-health`. The expected rule is explicit:

```text
current yes, staged yes, backup no  -> apply is allowed
current no,  staged yes, backup yes -> restore backup before retry
current yes, staged no,  backup yes -> await health or roll back
current no,  staged no,  backup yes -> restore backup
current yes, staged no,  backup no  -> normal launch/no update
current no,  staged no,  backup no  -> stop and preserve evidence
```

- [ ] **Step 2: Add deterministic fault injection tests**

Define an internal operations interface:

```go
type Ops interface {
  Rename(oldPath, newPath string) error
  RemoveAll(path string) error
  StartApp(exePath string, env []string) (Process, error)
  Now() time.Time
  Sleep(time.Duration)
}
```

Fail immediately before and after each rename, state write, process start, health observation, and rollback rename. Run recovery again and assert idempotence. Assert data/workspace sentinels never appear in any operation target.

- [ ] **Step 3: Run RED**

```powershell
go -C launcher test ./internal/update -run 'TestSwap|TestRecover|TestLock|TestHealth' -count=1
```

- [ ] **Step 4: Implement swap and recovery**

Expose:

```go
func Recover(ctx context.Context, tx TransactionV1, ops Ops) (RecoveryResult, error)
func Apply(ctx context.Context, tx TransactionV1, publicKey ed25519.PublicKey, ops Ops) error
func WaitForHealth(ctx context.Context, tx TransactionV1, process Process, ops Ops) error
func Rollback(ctx context.Context, tx TransactionV1, ops Ops) error
```

Use an exclusive `update.lock` created with `O_CREATE|O_EXCL`. Record PID, transaction ID, and creation time. A stale lock is removable only when its PID is not alive and the transaction has been reconciled against disk facts. Keep the backup through the first confirmed launch; delete it during the next normal launcher start, not before health confirmation.

- [ ] **Step 5: Run GREEN and destructive-target mutation**

```powershell
go -C launcher test ./internal/update -count=1
```

Mutate rollback to remove `UpdateRoot` instead of the transaction stage directory. The protected-path operation-recorder test must fail before a filesystem mutation. Restore and rerun.

- [ ] **Step 6: Commit**

```powershell
git add -- launcher/internal/update/state.go launcher/internal/update/lock.go launcher/internal/update/swap.go launcher/internal/update/state_test.go launcher/internal/update/swap_test.go
git commit -m "feat(launcher): swap and recover portable releases"
```

## Task 7: Windows launcher entrypoint and build

**Files:**

- Create: `launcher/internal/ui/windows.go`
- Create: `launcher/internal/ui/windows_stub.go`
- Create: `launcher/cmd/mofang-launcher/main.go`
- Create: `launcher/cmd/mofang-launcher/main_test.go`
- Create: `launcher/locales/zh-CN.json`
- Create: `scripts/build-portable-launcher.mjs`
- Create: `scripts/lib/portable-launcher-build.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing CLI decision tests**

Separate argument/environment decisions from `main()`. Cover normal launch, `--apply <state>`, startup recovery, invalid state, another launcher holding the lock, missing program EXE, and launcher/app version reporting.

The normal launch path is:

```text
resolve launcher directory
locate .荣盈魔方更新/update-state.json
recover or finalize pending transaction
launch 荣盈魔方/荣盈魔方.exe
forward no secrets
```

- [ ] **Step 2: Run RED**

```powershell
go -C launcher test ./cmd/mofang-launcher -count=1
node --test scripts/lib/portable-launcher-build.test.mjs
```

- [ ] **Step 3: Implement the launcher entrypoint**

Embed `zh-CN.json` and the build-time Ed25519 public key. The UI package provides a small Windows status window for `applying` and native error dialogs for failure; the non-Windows stub lets unit tests run on Linux. Do not use shell command concatenation.

Build with:

```powershell
$env:GOOS='windows'
$env:GOARCH='amd64'
go -C launcher build -trimpath -ldflags "-s -w -H=windowsgui -X main.version=$env:MOFANG_LAUNCHER_VERSION -X main.publicKeyBase64=$env:MOFANG_UPDATE_PUBLIC_KEY_B64" -o ../artifacts/荣盈魔方启动器.exe ./cmd/mofang-launcher
```

The Node wrapper validates both required environment variables, uses `spawnSync` with an argv array, verifies the PE output exists, and never prints the key or environment.

- [ ] **Step 4: Run GREEN**

```powershell
go -C launcher test ./... -count=1
node --test scripts/lib/portable-launcher-build.test.mjs
pnpm build:portable-launcher
```

Expected: tests pass and `artifacts/荣盈魔方启动器.exe` is a non-empty PE file. The build is a local tool artifact and remains untracked.

- [ ] **Step 5: Commit**

```powershell
git add -- launcher/internal/ui/windows.go launcher/internal/ui/windows_stub.go launcher/cmd/mofang-launcher/main.go launcher/cmd/mofang-launcher/main_test.go launcher/locales/zh-CN.json scripts/build-portable-launcher.mjs scripts/lib/portable-launcher-build.test.mjs package.json
git commit -m "feat(launcher): add the portable Windows entrypoint"
```

## Task 8: Application health receipt and launcher handoff

**Files:**

- Create: `packages/desktop/src/main/update/portable-health.ts`
- Create: `packages/desktop/test/portable-update-health.test.ts`
- Modify: `packages/desktop/src/main/index.ts`
- Modify: `packages/desktop/src/main/ipc/update-handlers.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/clawwork.d.ts`
- Modify: `packages/desktop/src/renderer/App.tsx`

- [ ] **Step 1: Write failing readiness tests**

Test that a receipt is written exactly once only after `main-ready`, `database-ready`, `window-ready`, and `renderer-ready` are all true. Test wrong/missing transaction environment, path mismatch, duplicate renderer acknowledgement, network/gateway/license failure independence, and atomic receipt writing.

Receipt shape:

```ts
interface PortableHealthReceiptV1 {
  schemaVersion: 1;
  transactionId: string;
  version: string;
  programPath: string;
  healthyAt: string;
}
```

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-health.test.ts
```

- [ ] **Step 3: Implement the coordinator**

Expose:

```ts
export function createPortableHealthCoordinator(input: {
  transactionId?: string;
  healthPath?: string;
  expectedProgramPath?: string;
  runningProgramPath: string;
  runningVersion: string;
  writeReceipt: (receipt: PortableHealthReceiptV1) => Promise<void>;
}): {
  markMainReady(): void;
  markDatabaseReady(): void;
  markWindowReady(): void;
  markRendererReady(): void;
};
```

Register `app:portable-update-renderer-ready` once in `update-handlers.ts`. Expose `reportPortableUpdateRendererReady(): void` through preload. Call it once from `App.tsx` after the root renderer mounts. Mark the other three milestones at their actual existing completion points in `main/index.ts`; do not simulate them with a timer.

- [ ] **Step 4: Run GREEN and mutation**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-health.test.ts
pnpm --filter @clawwork/desktop exec tsc --noEmit -p tsconfig.test.json
```

Mutate the coordinator to ignore `database-ready`. The named test must fail. Restore and rerun.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/desktop/src/main/update/portable-health.ts packages/desktop/test/portable-update-health.test.ts packages/desktop/src/main/index.ts packages/desktop/src/main/ipc/update-handlers.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/clawwork.d.ts packages/desktop/src/renderer/App.tsx
git commit -m "feat(update): acknowledge healthy portable launches"
```

## Task 9: Route portable update APIs through the new service

**Files:**

- Modify: `packages/desktop/src/main/auto-updater.ts`
- Modify: `packages/desktop/src/main/ipc/update-handlers.ts`
- Modify: `packages/desktop/src/preload/index.ts`
- Modify: `packages/desktop/src/preload/clawwork.d.ts`
- Modify: `packages/desktop/test/auto-updater.test.ts`
- Create: `packages/desktop/test/portable-update-ipc.test.ts`

- [ ] **Step 1: Replace the old expected behavior in RED tests**

Change the existing portable tests from “download/install rejected with `portable-manual-update`” to:

- portable check delegates to `PortableUpdateService.check`;
- portable download starts `prepare` and emits typed state;
- portable cancel delegates to `cancel`;
- portable install accepts only `ready` and calls `requestRestart`;
- installed builds continue using `electron-updater` unchanged;
- dev mode remains `dev-not-supported`;
- IPC handlers are registered once and emit only `PortableUpdatePublicState`.

- [ ] **Step 2: Run RED**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/auto-updater.test.ts test/portable-update-ipc.test.ts
```

Expected: old `portable-manual-update` assertions or missing service integration fail.

- [ ] **Step 3: Implement dependency-injected routing**

Keep installed and portable engines separate behind a small router. Do not add portable file logic to `electron-updater` event handlers. Map the existing UI setting `beta` to the signed portable channel `internal`; `stable` remains `stable`. Extend `UpdateCheckResult.state` to the shared phase union and add:

```ts
getUpdateState: () => Promise<PortableUpdatePublicState>;
onUpdateStateChanged: (callback: (state: PortableUpdatePublicState) => void) => () => void;
```

The portable path must never call `quitAndInstall`.

- [ ] **Step 4: Run GREEN**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/auto-updater.test.ts test/portable-update-ipc.test.ts test/portable-update-service.test.ts
pnpm --filter @clawwork/desktop exec tsc --noEmit -p tsconfig.test.json
```

Mutate the router to send portable install through `quitAndInstall`. The named negative test must fail.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/desktop/src/main/auto-updater.ts packages/desktop/src/main/ipc/update-handlers.ts packages/desktop/src/preload/index.ts packages/desktop/src/preload/clawwork.d.ts packages/desktop/test/auto-updater.test.ts packages/desktop/test/portable-update-ipc.test.ts
git commit -m "feat(update): route portable updates through the launcher"
```

## Task 10: Truthful update UI and localized recovery copy

**Files:**

- Modify: `packages/desktop/src/renderer/features/internal-beta/update-service.ts`
- Modify: `packages/desktop/src/renderer/features/internal-beta/update-errors.ts`
- Modify: `packages/desktop/src/renderer/lib/update-status.ts`
- Modify: `packages/desktop/src/renderer/layouts/Settings/sections/AboutSection.tsx`
- Modify: `packages/desktop/test/internal-beta-update-service.test.ts`
- Modify: `packages/desktop/test/internal-beta-update-errors.test.ts`
- Modify: `packages/desktop/test/update-status.test.ts`
- Create: `packages/desktop/test/portable-update-about.test.tsx`
- Modify: `packages/desktop/src/renderer/i18n/locales/{de,en,es,fr,ja,ko,pt,zh-TW,zh}.json`

- [ ] **Step 1: Write failing state and interaction tests**

Cover every portable public phase. Pin these user actions:

- downloading shows percent and cancel;
- verifying/extracting says preparation continues in the background;
- ready shows “restart now” and “later”;
- restart failure remains visible and actionable;
- rolled-back names both failed and restored versions;
- disk-space error shows required versus available bytes from safe numeric params;
- signature/integrity errors offer retry but never “ignore and install”;
- no portable state displays the old manual-replacement copy.

- [ ] **Step 2: Run RED by test name**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/update-status.test.ts test/internal-beta-update-service.test.ts test/internal-beta-update-errors.test.ts test/portable-update-about.test.tsx
```

- [ ] **Step 3: Implement renderer mapping**

Make the shared main-process phase the only status source. `AboutSection` may keep view-local dialog state, but it must not infer completion from `hasUpdate` or elapsed time. Use `t()` for every new string and existing design tokens for styling.

Add equivalent keys under `settings.portableUpdate` in all nine locale files. The Simplified Chinese source copy must include:

```json
{
  "preparing": "正在后台准备更新，你可以继续使用荣盈魔方。",
  "ready": "版本 {{version}} 已准备好，重启后完成更新。",
  "restartNow": "立即重启更新",
  "later": "稍后",
  "applying": "正在更新，请勿拔出 U 盘。",
  "rolledBack": "更新未完成，已恢复到版本 {{version}}，现有数据未受影响。"
}
```

- [ ] **Step 4: Run GREEN and copy gates**

```powershell
pnpm --filter @clawwork/desktop exec vitest run test/update-status.test.ts test/internal-beta-update-service.test.ts test/internal-beta-update-errors.test.ts test/portable-update-about.test.tsx
pnpm check:i18n
pnpm check:renderer-copy
pnpm check:ui-contract
```

Mutate `ready` to map to `available`; the restart-button test must fail. Restore and rerun.

- [ ] **Step 5: Commit**

```powershell
git add -- packages/desktop/src/renderer/features/internal-beta/update-service.ts packages/desktop/src/renderer/features/internal-beta/update-errors.ts packages/desktop/src/renderer/lib/update-status.ts packages/desktop/src/renderer/layouts/Settings/sections/AboutSection.tsx packages/desktop/test/internal-beta-update-service.test.ts packages/desktop/test/internal-beta-update-errors.test.ts packages/desktop/test/update-status.test.ts packages/desktop/test/portable-update-about.test.tsx packages/desktop/src/renderer/i18n/locales/de.json packages/desktop/src/renderer/i18n/locales/en.json packages/desktop/src/renderer/i18n/locales/es.json packages/desktop/src/renderer/i18n/locales/fr.json packages/desktop/src/renderer/i18n/locales/ja.json packages/desktop/src/renderer/i18n/locales/ko.json packages/desktop/src/renderer/i18n/locales/pt.json packages/desktop/src/renderer/i18n/locales/zh-TW.json packages/desktop/src/renderer/i18n/locales/zh.json
git commit -m "feat(update): show portable update recovery states"
```

## Task 11: Signed release tooling and launcher-enabled delivery gate

**Files:**

- Create: `scripts/lib/portable-update-release.mjs`
- Create: `scripts/lib/portable-update-release.test.mjs`
- Create: `scripts/make-portable-update.mjs`
- Create: `scripts/assemble-udisk-delivery.mjs`
- Create: `scripts/templates/udisk-readme.txt`
- Modify: `scripts/lib/udisk-delivery.mjs`
- Modify: `scripts/lib/udisk-delivery.test.mjs`
- Modify: `scripts/make-udisk-archive.mjs`
- Modify: `scripts/lib/udisk-archive.test.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing release-tool tests**

Test deterministic sorted file manifests, symlink/reparse rejection, forbidden directory rejection, archive hash and size, signature verification, private-key absence, public/private mismatch, non-HTTPS URL rejection, and refusal to overwrite an existing release artifact.

The signing interface is explicit:

```js
export function buildPortableRelease(input) {
  return {
    manifestBytes,
    signature,
    fileManifestBytes,
    packageSha256,
  };
}
```

`MOFANG_UPDATE_SIGNING_KEY_FILE` points to an Ed25519 PKCS#8 PEM outside the repository. Tests create an ephemeral key and never inspect the operator environment.

- [ ] **Step 2: Change delivery tests to the new contract and capture RED**

The clean delivery fixture must require:

```text
荣盈魔方启动器.exe
荣盈魔方/荣盈魔方.exe
荣盈魔方/resources/app.asar
荣盈魔方/resources/runtime/openclaw-runtime-manifest.json
使用说明.txt
```

It must fail on a missing launcher, any `.bat`, bundled runtime absence, installer presence, a launcher inside `荣盈魔方/`, or pre-populated data/update directories.

Run:

```powershell
node --test scripts/lib/portable-update-release.test.mjs scripts/lib/udisk-delivery.test.mjs scripts/lib/udisk-archive.test.mjs
```

- [ ] **Step 3: Implement deterministic tooling**

Add scripts:

```json
{
  "build:portable-launcher": "node scripts/build-portable-launcher.mjs",
  "udisk:assemble": "node scripts/assemble-udisk-delivery.mjs",
  "update:portable-package": "node scripts/make-portable-update.mjs",
  "check:portable-launcher": "go -C launcher test ./... -count=1",
  "check:portable-update-release": "node --test scripts/lib/portable-launcher-build.test.mjs scripts/lib/portable-update-release.test.mjs"
}
```

`assemble-udisk-delivery.mjs` accepts explicit `--app-dir`, `--launcher`, and `--out` paths; it refuses an existing non-empty output; it copies only the current program directory, launcher, and template instructions. It does not create data/workspace/update directories.

`make-portable-update.mjs` accepts explicit `--program-dir`, `--version`, `--channel`, `--base-url`, and `--out`; it validates the signing key, builds the ZIP, writes `portable-files.json`, signs the canonical manifest, verifies its own output, and exits non-zero on any mismatch.

- [ ] **Step 4: Run GREEN and end-to-end local fixture**

```powershell
node --test scripts/lib/portable-launcher-build.test.mjs scripts/lib/portable-update-release.test.mjs scripts/lib/udisk-delivery.test.mjs scripts/lib/udisk-archive.test.mjs
pnpm check:udisk-delivery
```

Create a temporary fake program tree, sign it with an ephemeral test key, build an update ZIP, extract and verify it with the Electron package verifier, then verify the same receipt with `go test`. The test must report at least one passed case for each verifier.

- [ ] **Step 5: Commit**

```powershell
git add -- scripts/lib/portable-update-release.mjs scripts/lib/portable-update-release.test.mjs scripts/make-portable-update.mjs scripts/assemble-udisk-delivery.mjs scripts/templates/udisk-readme.txt scripts/lib/udisk-delivery.mjs scripts/lib/udisk-delivery.test.mjs scripts/make-udisk-archive.mjs scripts/lib/udisk-archive.test.mjs package.json
git commit -m "feat(release): build signed portable updates"
```

## Task 12: CI, runbooks, full gates, and authorization boundary

**Files:**

- Modify: `.github/workflows/pr-check.yml`
- Modify: `.github/workflows/release.yml`
- Create: `docs/runbooks/portable-update-release.md`
- Create: `docs/runbooks/portable-update-real-disk-acceptance.md`
- Modify: `docs/plan/2026-09-19-自主任务队列.md`
- Modify: `package.json`

- [ ] **Step 1: Add CI tests before release automation**

In `pr-check.yml`, add `actions/setup-go@v7` with `go-version-file: launcher/go.mod`, then run:

```yaml
- name: Test portable launcher
  run: go -C launcher test ./... -count=1
- name: Test portable release tooling
  run: pnpm check:portable-update-release
```

Add a Windows job that builds the launcher, checks its PE header, runs Go tests, and executes the Node delivery tests. It must use a test public key generated in the job and must not receive production signing secrets.

Extend the root `check` script so `pnpm check:portable-launcher` and `pnpm check:portable-update-release` run before the existing full TypeScript/Vitest suite. A missing Go toolchain must be a clear prerequisite failure, not a skipped launcher gate.

- [ ] **Step 2: Keep production release explicit**

In `release.yml`, add only guarded launcher/build steps. Production signing runs only when all three secrets exist:

```text
MOFANG_UPDATE_PUBLIC_KEY_B64
MOFANG_UPDATE_SIGNING_KEY_PEM
MOFANG_UPDATE_FEED_UPLOAD_TOKEN
```

The workflow writes the private key to a temporary file with restricted permissions, deletes it in an `always()` cleanup step, verifies generated artifacts, and requires the existing protected release environment before upload. A pull request and an ordinary branch push must never publish the portable feed.

- [ ] **Step 3: Write exact runbooks**

The release runbook must specify:

1. build app directory;
2. run all gates;
3. build launcher with the matching public key;
4. assemble and audit the one-time base package;
5. build signed update into a new empty output directory;
6. verify signature and hashes independently;
7. publish to the test channel;
8. complete the real-disk matrix;
9. copy immutable artifacts to the production location;
10. update the signed production manifest last;
11. retain previous manifest/package for emergency server rollback without client downgrade.

The real-disk runbook must have checkboxes for exFAT, NTFS, two clean Windows computers, Chinese/space paths, ordinary user, network loss, insufficient space, bad signature, bad hash, file lock, process kill at every swap boundary, unplug simulation, health timeout, automatic rollback, successful retry, data/workspace hashes, login, paid model list, one real chat round-trip, and restart idempotence.

- [ ] **Step 4: Run focused gates**

```powershell
go -C launcher test ./... -count=1
pnpm check:portable-update-release
pnpm check:udisk-delivery
pnpm --filter @clawwork/shared test
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-manifest.test.ts test/portable-update-package.test.ts test/portable-update-state.test.ts test/portable-update-service.test.ts test/portable-update-health.test.ts test/portable-update-ipc.test.ts test/portable-update-about.test.tsx test/portable-update-swap.test.ts test/auto-updater.test.ts
```

Expected: every named suite has `passed > 0`, zero failures, and zero skipped critical mutation/self-check cases.

- [ ] **Step 5: Run the full repository gate**

```powershell
pnpm typecheck
pnpm typecheck:tests
pnpm lint
pnpm check:architecture
pnpm check:ui-contract
pnpm check:renderer-copy
pnpm check:i18n
pnpm check:udisk-delivery
pnpm check:gateway-probe
pnpm check:dead-code
pnpm format:check
pnpm test
git diff --check
```

Expected: all commands exit zero. If an unrelated pre-existing failure appears, capture the exact command and output; do not mark the update feature complete.

- [ ] **Step 6: Update the queue truthfully**

Record code/test status separately from packaging, publication, and true U-disk status. Until the user supplies a U disk and separately authorizes packaging and test-channel publication, write:

```text
代码与临时目录故障测试：完成
真实打包态：未验证
exFAT/NTFS 真盘：未验证
测试更新源：未发布
正式更新源：未发布
现存 0.0.25 自动升级：不支持，需一次人工基础包迁移
```

- [ ] **Step 7: Commit CI and documentation**

```powershell
git add -- .github/workflows/pr-check.yml .github/workflows/release.yml docs/runbooks/portable-update-release.md docs/runbooks/portable-update-real-disk-acceptance.md docs/plan/2026-09-19-自主任务队列.md package.json
git commit -m "ci(update): gate portable update releases"
```

- [ ] **Step 8: Stop at the authorization gate**

Report commits, focused/full gate readings, mutation evidence, and remaining real-disk items. Do not run `electron-builder`, assemble a customer package, upload a test manifest, or alter the production feed until the user separately authorizes those operations.

## Plan self-review record

- **Spec coverage:** directory layout, signed manifest, path safety, background preparation, same-volume swap, external launcher, health receipt, rollback, UI/error taxonomy, version rules, one-time 0.0.25 migration, delivery audit, release pipeline, CI, and real-disk matrix all map to Tasks 1–12.
- **Scope:** this is one cohesive update subsystem. Login/model, team Agent, MCP search, image, and video fixes remain separate plans and are included only as release-order constraints.
- **Type consistency:** `PortableUpdateManifestV1`, `PortableUpdateFileManifestV1`, `PortableUpdateTransactionV1`, `PortableUpdatePublicState`, phases, and error codes originate in Task 1 and retain the same names through Electron, Go JSON tags, UI, release tooling, and runbooks.
- **Security consistency:** both Electron and launcher verify the same Ed25519 signature; both verify the file-manifest hash and exact staged tree; neither accepts `mandatory: true`; private signing material is never committed or sent to clients.
- **Data safety:** every filesystem task names transaction-scoped roots and protected siblings. No step uses a wildcard or volume root as a recursive cleanup target.
- **Publication boundary:** implementation and local fixtures are authorized by execution approval; customer packaging, test-feed upload, and production publication remain separately authorized actions.
