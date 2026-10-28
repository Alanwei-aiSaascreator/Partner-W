#!/usr/bin/env node

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPathOutsideRepository,
  buildPortableFileManifest,
  buildPortableRelease,
  compareSemanticVersions,
  createPortableUpdateArchive,
  readSigningKeyFile,
  verifyPortableRelease,
  writePortableReleaseArtifacts,
} from './lib/portable-update-release.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArguments(argv) {
  const names = ['program-dir', 'version', 'channel', 'base-url', 'out'];
  const values = {};
  for (const name of names) {
    const index = argv.indexOf(`--${name}`);
    if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`--${name} is required`);
    }
    values[name] = argv[index + 1];
  }
  return {
    programDir: resolve(values['program-dir']),
    version: values.version,
    channel: values.channel,
    baseUrl: values['base-url'],
    outDir: resolve(values.out),
  };
}

async function assertEmptyOutput(outDir) {
  try {
    const entries = await readdir(outDir);
    if (entries.length > 0) throw new Error('refusing to overwrite an existing release artifact');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

/**
 * manifest 的 `minLauncherVersion` = **最老的那个还能装这份更新的启动器**。
 *
 * ⚠️ 它**不是**"本次发布的版本"，也**不是** `PARTNERW_LAUNCHER_VERSION`
 * （那个量是"我们现在构建的这把启动器自己的版本"）。两者以前共用一个变量名，
 * 后果很具体：便携更新**从来不换启动器**（`Partner-W启动器.exe` 在
 * `portable-update-release.mjs` 的 FORBIDDEN_NAMES 里，只能靠人工换基础包），
 * 所以 0.0.28 那次会把门槛写成 0.0.28，而盘上那把是 0.0.27
 * ⇒ 0.0.27 → 0.0.28 的自动升级直接被 `launcher-incompatible` 挡死。
 * 所以这里**没有默认值**：缺了就硬失败，绝不静默签出一份装不上的包。
 */
function requireMinLauncherVersion(env) {
  const raw = env.PARTNERW_MIN_LAUNCHER_VERSION;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(
      [
        'PARTNERW_MIN_LAUNCHER_VERSION is required (no default, deliberately).',
        '  它 = 最老的那个还能装这份更新的启动器版本，通常就是**当前基础包里那把启动器**的版本。',
        '  ⚠️ 不要填本次发布版本，也不要复用 PARTNERW_LAUNCHER_VERSION —',
        '     那个量是"我们这次构建的启动器自己的版本"，两者含义不同。',
        '     便携更新不换启动器：填成本次版本会让上一版基础包的盘永远升不上来。',
      ].join('\n'),
    );
  }
  const value = raw.trim();
  return value;
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  await assertEmptyOutput(input.outDir);
  const keyFile = process.env.PARTNERW_UPDATE_SIGNING_KEY_FILE;
  if (!keyFile) throw new Error('PARTNERW_UPDATE_SIGNING_KEY_FILE is required');
  const publicKeyBase64 = process.env.PARTNERW_UPDATE_PUBLIC_KEY_B64;
  if (!publicKeyBase64) throw new Error('PARTNERW_UPDATE_PUBLIC_KEY_B64 is required');
  const minLauncherVersion = requireMinLauncherVersion(process.env);

  // 一致性校验（能收敛的收敛不了，就断言两侧取值自洽）：
  // 门槛比"本次要发的启动器"还新，永远是个错误 —— 那等于要求一个还不存在的启动器。
  const shippedLauncherVersion = process.env.PARTNERW_LAUNCHER_VERSION;
  if (
    typeof shippedLauncherVersion === 'string' &&
    shippedLauncherVersion.trim().length > 0 &&
    compareSemanticVersions(minLauncherVersion, shippedLauncherVersion.trim()) > 0
  ) {
    throw new Error(
      `minLauncherVersion (${minLauncherVersion}) is newer than the launcher this release ships ` +
        `(PARTNERW_LAUNCHER_VERSION=${shippedLauncherVersion.trim()}); no drive can satisfy that.`,
    );
  }

  const safeKeyFile = assertPathOutsideRepository(keyFile, repositoryRoot);
  const signingKeyPem = await readSigningKeyFile(safeKeyFile);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'partner-w-portable-release-'));
  try {
    const packagePath = join(temporaryRoot, 'portable.zip');
    const { fileManifest, fileManifestBytes } = await buildPortableFileManifest({
      programDir: input.programDir,
      version: input.version,
    });
    await createPortableUpdateArchive({
      programDir: input.programDir,
      archivePath: packagePath,
      files: fileManifest.files,
    });
    const release = await buildPortableRelease({
      packagePath,
      fileManifest,
      fileManifestBytes,
      version: input.version,
      channel: input.channel,
      baseUrl: input.baseUrl,
      minLauncherVersion,
      publishedAt: new Date().toISOString(),
      signingKeyPem,
      publicKeyBase64,
    });
    await verifyPortableRelease({
      manifestBytes: release.manifestBytes,
      fileManifestBytes: release.fileManifestBytes,
      packagePath,
      publicKeyBase64,
    });
    await writePortableReleaseArtifacts({
      outDir: input.outDir,
      packagePath,
      manifestBytes: release.manifestBytes,
      fileManifestBytes: release.fileManifestBytes,
    });
    console.log(`Portable update artifacts written to ${input.outDir}`);
    console.log(`Package SHA-256: ${release.packageSha256}`);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
