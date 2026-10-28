/**
 * Electron 探针的共享外壳（2026-10-07 从 `artifact-reconcile.test.ts` 提出）。
 *
 * ## 为什么需要它
 *
 * 产物表那批行为（唯一索引冲突、reconcile 的读文件失败、真实 SQLite 事务）在 vitest 里
 * 测不了：`better-sqlite3` 是**按 Electron ABI 重建**的原生模块（`postinstall:
 * electron-builder install-app-deps`），普通 Node 载入它直接报版本不匹配。
 *
 * 于是走既有那套：把探针（`test/helpers/*-probe.ts`）用 vite 打成单文件 mjs，
 * 用 **`ELECTRON_RUN_AS_NODE=1`** 的 electron 二进制在**真主进程模块**里跑，
 * 结果走 stdout 的一行 JSON（`ARTIFACT_PROBE_RESULT=`）回传。
 *
 * ⚠️ 两个测试档（reconcile / save）各 build 一次、各跑自己的场景 —— 探针文件是同一个也行、
 *    不同也行，`buildElectronProbe` 只管"把入口打成一个 mjs 并告诉你怎么跑"。
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const electronPath = require('electron') as string;

/** 探针把结果写成 stdout 的这一行（两个探针共用同一个前缀）。 */
export const PROBE_RESULT_PREFIX = 'ARTIFACT_PROBE_RESULT=';

export interface ElectronProbeOptions {
  /** 探针入口（`test/helpers/*-probe.ts` 的绝对路径）。 */
  probePath: string;
  /** vite 的 root（`packages/desktop`）。 */
  packageDir: string;
  /**
   * 私有探针根（U 盘/加密盘等"不能把临时文件放 C 盘"的场景）。
   * 设了它 ⇒ 产物落这里、`better-sqlite3` 走 external（见下）。
   */
  privateProbeRoot?: string;
}

export interface ElectronProbe {
  compiledProbePath: string;
  cleanup: () => void;
}

export async function buildElectronProbe(options: ElectronProbeOptions): Promise<ElectronProbe> {
  const { probePath, packageDir, privateProbeRoot } = options;
  const runnerDir = mkdtempSync(join(privateProbeRoot ?? packageDir, '.artifact-probe-'));
  await build({
    configFile: false,
    logLevel: 'silent',
    root: packageDir,
    plugins: [
      // CI/受控环境用 git 索引里的版本构建探针（工作树可能正被并发编辑）。
      ...(process.env.CLAW_TEST_GIT_INDEX === '1'
        ? [
            {
              name: 'probe-scoped-index',
              enforce: 'pre' as const,
              load(id: string) {
                const repository = resolve(packageDir, '../..');
                const path = relative(repository, id.split('?')[0]).replaceAll('\\', '/');
                if (/^packages\/.*(?:\.[cm]?[jt]sx?|\.json)$/.test(path))
                  return execFileSync('git', ['show', `:${path}`], { cwd: repository, encoding: 'utf8' });
              },
            },
          ]
        : []),
      // 私有根场景里原生模块必须留在外面（拷进临时目录会加载失败）。
      ...(privateProbeRoot
        ? [
            {
              name: 'probe-private-native-path',
              enforce: 'pre' as const,
              resolveId(source: string) {
                if (source === 'better-sqlite3')
                  return { id: pathToFileURL(require.resolve('better-sqlite3')).href, external: true };
              },
            },
          ]
        : []),
    ],
    ssr: { noExternal: true, external: privateProbeRoot ? [] : ['better-sqlite3'] },
    build: {
      emptyOutDir: true,
      minify: false,
      outDir: runnerDir,
      ssr: probePath,
      rollupOptions: { output: { entryFileNames: 'probe.mjs' } },
    },
  });
  const compiledProbePath = join(runnerDir, 'probe.mjs');
  return {
    compiledProbePath,
    cleanup: () => rmSync(runnerDir, { recursive: true, force: true }),
  };
}

export interface RunProbeOptions {
  compiledProbePath: string;
  packageDir: string;
  /** 探针的第一个 argv（reconcile 探针 = 工作区；save 探针 = 工作区）。 */
  workspacePath: string;
  scenario: string;
  privateProbeRoot?: string;
}

/** 跑一次探针，返回它那行 JSON。失败（起不来/非 0/没有结果行）直接抛，含 stderr。 */
export function runElectronProbe(options: RunProbeOptions): Record<string, unknown> {
  const { compiledProbePath, packageDir, workspacePath, scenario, privateProbeRoot } = options;
  let child: string;
  try {
    child = execFileSync(electronPath, [compiledProbePath, workspacePath, scenario], {
      cwd: packageDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(privateProbeRoot ? { TMPDIR: privateProbeRoot, TMP: privateProbeRoot, TEMP: privateProbeRoot } : {}),
      },
      timeout: 30_000,
    });
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string; message?: string };
    throw new Error(
      `Artifact probe exited with status ${failure.status ?? '?'}:\n${failure.stderr ?? ''}\n${failure.stdout ?? ''}\n${failure.message ?? ''}`,
    );
  }
  const line = child.split(/\r?\n/).find((value) => value.startsWith(PROBE_RESULT_PREFIX));
  if (!line) throw new Error(`Artifact probe did not return a result:\n${child}`);
  return JSON.parse(line.slice(PROBE_RESULT_PREFIX.length)) as Record<string, unknown>;
}
