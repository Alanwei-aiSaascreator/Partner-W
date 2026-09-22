import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { afterEach, test } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildPortableFileManifest,
  buildPortableRelease,
  createPortableUpdateArchive,
  verifyPortableRelease,
  writePortableReleaseArtifacts,
} from './portable-update-release.mjs';

const roots = [];
const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'mofang-release-'));
  roots.push(root);
  return root;
}

async function writeProgram(root, files = {}) {
  const programDir = join(root, 'program');
  const entries = {
    '\u8363\u76c8\u9b54\u65b9.exe': 'desktop-binary',
    'resources/app.asar': 'asar-content',
    'resources/runtime/openclaw-runtime-manifest.json': '{}',
    ...files,
  };
  for (const [relativePath, content] of Object.entries(entries)) {
    const target = join(programDir, ...relativePath.split('/'));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return programDir;
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    signingKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

async function makeUnsignedInputs(root, overrides = {}) {
  const programDir = await writeProgram(root);
  const packagePath = join(root, 'portable.zip');
  const { fileManifest, fileManifestBytes } = await buildPortableFileManifest({
    programDir,
    version: '0.0.26',
  });
  await createPortableUpdateArchive({ programDir, archivePath: packagePath, files: fileManifest.files });
  return {
    packagePath,
    fileManifest,
    fileManifestBytes,
    version: '0.0.26',
    channel: 'internal',
    baseUrl: 'https://api.rongyinghudong.com/updates',
    minLauncherVersion: '1.0.0',
    publishedAt: '2026-09-22T00:00:00.000Z',
    ...keyPair(),
    ...overrides,
  };
}

test('portable file manifests are sorted and byte-deterministic', async () => {
  const root = await makeRoot();
  const programDir = await writeProgram(root, {
    'z-last.txt': 'z',
    'a-first.txt': 'a',
  });

  let readCalls = 0;
  const readDirectory = async (...args) => {
    readCalls += 1;
    return (await readdir(...args)).reverse();
  };
  const first = await buildPortableFileManifest({ programDir, version: '0.0.26', readDirectory });
  const second = await buildPortableFileManifest({ programDir, version: '0.0.26', readDirectory });

  assert.deepEqual(
    first.fileManifest.files.map((entry) => entry.path),
    [...first.fileManifest.files.map((entry) => entry.path)].sort(),
  );
  assert.deepEqual(first.fileManifestBytes, second.fileManifestBytes);
  assert.ok(readCalls > 0);
});

test('portable file manifest bytes preserve the cross-language array schema', async () => {
  const root = await makeRoot();
  const programDir = await writeProgram(root);

  const result = await buildPortableFileManifest({ programDir, version: '0.0.26' });
  const parsed = JSON.parse(result.fileManifestBytes.toString('utf8'));

  assert.equal(Array.isArray(parsed.files), true);
  assert.equal(parsed.files.length, result.fileManifest.files.length);
});

test('portable file manifests reject symlinks and reparse-style entries', async () => {
  const root = await makeRoot();
  const programDir = await writeProgram(root);
  const target = join(programDir, 'resources');
  const link = join(programDir, 'runtime-link');
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');

  await assert.rejects(buildPortableFileManifest({ programDir, version: '0.0.26' }), /symbolic link|reparse/i);
});

test('portable file manifests reject protected data and update directories', async () => {
  const root = await makeRoot();
  const programDir = await writeProgram(root, {
    '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e/private.json': '{}',
  });

  await assert.rejects(buildPortableFileManifest({ programDir, version: '0.0.26' }), /forbidden/i);
});

test('archive metadata matches the bytes written to disk', async () => {
  const root = await makeRoot();
  const programDir = await writeProgram(root);
  const archivePath = join(root, 'portable.zip');
  const { fileManifest } = await buildPortableFileManifest({ programDir, version: '0.0.26' });

  const result = await createPortableUpdateArchive({
    programDir,
    archivePath,
    files: fileManifest.files,
  });
  const bytes = await readFile(archivePath);

  assert.equal(result.packageSize, bytes.length);
  assert.equal(result.packageSha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'PK');
});

test('buildPortableRelease signs a manifest that verifies with the configured public key', async () => {
  const root = await makeRoot();
  const input = await makeUnsignedInputs(root);

  const release = await buildPortableRelease(input);

  assert.deepEqual(Object.keys(release).sort(), ['fileManifestBytes', 'manifestBytes', 'packageSha256', 'signature']);
  assert.equal(release.fileManifestBytes.equals(input.fileManifestBytes), true);
  await assert.doesNotReject(
    verifyPortableRelease({
      manifestBytes: release.manifestBytes,
      fileManifestBytes: release.fileManifestBytes,
      packagePath: input.packagePath,
      publicKeyBase64: input.publicKeyBase64,
    }),
  );
});

test('buildPortableRelease rejects a missing private signing key', async () => {
  const root = await makeRoot();
  const input = await makeUnsignedInputs(root, { signingKeyPem: '' });

  await assert.rejects(buildPortableRelease(input), /signing key/i);
});

test('buildPortableRelease rejects a public and private key mismatch', async () => {
  const root = await makeRoot();
  const input = await makeUnsignedInputs(root, { publicKeyBase64: keyPair().publicKeyBase64 });

  await assert.rejects(buildPortableRelease(input), /public key.*match/i);
});

test('buildPortableRelease rejects non-HTTPS package locations', async () => {
  const root = await makeRoot();
  const input = await makeUnsignedInputs(root, { baseUrl: 'http://updates.example.com' });

  await assert.rejects(buildPortableRelease(input), /HTTPS/i);
});

test('verifyPortableRelease rejects a changed package hash', async () => {
  const root = await makeRoot();
  const input = await makeUnsignedInputs(root);
  const release = await buildPortableRelease(input);
  await writeFile(input.packagePath, 'changed-after-signing');

  await assert.rejects(
    verifyPortableRelease({
      manifestBytes: release.manifestBytes,
      fileManifestBytes: release.fileManifestBytes,
      packagePath: input.packagePath,
      publicKeyBase64: input.publicKeyBase64,
    }),
    /package.*integrity/i,
  );
});

test('verifyPortableRelease rejects a one-byte signed-manifest mutation', async () => {
  const root = await makeRoot();
  const input = await makeUnsignedInputs(root);
  const release = await buildPortableRelease(input);
  const manifest = JSON.parse(release.manifestBytes.toString('utf8'));
  const mutatedManifestBytes = Buffer.from(JSON.stringify({ ...manifest, version: '0.0.27' }));

  await assert.rejects(
    verifyPortableRelease({
      manifestBytes: mutatedManifestBytes,
      fileManifestBytes: release.fileManifestBytes,
      packagePath: input.packagePath,
      publicKeyBase64: input.publicKeyBase64,
    }),
    /signature is invalid/i,
  );
});

test('release artifact writer refuses to overwrite an existing artifact', async () => {
  const root = await makeRoot();
  const input = await makeUnsignedInputs(root);
  const release = await buildPortableRelease(input);
  const outDir = join(root, 'release');
  await mkdir(outDir);
  await writeFile(join(outDir, 'manifest.json'), 'existing');

  await assert.rejects(
    writePortableReleaseArtifacts({
      outDir,
      packagePath: input.packagePath,
      manifestBytes: release.manifestBytes,
      fileManifestBytes: release.fileManifestBytes,
    }),
    /refusing to overwrite/i,
  );
});

test('make-portable-update CLI writes and independently verifies all three artifacts', async () => {
  const root = await makeRoot();
  const programDir = await writeProgram(root);
  const outDir = join(root, 'release');
  const keys = keyPair();
  const keyFile = join(root, 'signing-key.pem');
  await writeFile(keyFile, keys.signingKeyPem, { mode: 0o600 });

  const result = spawnSync(
    process.execPath,
    [
      join(repositoryRoot, 'scripts', 'make-portable-update.mjs'),
      '--program-dir',
      programDir,
      '--version',
      '0.0.26',
      '--channel',
      'internal',
      '--base-url',
      'https://updates.example.com',
      '--out',
      outDir,
    ],
    {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        MOFANG_UPDATE_SIGNING_KEY_FILE: keyFile,
        MOFANG_UPDATE_PUBLIC_KEY_B64: keys.publicKeyBase64,
        MOFANG_LAUNCHER_VERSION: '1.0.0',
      },
    },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const manifestBytes = await readFile(join(outDir, 'manifest.json'));
  const fileManifestBytes = await readFile(join(outDir, 'portable-files.json'));
  await assert.doesNotReject(
    verifyPortableRelease({
      manifestBytes,
      fileManifestBytes,
      packagePath: join(outDir, 'portable.zip'),
      publicKeyBase64: keys.publicKeyBase64,
    }),
  );

  const fixtureRoot = join(root, 'release-fixture');
  await mkdir(fixtureRoot);
  await cp(programDir, join(fixtureRoot, 'program'), { recursive: true });
  await cp(join(outDir, 'manifest.json'), join(fixtureRoot, 'manifest.json'));
  await cp(join(outDir, 'portable-files.json'), join(fixtureRoot, 'portable-files.json'));
  await writeFile(join(fixtureRoot, 'public-key.der.b64'), keys.publicKeyBase64);
  const goResult = spawnSync(
    'go',
    ['-C', 'launcher', 'test', './internal/update', '-run', '^TestExternalReleaseFixtureEndToEnd$', '-count=1', '-v'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: { ...process.env, MOFANG_PORTABLE_FIXTURE_ROOT: fixtureRoot },
    },
  );
  assert.equal(goResult.status, 0, `${goResult.stdout}\n${goResult.stderr}`);
  assert.match(goResult.stdout, /--- PASS: TestExternalReleaseFixtureEndToEnd/);
});
