import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { ArtifactDeliveryActivitySnapshot } from '@clawwork/shared';

const require = createRequire(import.meta.url);
const packageDir = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const retained = process.env.CLAWWORK_DELIVERY_PERSISTENCE_TEST_ROOT;
let root: string;
let runner: string;
function workspace(): string {
  return mkdtempSync(join(root, 'workspace-'));
}
function run(path: string, scenario: string, account = 'account-a') {
  const child = spawnSync(require('electron') as string, [join(runner, 'probe.mjs'), path, scenario, account], {
    cwd: packageDir,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 30_000,
    windowsHide: true,
  });
  if (retained) {
    writeFileSync(join(path, `${scenario}-${account}.stdout.log`), child.stdout ?? '');
    writeFileSync(join(path, `${scenario}-${account}.stderr.log`), child.stderr ?? '');
    writeFileSync(
      join(path, `${scenario}-${account}.command.json`),
      JSON.stringify({
        executable: require('electron'),
        args: [join(runner, 'probe.mjs'), path, scenario, account],
        exitCode: child.status,
      }),
    );
  }
  if (child.status !== 0 || child.error)
    throw new Error(`Probe failed: ${child.error?.message ?? child.stderr}\n${child.stdout}`);
  const line = child.stdout.split(/\r?\n/).find((entry) => entry.startsWith('DELIVERY_ACTIVITY_RESULT='));
  if (!line) throw new Error(child.stdout);
  const value = JSON.parse(line.slice('DELIVERY_ACTIVITY_RESULT='.length)) as {
    snapshot: ArtifactDeliveryActivitySnapshot;
    [key: string]: unknown;
  };
  if (retained) writeFileSync(join(path, `${scenario}-${account}.json`), JSON.stringify(value, null, 2));
  expect(value.integrity).toEqual([]);
  expect(value.messageDuplicates).toEqual([]);
  return value;
}
beforeAll(async () => {
  const parent = retained ? resolve(retained) : tmpdir();
  mkdirSync(parent, { recursive: true });
  root = mkdtempSync(join(parent, 'delivery-persistence-'));
  runner = join(root, 'bundle');
  const environment = fileURLToPath(
    new URL('./helpers/delivery-activity-persistence-environment.ts', import.meta.url),
  ).replaceAll('\\', '/');
  await build({
    configFile: false,
    logLevel: 'silent',
    root: packageDir,
    resolve: { alias: { electron: environment } },
    plugins: [
      {
        name: 'isolate-delivery-persistence',
        enforce: 'pre',
        resolveId(source, importer) {
          if (['better-sqlite3', 'pptxgenjs'].includes(source))
            return { id: pathToFileURL(require.resolve(source)).href, external: true };
          if (
            importer?.replaceAll('\\', '/').endsWith('/src/main/ipc/data-handlers.ts') &&
            ![
              '../artifact/delivery-activity.js',
              '../artifact/delivery-operation.js',
              // r7-1：data-handlers 的交付结算改走唯一出口 `delivery-settlement.js`
              // （`sendArtifactDeliverySettled` 内联标记+广播）；探针白名单必须跟着长，
              // 否则它被当"无关生成器"桩掉、缺导出 ⇒ RollupError（与
              // message-persistence-sqlite 探针同一条纪律）。
              '../artifact/delivery-settlement.js',
              '../artifact/workspace-owner.js',
              '../slidegen/tool-receipts.js',
            ].includes(source) &&
            (source.startsWith('../artifact/') ||
              source.startsWith('../docgen/') ||
              source.startsWith('../htmlgen/') ||
              source.startsWith('../imagegen/') ||
              source.startsWith('../slidegen/') ||
              ['../workspace/config.js', '../ws/index.js', '../debug/index.js'].includes(source))
          )
            return '\0delivery-unrelated-generators';
          if (
            source.endsWith('/workspace/config.js') ||
            (importer?.replaceAll('\\', '/').endsWith('/commercial/license.ts') &&
              [
                './client.js',
                '../ws/index.js',
                '../debug/index.js',
                './relay-config.js',
                '../runtime/index.js',
                '../runtime/bundled-search.js',
                '../runtime/state-config.js',
                // 2026-10-17 BUG-133：`license.ts` 新增了 `../memory/account-switch.js`
                // 静态 import（`clearPersistedLicenseBinding` 真清绑定时 fire-and-forget
                // 重投影 `MEMORY.md`）。**这条边必须留在替身里** —— account-switch 自己
                // import `../ws/index.js`（取网关客户端），而下面那条 `importer.endsWith
                // ('/commercial/license.ts')` 的条件只看**直接** importer：account-switch
                // 去 import ws 时 importer 已不是 license.ts ⇒ 真 `ws/index.js` →
                // `ws/gateway-client` → `import WebSocket from 'ws'` 被拉进图 →
                // `ws/lib/stream.js` 的 `require('https')` 在 Vite 解析期就无法解析
                // （`Failed to resolve entry for package "https"`）⇒ **整档收集失败、
                // 11 条用例一条都跑不到**（与 BUG-127 同片雷区，成因是"新 import 边把
                // 不该进图的包拉进来了"）。桩掉这条边 = 沿用本档对 license.ts 每个依赖
                // 的既有隔离口径，不是掩盖：产品码未改，只是该档本就不需要真 WS 客户端。
                '../memory/account-switch.js',
              ].includes(source))
          )
            return environment;
        },
        load(id) {
          if (id !== '\0delivery-unrelated-generators') return;
          return `
            export const getWorkspacePath = () => null;
            export const getGatewayClient = () => undefined;
            export const getDebugLogger = () => undefined;
            export const DISPLAY_TRUNCATION_MARKER = '[truncated]';
            export const EXPECTED_ARTIFACT_LABELS = {};
            export const autoExtractArtifacts = async () => undefined;
            export const captureTaskArtifactBaseline = async () => new Map();
            export const reconcileTaskArtifacts = async () => [];
            export const resolveAgentWorkspace = () => undefined;
            export const generateDocumentsFromMessage = async () => [];
            export const resolvePptxTemplatesRoot = () => undefined;
            export const generateHtmlPagesFromMessage = async () => [];
            export const startImagegenJobs = () => undefined;
            export const generateSlidesFromMessage = async () => [];
            export const captureDeckFileBaseline = async () => new Map();
            export const changedDeckFiles = () => [];
            export const decksFromFiles = () => [];
            export const historyFetcherFrom = () => undefined;
            export const recoverFullReply = async () => undefined;
            export const checkClaimedFiles = () => [];
            export const expectedArtifactKindsFromRequest = () => [];
            export const missingExpectedArtifactKinds = () => [];
            export const nativeTaskControl = () => ({ get: () => undefined, cancel: () => undefined });
            export const nativeInputFromCompletedWrites = () => [];
            // 2026-10-16（T23 源端身份）：data-handlers 从 native-tool-input.js 多 import 了
            // nativeExecOrderFromTools —— 桩必须跟着长，否则收集期就是 RollupError、
            // 整档 11 条用例全部跳过（默认空数组 = 没有运行时执行记录 = 与从前同口径）。
            export const nativeExecOrderFromTools = () => [];
            export const renderNativePptFile = async () => undefined;
            export const readSlideGenerationReceipt = () => undefined;
            // B 包（2026-10-07）：data-handlers 收尾多了"把跨根成品复制进任务目录"这一步，
            // 于是它也 import 了 artifact/save.js —— 这份桩要跟着补一个名字（同上面二十来个）。
            export const saveArtifact = async () => undefined;
            export const readWorkspaceBytes = () => Buffer.from('');
            export const reviewNativePpt = async () => undefined;
            export const nativeReviewPorts = () => undefined;
            // 2026-10-08：data-handlers 的 claim 链新增了这个导出（artifact/claim-guard），
            // 桩要跟着补一个名字，否则整份 bundle 起不来（默认空 = 没有拒收）。
            export const claimedFilesRejectedByIntegrity = () => [];
            // 2026-10-17：claim 链新增"同格式误报降级"判据（artifact/claim-guard），
            // 桩按真实语义实现（不同格式仍拦），否则整份 bundle 收集期就 RollupError。
            export const classifyMissingClaims = (missing, produced) => {
              if (!missing.length) return { blocked: [], informational: [] };
              if (!produced.length) return { blocked: [...missing], informational: [] };
              const ext = (name) => { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i).toLowerCase() : ''; };
              const producedExts = new Set(produced.map(ext).filter(Boolean));
              const blocked = []; const informational = [];
              for (const name of missing) {
                const e = ext(name);
                if (e && producedExts.has(e)) informational.push(name); else blocked.push(name);
              }
              return { blocked, informational };
            };
            // BUG-064（2026-10-10）：交付入口接入了"这一轮在跑"软状态（artifact/turn-lifecycle），
            // 桩跟着补三个名字（默认 no-op：不拦截、不结算）。
            // 2026-10-11（复审 B1 整改）：data-handlers 再增 run 队列探针注册。
            export const isLiveTurnSession = () => false;
            export const registerTurnReleaseHandler = () => undefined;
            export const registerTurnRunStateProbe = () => undefined;
            export const settleLiveTurn = () => undefined;
            // 第二轮（R5 P1）· 2026-10-14：data-handlers 接入轮次登记回执发射器
            // （artifact/turn-registration）——桩必须跟着长（同上面二十来个的纪律）。
            export const emitTurnRegistration = () => false;
          `;
        },
      },
    ],
    ssr: { noExternal: true, external: ['better-sqlite3'] },
    build: {
      target: 'es2022',
      emptyOutDir: true,
      minify: false,
      outDir: runner,
      ssr: fileURLToPath(new URL('./helpers/delivery-activity-persistence-probe.ts', import.meta.url)),
      rollupOptions: { output: { entryFileNames: 'probe.mjs' } },
    },
  });
}, 35_000);
afterAll(() => {
  if (retained || !root) return;
  const target = resolve(root);
  const within = relative(resolve(tmpdir()), target);
  if (!within || within === '..' || within.startsWith(`..${sep}`) || resolve(tmpdir(), within) !== target)
    throw new Error('outside-private-test-root');
  rmSync(target, { recursive: true, force: true });
});

