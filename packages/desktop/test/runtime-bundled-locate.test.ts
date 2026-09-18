import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENTRIES } from './helpers/runtime-fixture.js';
import { makeZip } from './helpers/make-zip.js';

/**
 * T-U0「fat installer」：**随安装包自带的那份运行时**能不能被找到、能不能真的用起来。
 *
 * 事故背景（2026-09-18，实机）：安装包里没有运行时、客户端也没有下载运行时的代码，
 * 一台从没部署过运行时的机器**装上我们的包也起不来**。修法是把 `runtime-out/`
 * 打进 `extraResources`（落到 `<resources>/runtime`），并让 `locate.ts` 认它。
 *
 * 这里测的是**接线**（`locateAndPlan` 那一侧），不是候选排序本身 —— 排序在
 * `runtime-locate.test.ts` 里用注入的 `exists` 钉死。两条都要有：只测排序的话，
 * 调用方漏传 `bundledRoot` 不会有任何测试变红。
 *
 * ⚠️ `inputs` 是**必须注入**的：cwd / 盘符枚举 / 打包态在真机上是环境，
 * 不注入的话"随包那份命中"这条会随构建机插没插 U 盘而翻。
 * ⚠️ 会话安全：只在自己的 mkdtemp 目录里建删文件，**绝不触碰**真实 `%APPDATA%`。
 */

vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: vi.fn(() => 'C:\\fake\\userdata'), getVersion: vi.fn(() => '0.0.0') },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false), encryptString: vi.fn(), decryptString: vi.fn() },
}));

let tmpRoot: string;
let prevResourcesPath: string | undefined;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-bundled-'));
  prevResourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
});

afterEach(() => {
  // 双重保险：只删我们自己建的 tmp 目录，路径不含前缀就绝不删。
  if (tmpRoot && tmpRoot.includes(path.join(os.tmpdir(), 'clawwork-bundled-'))) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  if (prevResourcesPath === undefined) {
    delete (process as unknown as { resourcesPath?: string }).resourcesPath;
  } else {
    (process as unknown as { resourcesPath?: string }).resourcesPath = prevResourcesPath;
  }
});

const sha256 = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

interface BundledFixture {
  resourcesPath: string;
  /** `<resources>/runtime` —— 打包时 `extraResources` 的 `to: runtime` 落点。 */
  runtimeRoot: string;
}

/**
 * 造一份「随安装包自带的运行时」，形状与 `runtime-out/` 一致：
 * `openclaw-runtime-manifest.json` + `node/` + `<platform>-<arch>/<归档>`。
 */
function buildBundledRuntime(opts: { withNodeManifest?: boolean; manifestRaw?: string } = {}): BundledFixture {
  const resourcesPath = path.join(tmpRoot, 'resources');
  const runtimeRoot = path.join(resourcesPath, 'runtime');
  const platform = process.platform;
  const arch = process.arch;

  const archiveRel = `${platform}-${arch}/openclaw-runtime-2026.9.3.7z`;
  const archivePath = path.join(runtimeRoot, archiveRel);
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  fs.writeFileSync(archivePath, makeZip(DEFAULT_ENTRIES));

  const nodeExePath = path.join(runtimeRoot, 'node', 'node.exe');
  fs.mkdirSync(path.dirname(nodeExePath), { recursive: true });
  fs.writeFileSync(nodeExePath, Buffer.from('MZ fake node binary\n'));

  fs.writeFileSync(
    path.join(runtimeRoot, 'openclaw-runtime-manifest.json'),
    opts.manifestRaw ??
      JSON.stringify(
        {
          formatVersion: 1,
          packageName: 'openclaw',
          version: '2026.9.3',
          runtimes: [
            {
              platform,
              arch,
              version: '2026.9.3',
              runtimeDeploymentKey: '2026.9.3',
              archive: archiveRel,
              archiveSize: fs.statSync(archivePath).size,
              extractor: `${platform}-${arch}/extractor/7za.exe`,
              size: 0,
              fileCount: DEFAULT_ENTRIES.length,
              packageRoot: 'node_modules/openclaw',
              cliPath: 'node_modules/openclaw/openclaw.mjs',
              source: 'mofang-pack-runtime',
              patches: [],
              requiredPackages: [],
              sha256: sha256(archivePath),
            },
          ],
        },
        null,
        2,
      ),
  );

  if (opts.withNodeManifest !== false) {
    fs.writeFileSync(
      path.join(runtimeRoot, 'node', 'node-manifest.json'),
      JSON.stringify({
        formatVersion: 1,
        packageName: 'node',
        nodes: [
          {
            platform,
            arch,
            version: '26.3.1',
            path: 'node/node.exe',
            sha256: sha256(nodeExePath),
            size: fs.statSync(nodeExePath).size,
            source: 'test',
          },
        ],
      }),
    );
  }

  return { resourcesPath, runtimeRoot };
}

