import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256File, verifyArchive } from './pack-runtime.mjs';
import {
  patchRelayVideoRuntime,
  RELAY_VIDEO_RUNTIME_ENTRY,
  RELAY_VIDEO_RUNTIME_PATCH_ID,
} from './lib/relay-video-runtime.mjs';

const FROZEN_ARCHIVE_SHA256 = '9a525e1e0012795d563f6536132e1ee25293610ff62a554ec3ba9c0471402fda';

function inside(root, relative) {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('unsafe runtime path');
  return target;
}

export function repackRelayVideoRuntime({ sourceRoot, outputRoot, sevenZip }) {
  sourceRoot = path.resolve(sourceRoot);
  outputRoot = path.resolve(outputRoot);
  if (fs.existsSync(outputRoot)) throw new Error('output directory must not exist; original files are never replaced');
  if (sourceRoot === outputRoot || !path.relative(sourceRoot, outputRoot).startsWith('..')) {
    throw new Error('output must be separate from the source runtime');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'openclaw-runtime-manifest.json'), 'utf8'));
  if (manifest.runtimes?.length !== 1) throw new Error('expected one frozen runtime');
  const runtime = manifest.runtimes[0];
  const sourceArchive = inside(sourceRoot, runtime.archive);
  if (sha256File(sourceArchive) !== FROZEN_ARCHIVE_SHA256 || runtime.sha256 !== FROZEN_ARCHIVE_SHA256) {
    throw new Error('frozen runtime archive hash mismatch');
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(outputRoot), `.${path.basename(outputRoot)}-staging-`));
  execFileSync(sevenZip, ['x', sourceArchive, `-o${staging}`, '-y', RELAY_VIDEO_RUNTIME_ENTRY], { stdio: 'pipe' });
  const sourceFile = inside(staging, RELAY_VIDEO_RUNTIME_ENTRY);
  const original = fs.readFileSync(sourceFile, 'utf8');
  const patched = patchRelayVideoRuntime(original);
  fs.writeFileSync(sourceFile, patched);
  const outputArchive = inside(outputRoot, runtime.archive);
  fs.mkdirSync(path.dirname(outputArchive), { recursive: true });
  fs.copyFileSync(sourceArchive, outputArchive, fs.constants.COPYFILE_EXCL);
  execFileSync(sevenZip, ['u', '-tzip', outputArchive, RELAY_VIDEO_RUNTIME_ENTRY], { cwd: staging, stdio: 'pipe' });
  execFileSync(sevenZip, ['t', outputArchive], { stdio: 'pipe' });
  const extracted = execFileSync(sevenZip, ['e', '-so', outputArchive, RELAY_VIDEO_RUNTIME_ENTRY], {
    maxBuffer: 1_000_000,
  });
  if (!extracted.equals(Buffer.from(patched))) throw new Error('archived runtime patch differs from tested source');
  verifyArchive(sevenZip, outputArchive);
  runtime.sha256 = sha256File(outputArchive);
  runtime.archiveSize = fs.statSync(outputArchive).size;
  runtime.patches = [...new Set([...(runtime.patches ?? []), RELAY_VIDEO_RUNTIME_PATCH_ID])];
  for (const name of ['node', 'kb-model']) {
    const from = path.join(sourceRoot, name);
    if (fs.existsSync(from))
      fs.cpSync(from, path.join(outputRoot, name), { recursive: true, errorOnExist: true, force: false });
  }
  fs.mkdirSync(path.join(outputRoot, 'openclaw-runtime'), { recursive: true });
  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(path.join(outputRoot, 'openclaw-runtime-manifest.json'), json, { flag: 'wx' });
  fs.writeFileSync(path.join(outputRoot, 'openclaw-runtime', 'manifest.json'), json, { flag: 'wx' });
  const receipt = {
    sourceRoot,
    outputRoot,
    originalArchiveSha256: FROZEN_ARCHIVE_SHA256,
    archiveSha256: runtime.sha256,
    archiveSize: runtime.archiveSize,
    patches: runtime.patches,
    verifiedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(staging, 'video-patch-receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: 'wx',
  });
  return receipt;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const value = (name) => args[args.indexOf(name) + 1];
  if (!args.includes('--source-root') || !args.includes('--out'))
    throw new Error('required: --source-root <frozen runtime> --out <new directory>');
  console.log(
    JSON.stringify(
      repackRelayVideoRuntime({
        sourceRoot: value('--source-root'),
        outputRoot: value('--out'),
        sevenZip: args.includes('--7zip') ? value('--7zip') : 'C:/Program Files/7-Zip/7z.exe',
      }),
      null,
      2,
    ),
  );
}
