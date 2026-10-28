import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyExecutableIcon } from './pe-icon.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(here, '..', '..');

export const launcherOutputName = '\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe';
export const defaultLauncherOutput = join(repositoryRoot, 'artifacts', launcherOutputName);

const REDACTION = '***';

export class PortableLauncherBuildError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PortableLauncherBuildError';
  }
}

export function redactSecrets(text, secrets) {
  let redacted = String(text);
  for (const secret of secrets) {
    if (typeof secret !== 'string' || secret.length === 0) continue;
    redacted = redacted.split(secret).join(REDACTION);
  }
  return redacted;
}

export function requireEnvironment(env) {
  const version = env?.PARTNERW_LAUNCHER_VERSION;
  const publicKeyBase64 = env?.PARTNERW_UPDATE_PUBLIC_KEY_B64;
  if (typeof version !== 'string' || version.length === 0) {
    throw new PortableLauncherBuildError('PARTNERW_LAUNCHER_VERSION is required to build the portable launcher');
  }
  if (typeof publicKeyBase64 !== 'string' || publicKeyBase64.length === 0) {
    throw new PortableLauncherBuildError('PARTNERW_UPDATE_PUBLIC_KEY_B64 is required to build the portable launcher');
  }
  return { version, publicKeyBase64 };
}

export function launcherBuildArguments({ version, publicKeyBase64, outputPath }) {
  return [
    '-C',
    'launcher',
    'build',
    '-trimpath',
    '-ldflags',
    `-s -w -H=windowsgui -X main.version=${version} -X main.publicKeyBase64=${publicKeyBase64}`,
    '-o',
    outputPath,
    './cmd/partner-w-launcher',
  ];
}

export async function resolveResourceEditor() {
  if (process.platform !== 'win32') throw new PortableLauncherBuildError('The launcher resource tool requires Windows');
  try {
    const desktopRequire = createRequire(join(repositoryRoot, 'packages', 'desktop', 'package.json'));
    const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
    const { getBin } = builderRequire('app-builder-lib/out/binDownload.js');
    const resourceEditor = join(await getBin('winCodeSign'), 'rcedit-x64.exe');
    if (!existsSync(resourceEditor)) throw new Error('rcedit-x64.exe is missing from the resolved vendor directory');
    return resourceEditor;
  } catch (error) {
    throw new PortableLauncherBuildError(`The launcher resource tool is unavailable: ${error.message}`);
  }
}

export async function buildPortableLauncher({
  env,
  outputPath = defaultLauncherOutput,
  runner = spawnSync,
  goBinary = 'go',
  resourceEditorResolver = resolveResourceEditor,
  iconPath = join(repositoryRoot, 'packages', 'desktop', 'build', 'icon.ico'),
  log = () => {},
}) {
  const { version, publicKeyBase64 } = requireEnvironment(env);
  const resourceEditor = await resourceEditorResolver();
  if (!resourceEditor) throw new PortableLauncherBuildError('The launcher resource tool is unavailable');
  const sourceIcon = readFileSync(iconPath);
  const outputDirectory = dirname(resolve(outputPath));
  mkdirSync(outputDirectory, { recursive: true });
  const stageDirectory = mkdtempSync(join(outputDirectory, '.launcher-build-'));
  const stagedOutput = join(stageDirectory, 'launcher.exe');
  const arguments_ = launcherBuildArguments({ version, publicKeyBase64, outputPath: stagedOutput });
  log(`building the portable launcher for version ${version}`);

  function run(binary, args, label) {
    const result = runner(binary, args, {
      cwd: repositoryRoot,
      env: { ...env, GOOS: 'windows', GOARCH: 'amd64' },
      stdio: 'pipe',
      encoding: 'utf8',
      windowsHide: true,
    });

    const diagnostic = redactSecrets([result?.stdout ?? '', result?.stderr ?? ''].filter(Boolean).join('\n'), [
      publicKeyBase64,
    ]);
    if (diagnostic.length > 0) log(diagnostic);

    if (result?.error) {
      throw new PortableLauncherBuildError(
        redactSecrets(`the launcher ${label} did not start: ${result.error.message}`, [publicKeyBase64]),
      );
    }
    if (result?.status !== 0) {
      throw new PortableLauncherBuildError(`the launcher ${label} exited with status ${result?.status}`);
    }
  }
  try {
    run(goBinary, arguments_, 'toolchain');
    if (!existsSync(stagedOutput)) {
      throw new PortableLauncherBuildError('the launcher binary was not produced');
    }

    const sizeBeforeEdit = statSync(stagedOutput).size;
    if (sizeBeforeEdit === 0) {
      throw new PortableLauncherBuildError('the launcher binary is empty');
    }
    if (readFileSync(stagedOutput).toString('ascii', 0, 2) !== 'MZ') {
      throw new PortableLauncherBuildError('the launcher output is not a Windows PE image');
    }
    /**
     * 图标之外再写**版本资源**（2026-10-19，360 误报治理）。
     *
     * 为什么必须写：一把**未签名、且没有任何版本信息**的 exe，对杀软与 SmartScreen 的
     * 信誉系统来说几乎是"可疑"的同义词（用户侧表现就是"装完被 360 报木马"）。
     * 名字/公司/描述/版本都是公开信息，写进去不增加任何泄露风险，却能显著降低启发式命中。
     * rcedit 在没有版本资源时会新建一份；参数顺序无所谓，失败即以非零码退出，由 run() 抛错。
     */
    run(
      resourceEditor,
      [
        stagedOutput,
        '--set-icon',
        iconPath,
        // ⚠️ rcedit 没有 `--set-company-name` 这类开关（那是 electron-builder 的包装）；
        //    版本字符串统一走 `--set-version-string <Key> <Value>`。
        '--set-version-string',
        'CompanyName',
        'Partner-W互动',
        '--set-version-string',
        'ProductName',
        'Partner-W',
        '--set-version-string',
        'FileDescription',
        'Partner-W启动器',
        '--set-version-string',
        'InternalName',
        'partner-w-launcher',
        '--set-version-string',
        'OriginalFilename',
        launcherOutputName,
        '--set-version-string',
        'LegalCopyright',
        'Copyright © Partner-W互动',
        '--set-file-version',
        version,
        '--set-product-version',
        version,
      ],
      'resource editor',
    );
    let verification;
    try {
      verification = verifyExecutableIcon(readFileSync(stagedOutput), sourceIcon);
    } catch (error) {
      throw new PortableLauncherBuildError(`The launcher icon verification failed: ${error.message}`);
    }
    const size = statSync(stagedOutput).size;
    renameSync(stagedOutput, resolve(outputPath));
    log(`portable launcher written to ${outputPath} (${size} bytes)`);
    return { outputPath, size, iconImages: verification.imageCount };
  } finally {
    rmSync(stageDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    await buildPortableLauncher({ env: process.env, log: (message) => console.log(message) });
  } catch (error) {
    console.error(error instanceof PortableLauncherBuildError ? error.message : error);
    process.exit(1);
  }
}
