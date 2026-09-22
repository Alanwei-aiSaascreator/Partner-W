#!/usr/bin/env node

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertPathOutsideRepository,
  buildPortableFileManifest,
  buildPortableRelease,
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

async function main() {
  const input = parseArguments(process.argv.slice(2));
  await assertEmptyOutput(input.outDir);
  const keyFile = process.env.MOFANG_UPDATE_SIGNING_KEY_FILE;
  if (!keyFile) throw new Error('MOFANG_UPDATE_SIGNING_KEY_FILE is required');
  const publicKeyBase64 = process.env.MOFANG_UPDATE_PUBLIC_KEY_B64;
  if (!publicKeyBase64) throw new Error('MOFANG_UPDATE_PUBLIC_KEY_B64 is required');
  const minLauncherVersion = process.env.MOFANG_LAUNCHER_VERSION;
  if (!minLauncherVersion) throw new Error('MOFANG_LAUNCHER_VERSION is required');

  const safeKeyFile = assertPathOutsideRepository(keyFile, repositoryRoot);
  const signingKeyPem = await readSigningKeyFile(safeKeyFile);
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'mofang-portable-release-'));
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
