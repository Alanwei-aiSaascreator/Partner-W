const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { verifyRuntimeArchives } = require('./verify-runtime-archives.cjs');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archive-gate-'));
  const bytes = Buffer.from('private archive fixture');
  fs.writeFileSync(path.join(root, 'runtime.zip'), bytes);
  const variant = {
    platform: 'win32',
    arch: 'x64',
    version: '2026.9.3',
    runtimeDeploymentKey: 'fixture',
    archive: 'runtime.zip',
    archiveSize: bytes.length,
    fileCount: 1,
    packageRoot: 'node_modules/openclaw',
    cliPath: 'node_modules/openclaw/openclaw.mjs',
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const manifest = { formatVersion: 1, packageName: 'openclaw', version: variant.version, runtimes: [variant] };
  return {
    root,
    bytes,
    manifest,
    save: () => fs.writeFileSync(path.join(root, 'openclaw-runtime-manifest.json'), JSON.stringify(manifest)),
  };
}
async function withFixture(run) {
  const f = fixture();
  try {
    f.save();
    await run(f);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
}
test('verifies every archive against declared size and streamed SHA-256', () =>
  withFixture(async (f) => {
    assert.deepEqual(await verifyRuntimeArchives(f.root), f.manifest);
    f.manifest.runtimes.push({ ...f.manifest.runtimes[0], archive: 'second.zip' });
    f.save();
    await assert.rejects(verifyRuntimeArchives(f.root), /ENOENT/);
  }));
test('rejects empty/malformed manifest and archive identity fields', () =>
  withFixture(async (f) => {
    for (const bad of [
      {},
      { ...f.manifest, runtimes: [] },
      { ...f.manifest, formatVersion: 2 },
      { ...f.manifest, runtimes: [null] },
    ]) {
      fs.writeFileSync(path.join(f.root, 'openclaw-runtime-manifest.json'), JSON.stringify(bad));
      await assert.rejects(verifyRuntimeArchives(f.root), /manifest/i);
    }
    for (const [key, value] of [
      ['sha256', 'bad'],
      ['archiveSize', -1],
      ['fileCount', 1.5],
      ['platform', ''],
      ['cliPath', null],
    ]) {
      const original = f.manifest.runtimes[0][key];
      f.manifest.runtimes[0][key] = value;
      f.save();
      await assert.rejects(verifyRuntimeArchives(f.root), /manifest/i);
      f.manifest.runtimes[0][key] = original;
    }
  }));
test('rejects lexical escapes, absolute paths, NTFS streams, directory archives and linked escapes', () =>
  withFixture(async (f) => {
    for (const archive of [
      '../outside.zip',
      '/absolute.zip',
      'C:/absolute.zip',
      'runtime.zip:stream',
      '.',
      'sub/../runtime.zip',
    ]) {
      f.manifest.runtimes[0].archive = archive;
      f.save();
      await assert.rejects(verifyRuntimeArchives(f.root), /archive path/i);
    }
    fs.mkdirSync(path.join(f.root, 'directory'));
    f.manifest.runtimes[0].archive = 'directory';
    f.save();
    await assert.rejects(verifyRuntimeArchives(f.root), /regular file/i);
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-archive-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'runtime.zip'), f.bytes);
      fs.symlinkSync(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
      f.manifest.runtimes[0].archive = 'linked/runtime.zip';
      f.save();
      await assert.rejects(verifyRuntimeArchives(f.root), /archive path/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }));
test('rejects truncated files and changed bytes even when size is updated', () =>
  withFixture(async (f) => {
    fs.appendFileSync(path.join(f.root, 'runtime.zip'), 'corrupt');
    await assert.rejects(verifyRuntimeArchives(f.root), /archive size/i);
    f.manifest.runtimes[0].archiveSize = fs.statSync(path.join(f.root, 'runtime.zip')).size;
    f.save();
    await assert.rejects(verifyRuntimeArchives(f.root), /archive hash/i);
  }));
