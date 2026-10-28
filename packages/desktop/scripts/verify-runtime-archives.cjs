'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Validate supplied archive bytes only; this does not prove session tool availability. */
async function verifyRuntimeArchives(root) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'openclaw-runtime-manifest.json'), 'utf8'));
  if (
    !record(manifest) ||
    manifest.formatVersion !== 1 ||
    manifest.packageName !== 'openclaw' ||
    !nonempty(manifest.version) ||
    !Array.isArray(manifest.runtimes) ||
    manifest.runtimes.length === 0
  )
    throw Error('Invalid runtime archive manifest');
  const realRoot = fs.realpathSync(root);
  for (const variant of manifest.runtimes) {
    if (
      !record(variant) ||
      !['platform', 'arch', 'version', 'runtimeDeploymentKey', 'packageRoot', 'cliPath'].every((key) =>
        nonempty(variant[key]),
      ) ||
      !Number.isSafeInteger(variant.archiveSize) ||
      variant.archiveSize <= 0 ||
      !Number.isSafeInteger(variant.fileCount) ||
      variant.fileCount <= 0 ||
      typeof variant.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(variant.sha256)
    )
      throw Error('Invalid runtime archive manifest entry');
    const archive = variant.archive;
    if (
      !nonempty(archive) ||
      /[\\:\0]/.test(archive) ||
      archive.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    )
      throw Error('Invalid runtime archive path');
    const full = path.resolve(root, archive);
    const canonical = fs.realpathSync(full);
    if (!inside(path.resolve(root), full) || !inside(realRoot, canonical))
      throw Error('Invalid runtime archive path outside bundled root');
    // Open the checked canonical path once, then measure and hash the same file descriptor.
    const fd = fs.openSync(canonical, 'r');
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw Error('Runtime archive must be a regular file');
      if (stat.size !== variant.archiveSize) throw Error('Runtime archive size mismatch');
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(null, { fd, autoClose: false })) hash.update(chunk);
      if (hash.digest('hex') !== variant.sha256) throw Error('Runtime archive hash mismatch');
    } finally {
      fs.closeSync(fd);
    }
  }
  return manifest;
}
module.exports = { verifyRuntimeArchives };
