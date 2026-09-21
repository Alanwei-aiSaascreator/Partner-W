import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const version = env?.MOFANG_LAUNCHER_VERSION;
  const publicKeyBase64 = env?.MOFANG_UPDATE_PUBLIC_KEY_B64;
  if (typeof version !== 'string' || version.length === 0) {
    throw new PortableLauncherBuildError('MOFANG_LAUNCHER_VERSION is required to build the portable launcher');
  }
  if (typeof publicKeyBase64 !== 'string' || publicKeyBase64.length === 0) {
    throw new PortableLauncherBuildError('MOFANG_UPDATE_PUBLIC_KEY_B64 is required to build the portable launcher');
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
    './cmd/mofang-launcher',
  ];
}

function isPortableExecutable(path) {
  const header = Buffer.alloc(2);
  const descriptor = readFileSync(path);
  header[0] = descriptor[0] ?? 0;
  header[1] = descriptor[1] ?? 0;
  return header.toString('ascii') === 'MZ';
}

export function buildPortableLauncher({
  env,
  outputPath = defaultLauncherOutput,
  runner = spawnSync,
  goBinary = 'go',
  log = () => {},
}) {
  const { version, publicKeyBase64 } = requireEnvironment(env);
  const arguments_ = launcherBuildArguments({ version, publicKeyBase64, outputPath });
  log(`building the portable launcher for version ${version}`);

  const result = runner(goBinary, arguments_, {
    cwd: repositoryRoot,
    env: { ...env, GOOS: 'windows', GOARCH: 'amd64' },
    stdio: 'pipe',
    encoding: 'utf8',
  });

  const diagnostic = redactSecrets([result?.stdout ?? '', result?.stderr ?? ''].filter(Boolean).join('\n'), [
    publicKeyBase64,
  ]);
  if (diagnostic.length > 0) log(diagnostic);

  if (result?.error) {
    throw new PortableLauncherBuildError(
      redactSecrets(`the launcher toolchain did not start: ${result.error.message}`, [publicKeyBase64]),
    );
  }
  if (result?.status !== 0) {
    throw new PortableLauncherBuildError(`the launcher toolchain exited with status ${result?.status}`);
  }
  if (!existsSync(outputPath)) {
    throw new PortableLauncherBuildError('the launcher binary was not produced');
  }

  const size = statSync(outputPath).size;
  if (size === 0) {
    throw new PortableLauncherBuildError('the launcher binary is empty');
  }
  if (!isPortableExecutable(outputPath)) {
    throw new PortableLauncherBuildError('the launcher output is not a Windows PE image');
  }

  log(`portable launcher written to ${outputPath} (${size} bytes)`);
  return { outputPath, size };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    buildPortableLauncher({ env: process.env, log: (message) => console.log(message) });
  } catch (error) {
    console.error(error instanceof PortableLauncherBuildError ? error.message : error);
    process.exit(1);
  }
}