it.each(['fresh', 'legacy'])('initializes %s twice and keeps startup registration database independent', (scenario) => {
  expect(run(workspace(), scenario)).toMatchObject({
    table: true,
    beforeInit: { owner: { scope: null }, activities: [], completedActivities: [] },
    snapshot: { activities: [], completedActivities: [] },
  });
});
it('restores four actual terminal states after a separate Electron process with original operation, run and times', () => {
  const path = workspace();
  const first = run(path, 'write').snapshot;
  const second = run(path, 'read').snapshot;
  expect(second.owner.scope).not.toBe(first.owner.scope);
  expect(second.completedActivities).toHaveLength(4);
  expect(second.completedActivities).toEqual(
    first.completedActivities!.map((event) => ({
      ...event,
      workspaceScope: second.owner.scope,
      workspaceRevision: second.owner.revision,
    })),
  );
  expect(new Set(second.completedActivities!.map((event) => event.operationId)).size).toBe(4);
});
it('bounds durable terminals without persisting or replaying unproven active work', () => {
  const path = workspace();
  const first = run(path, 'bounds');
  expect(first.snapshot.activities).toHaveLength(1);
  const second = run(path, 'read').snapshot;
  expect(second.activities).toEqual([]);
  expect(second.completedActivities).toHaveLength(256);
  expect(second.completedActivities!.map((event) => event.operationId)).not.toContain(first.first);
});
it('keeps a write-failed terminal visible without reviving a deleted task or crossing an owner boundary', () => {
  const value = run(workspace(), 'write-lock');
  const locked = value.locked as ArtifactDeliveryActivitySnapshot;
  const released = value.released as ArtifactDeliveryActivitySnapshot;
  expect(locked.completedActivities).toHaveLength(2);
  expect(released.completedActivities).toHaveLength(2);
  expect(locked.completedActivities!.find((event) => event.operationId === value.operationId)).toEqual(value.observed);
  expect(released.completedActivities!.find((event) => event.operationId === value.operationId)).toEqual(
    value.observed,
  );
  expect((value.unreadableTask as ArtifactDeliveryActivitySnapshot).completedActivities).toHaveLength(1);
  expect((value.readableTask as ArtifactDeliveryActivitySnapshot).completedActivities).toHaveLength(2);
  expect(value.storedCount).toBe(1);
  for (const boundary of [
    'deleted',
    'recreated',
    'replaced',
    'accountB',
    'accountA',
    'accountCycle',
    'otherDb',
    'reopened',
  ])
    expect(value[boundary]).toMatchObject({ activities: [], completedActivities: [] });
});
it('cascades task deletion and ignores malformed persisted records', () => {
  expect(run(workspace(), 'delete')).toMatchObject({
    rows: [],
    snapshot: { completedActivities: [] },
    foreignKeys: [],
  });
  expect(run(workspace(), 'corrupt')).toMatchObject({ table: true, snapshot: { completedActivities: [] } });
});
it('invalidates deleted task fallback and late producers before real gateway re-adoption without a snapshot', () => {
  const value = run(workspace(), 'delete-lifecycle');
  expect(value.sameBirth).toBe(true);
  expect(value.failedDelete).toMatchObject({ ok: false });
  expect((value.failedDeleteSnapshot as ArtifactDeliveryActivitySnapshot).completedActivities).toHaveLength(2);
  expect((value.failedDeleteSnapshot as ArtifactDeliveryActivitySnapshot).activities).toHaveLength(1);
  expect(value.remoteDeleteError).toBe('controlled gateway deletion failure');
  expect(value.deletionOrder).toEqual(['local-task-delete', 'clear-local-messages', 'gateway-delete-attempt']);
  const snapshot = value.afterReadoption as ArtifactDeliveryActivitySnapshot;
  expect(snapshot.activities).toEqual([]);
  expect(snapshot.completedActivities!.map((event) => event.operationId)).toEqual([value.otherOperationId]);
  expect(value.lateEvents).toEqual([]);
  expect(value.storedBeforeNewRun).toBe(0);
  expect(value.afterNewRun).toMatchObject({ activities: [] });
  expect((value.afterNewRun as ArtifactDeliveryActivitySnapshot).completedActivities).toHaveLength(2);
  expect(value.newRows).toHaveLength(1);
});
it('filters persisted history by verified account triple and fences real license A to B to A callbacks', () => {
  const path = workspace();
  const first = run(path, 'account');
  expect(first).toMatchObject({
    other: { activities: [], completedActivities: [] },
    lateEvents: [],
    activation: { ok: false, errorCode: 'not_configured' },
  });
  expect(run(path, 'read', 'account-b').snapshot.completedActivities).toEqual([]);
  expect(run(path, 'read').snapshot.completedActivities).toHaveLength(1);
  const unknown = workspace();
  run(unknown, 'write', 'unknown');
  expect(run(unknown, 'read').snapshot.completedActivities).toEqual([]);
});
it('rejects old database callbacks after cross-library and same-path reopen', () => {
  expect(run(workspace(), 'switch')).toMatchObject({
    other: { activities: [], completedActivities: [] },
    snapshot: { activities: [], completedActivities: [] },
    lateEvents: [],
  });
});
it('retains indexed root and source identity with verified receipt source and final SHA', () => {
  const value = run(workspace(), 'references');
  const rows = value.rows as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    owner_user_id: 'account-a',
    owner_org_id: 'fixture-org',
    owner_license_id: 'fixture-license',
  });
  expect(JSON.parse(String(rows[0].artifact_refs_json))).toEqual([
    {
      artifactId: 'artifact-1',
      root: 'agent',
      localPath: 'report.pptx',
      sourceKey: 'agent-proven-version',
      receiptFile: value.receipt,
      sourceSha256: value.sourceSha256,
      outputSha256: value.outputSha256,
    },
  ]);
});
it('keeps an observed terminal when file proof is malformed without inventing hashes', () => {
  const value = run(workspace(), 'bad-proof');
  const rows = value.rows as Array<Record<string, unknown>>;
  expect(rows).toHaveLength(1);
  expect(value.snapshot.completedActivities).toHaveLength(1);
  expect(JSON.parse(String(rows[0].artifact_refs_json))).toEqual([
    {
      artifactId: 'unknown-proof',
      root: 'agent',
      localPath: 'missing.pptx',
      sourceKey: 'original-source',
      receiptFile: null,
      sourceSha256: null,
      outputSha256: null,
    },
  ]);
});