/** 只有「随包那份」这一条路：dev 找不到、没有盘、也没有缓存。 */
const inputsFor = (fx: BundledFixture, over: { isPackaged: boolean } = { isPackaged: true }) => ({
  cwd: tmpRoot,
  devRoots: [],
  driveLetters: [],
  isPackaged: over.isPackaged,
  resourcesPath: fx.resourcesPath,
});

describe('locateAndPlan：随包那份运行时（bundled）', () => {
  it('⭐ 打包态 + 没插盘 + 没缓存 ⇒ 命中 `<resources>/runtime`，且**真的能部署成功**', async () => {
    const { locateAndPlan } = await import('../src/main/runtime/index.js');
    const { readCurrentDeployment } = await import('../src/main/runtime/deploy.js');
    const fx = buildBundledRuntime();
    const userDataDir = path.join(tmpRoot, 'userdata');
    fs.mkdirSync(userDataDir, { recursive: true });

    const plan = await locateAndPlan(userDataDir, inputsFor(fx));

    expect(plan.ok, plan.ok ? '' : plan.reason).toBe(true);
    if (!plan.ok) return;
    expect(plan.runtimeRoot).toBe(fx.runtimeRoot);

    // 部署是**真的**跑：解压 + 验 hash + 写 stamp + 指针
    const res = await plan.deploy({ userDataDir });
    expect(res.status).toBe('deployed');
    expect(res.deploymentKey).toContain('2026.9.3');
    expect(fs.existsSync(res.nodePath)).toBe(true); // 缓存里自带 node（拔盘也能跑）
    expect(fs.existsSync(res.cliPath)).toBe(true);
    // clawrouter 入口必须在 —— 不在的话中转计量会**静默**为 0
    expect(
      fs.existsSync(path.join(res.deployedRoot, 'node_modules/openclaw/dist/extensions/clawrouter/index.js')),
    ).toBe(true);

    const cur = readCurrentDeployment(userDataDir);
    expect(cur.status).toBe('ok');
    expect(cur.deploymentKey).toBe(res.deploymentKey);
  });

  it('⭐ dev 态（app.isPackaged=false）⇒ bundled 连候选都没有，原因里说清"找过哪些地方"', async () => {
    const { locateAndPlan } = await import('../src/main/runtime/index.js');
    const fx = buildBundledRuntime();

    const plan = await locateAndPlan(path.join(tmpRoot, 'userdata'), inputsFor(fx, { isPackaged: false }));

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('找不到运行时的部署源');
    expect(plan.reason).toContain('没产生候选的来源');
    expect(plan.reason).toContain('drive：'); // 盘也没枚举到 —— 同样要说出来
    expect(plan.reason).toContain('dev：'); // 从哪个目录向上找的也要有（cwd 是环境，说不清就没法排障）
    expect(plan.reason).toContain('bundled：');
    expect(plan.reason).toContain('app.isPackaged=false');
    // 排障入口：盘没插 / 包里没带，两种形状都指向可操作的下一步
    expect(plan.reason).toContain('CLAWWORK_RUNTIME_DIR');
    expect(plan.reason).toContain('安装包里没带运行时');
  });

  it('命中但那份**不完整**（缺 node/node-manifest.json）⇒ 原因点明是哪一份来源', async () => {
    const { locateAndPlan } = await import('../src/main/runtime/index.js');
    const fx = buildBundledRuntime({ withNodeManifest: false });

    const plan = await locateAndPlan(path.join(tmpRoot, 'userdata'), inputsFor(fx));

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('[bundled]');
    expect(plan.reason).toContain(fx.runtimeRoot);
    expect(plan.reason).toContain('node-manifest.json');
  });

  it('命中但 manifest **是坏的** ⇒ 原因带来源 + 原始错误（知道去修哪个盘/哪个包）', async () => {
    const { locateAndPlan } = await import('../src/main/runtime/index.js');
    const fx = buildBundledRuntime({ manifestRaw: '{ "formatVersion": 1 }' });

    const plan = await locateAndPlan(path.join(tmpRoot, 'userdata'), inputsFor(fx));

    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toContain('[bundled]');
    expect(plan.reason).toContain('运行时 manifest');
  });

  it('⭐ 真机那侧的采集口：`app.isPackaged` 确实决定 bundled 进不进候选', async () => {
    const { collectRuntimeSearchInputs } = await import('../src/main/runtime/index.js');
    const { planRuntimeSearch } = await import('../src/main/runtime/locate.js');
    const fx = buildBundledRuntime();
    (process as unknown as { resourcesPath?: string }).resourcesPath = fx.resourcesPath;

    const candidates = planRuntimeSearch(collectRuntimeSearchInputs()).candidates;

    expect(candidates.map((c) => c.origin)).toContain('bundled');
    expect(candidates.find((c) => c.origin === 'bundled')?.root).toBe(fx.runtimeRoot);
  });
});
