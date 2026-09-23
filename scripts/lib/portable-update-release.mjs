import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';
import { createReadStream, createWriteStream, constants as fsConstants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createDeflateRaw } from 'node:zlib';

export const PORTABLE_PACKAGE_NAME = 'portable.zip';
export const PORTABLE_MANIFEST_NAME = 'manifest.json';
export const PORTABLE_FILE_MANIFEST_NAME = 'portable-files.json';

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DEVICE_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const FORBIDDEN_NAMES = new Set([
  '\u8363\u76c8\u9b54\u65b9-\u8fd0\u884c\u6570\u636e',
  '\u8363\u76c8\u9b54\u65b9\u5de5\u4f5c\u533a',
  '.\u8363\u76c8\u9b54\u65b9\u66f4\u65b0',
  '\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe',
]);
const ZIP_UTF8_DATA_DESCRIPTOR = 0x0808;
const ZIP_DEFLATE = 8;
const ZIP_DOS_DATE = 0x0021;
const UINT16_MAX = 0xffff;
const UINT32_MAX = 0xffffffff;

export class PortableReleaseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PortableReleaseError';
  }
}

function canonicalize(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new PortableReleaseError('canonical JSON requires safe integers');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new PortableReleaseError('canonical JSON cannot contain cycles');
    ancestors.add(value);
    try {
      return `[${value.map((entry) => canonicalize(entry, ancestors)).join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new PortableReleaseError('canonical JSON requires plain objects');
  }
  if (ancestors.has(value)) throw new PortableReleaseError('canonical JSON cannot contain cycles');
  ancestors.add(value);
  try {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function sha256File(target) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(target), hash);
  return hash.digest('hex');
}

function assertVersion(value, label) {
  if (typeof value !== 'string' || !SEMVER_PATTERN.test(value)) {
    throw new PortableReleaseError(`${label} must be a strict semantic version`);
  }
}

function splitVersion(value) {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new PortableReleaseError(`${value} is not a strict semantic version`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
}

function comparePrerelease(left, right) {
  if (left.length === 0 && right.length === 0) return 0;
  // 有预发布段的**低于**没有的（SemVer §11）。发布链上的两侧通常都没有，
  // 但缺了这一条会让 `0.0.28-rc.1` 被判成"比 0.0.28 新"。
  if (left.length === 0) return 1;
  if (right.length === 0) return -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/**
 * 与客户端 `portable-manifest.ts` 的 `compareSemanticVersions` 同语义。
 *
 * 为什么发布侧也需要它：`minLauncherVersion` 以前是从 `MOFANG_LAUNCHER_VERSION`
 * 读的（那个变量同时是"启动器自己的版本"），于是每次发版都会把门槛抬到本次版本 ——
 * 而便携更新**从来不换启动器**（`荣盈魔方启动器.exe` 在 FORBIDDEN_NAMES 里，
 * 只能靠人工基础包更换）⇒ 盘上那把永远是上一版，升级必然被
 * `launcher-incompatible` 挡死。拆出独立变量之后，再加这条"门槛不许比本次要发的
 * 启动器还新"的校验，把"填成本次发布版本"这类错误在签包前拦下来。
 */
export function compareSemanticVersions(left, right) {
  const a = splitVersion(left);
  const b = splitVersion(right);
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

function assertSafeRelativePath(relativePath) {
  const segments = relativePath.split('/');
  if (
    relativePath.length === 0 ||
    relativePath.includes('\\') ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new PortableReleaseError(`unsafe portable path: ${relativePath}`);
  }
  for (const segment of segments) {
    const folded = segment.toLowerCase();
    if (FORBIDDEN_NAMES.has(folded)) {
      throw new PortableReleaseError(`forbidden portable directory or file: ${relativePath}`);
    }
    if (segment.endsWith('.') || segment.endsWith(' ') || segment.includes(':')) {
      throw new PortableReleaseError(`unsafe Windows portable path: ${relativePath}`);
    }
    const stem = segment.split('.')[0] ?? '';
    if (DEVICE_PATTERN.test(stem)) {
      throw new PortableReleaseError(`reserved Windows device path: ${relativePath}`);
    }
  }
}

function comparePortablePaths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

async function collectProgramFiles(programDir, readDirectory) {
  const rootInfo = await lstat(programDir).catch(() => null);
  if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new PortableReleaseError('program directory must be a real directory');
  }

  const files = [];
  const collisionKeys = new Set();

  async function walk(directory, prefix) {
    const entries = await readDirectory(directory, { withFileTypes: true });
    entries.sort((left, right) => comparePortablePaths(left.name, right.name));
    for (const entry of entries) {
      const relativePath = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      assertSafeRelativePath(relativePath);
      const target = join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        throw new PortableReleaseError(`symbolic link or reparse point is not allowed: ${relativePath}`);
      }
      if (info.isDirectory()) {
        await walk(target, relativePath);
        continue;
      }
      if (!info.isFile()) {
        throw new PortableReleaseError(`non-regular file is not allowed: ${relativePath}`);
      }
      const collisionKey = relativePath
        .split('/')
        .map((segment) => segment.replace(/[ .]+$/, '').toLowerCase())
        .join('/');
      if (collisionKeys.has(collisionKey)) {
        throw new PortableReleaseError(`portable path collision: ${relativePath}`);
      }
      collisionKeys.add(collisionKey);
      if (!Number.isSafeInteger(info.size)) {
        throw new PortableReleaseError(`file size is not a safe integer: ${relativePath}`);
      }
      files.push({
        path: relativePath,
        size: info.size,
        sha256: await sha256File(target),
      });
    }
  }

  await walk(programDir, '');
  if (files.length === 0) throw new PortableReleaseError('program directory contains no files');
  files.sort((left, right) => comparePortablePaths(left.path, right.path));
  return files;
}

export async function buildPortableFileManifest({ programDir, version, readDirectory = readdir }) {
  assertVersion(version, 'version');
  const files = await collectProgramFiles(programDir, readDirectory);
  const fileManifest = { schemaVersion: 1, version, files };
  const fileManifestBytes = Buffer.from(canonicalize(fileManifest), 'utf8');
  return { fileManifest, fileManifestBytes };
}

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  CRC_TABLE[index] = value >>> 0;
}

function updateCrc32(crc, chunk) {
  let value = crc;
  for (const byte of chunk) value = (value >>> 8) ^ CRC_TABLE[(value ^ byte) & 0xff];
  return value >>> 0;
}

function assertZip32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new PortableReleaseError(`${label} exceeds the ZIP32 limit`);
  }
}

async function writeAt(handle, buffer, position) {
  const result = await handle.write(buffer, 0, buffer.length, position);
  if (result.bytesWritten !== buffer.length) throw new PortableReleaseError('short archive write');
  return position + buffer.length;
}

function localHeader(nameLength) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_UTF8_DATA_DESCRIPTOR, 6);
  header.writeUInt16LE(ZIP_DEFLATE, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(ZIP_DOS_DATE, 12);
  header.writeUInt16LE(nameLength, 26);
  return header;
}

function dataDescriptor(crc32, compressedSize, size) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(crc32, 4);
  descriptor.writeUInt32LE(compressedSize, 8);
  descriptor.writeUInt32LE(size, 12);
  return descriptor;
}

function centralHeader(entry) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((3 << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(ZIP_UTF8_DATA_DESCRIPTOR, 8);
  header.writeUInt16LE(ZIP_DEFLATE, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(ZIP_DOS_DATE, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(entry.localOffset, 42);
  return header;
}

function endOfCentralDirectory(count, centralSize, centralOffset) {
  if (count > UINT16_MAX) throw new PortableReleaseError('archive contains too many files for ZIP32');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return end;
}

export async function createPortableUpdateArchive({ programDir, archivePath, files }) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new PortableReleaseError('file manifest contains no files');
  }
  await mkdir(dirname(archivePath), { recursive: true });
  let handle;
  try {
    handle = await open(archivePath, 'wx');
  } catch (error) {
    if (error?.code === 'EEXIST') throw new PortableReleaseError('refusing to overwrite an existing release artifact');
    throw error;
  }

  let offset = 0;
  const centralEntries = [];
  try {
    for (const file of files) {
      assertSafeRelativePath(file.path);
      const name = Buffer.from(file.path, 'utf8');
      if (name.length > UINT16_MAX) throw new PortableReleaseError(`archive path is too long: ${file.path}`);
      const target = join(programDir, ...file.path.split('/'));
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new PortableReleaseError(`program file changed before archiving: ${file.path}`);
      }
      const localOffset = offset;
      assertZip32(localOffset, 'local header offset');
      offset = await writeAt(handle, localHeader(name.length), offset);
      offset = await writeAt(handle, name, offset);

      let crc = 0xffffffff;
      let size = 0;
      let compressedSize = 0;
      const hash = createHash('sha256');
      const inspect = new Transform({
        transform(chunk, _encoding, callback) {
          crc = updateCrc32(crc, chunk);
          size += chunk.length;
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      const count = new Transform({
        transform(chunk, _encoding, callback) {
          compressedSize += chunk.length;
          callback(null, chunk);
        },
      });
      const destination = createWriteStream(archivePath, {
        fd: handle.fd,
        autoClose: false,
        start: offset,
      });
      await pipeline(createReadStream(target), inspect, createDeflateRaw({ level: 6 }), count, destination);
      if (size !== file.size || hash.digest('hex') !== file.sha256) {
        throw new PortableReleaseError(`program file changed before archiving: ${file.path}`);
      }
      assertZip32(size, 'uncompressed file size');
      assertZip32(compressedSize, 'compressed file size');
      offset += compressedSize;
      const finishedCrc = (crc ^ 0xffffffff) >>> 0;
      offset = await writeAt(handle, dataDescriptor(finishedCrc, compressedSize, size), offset);
      centralEntries.push({
        name,
        crc32: finishedCrc,
        compressedSize,
        size,
        localOffset,
      });
    }

    const centralOffset = offset;
    for (const entry of centralEntries) {
      offset = await writeAt(handle, centralHeader(entry), offset);
      offset = await writeAt(handle, entry.name, offset);
    }
    const centralSize = offset - centralOffset;
    assertZip32(centralOffset, 'central directory offset');
    assertZip32(centralSize, 'central directory size');
    offset = await writeAt(handle, endOfCentralDirectory(centralEntries.length, centralSize, centralOffset), offset);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(archivePath, { force: true });
    throw error;
  }
  await handle.close();

  return {
    packageSize: offset,
    packageSha256: await sha256File(archivePath),
  };
}

function decodePublicKey(encoded) {
  if (typeof encoded !== 'string' || encoded.length === 0) {
    throw new PortableReleaseError('update public key is required');
  }
  let der;
  try {
    der = Buffer.from(encoded, 'base64');
    if (der.toString('base64') !== encoded) throw new Error('non-canonical Base64');
    const key = createPublicKey({ key: der, type: 'spki', format: 'der' });
    if (key.asymmetricKeyType !== 'ed25519') throw new Error('wrong key type');
    return key;
  } catch {
    throw new PortableReleaseError('update public key must be an Ed25519 SPKI Base64 value');
  }
}

function packageUrl(baseUrl, channel, version) {
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new PortableReleaseError('base URL must be a valid HTTPS URL');
  }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new PortableReleaseError('base URL must be an HTTPS URL without credentials, query, or fragment');
  }
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${channel}/${version}/${PORTABLE_PACKAGE_NAME}`;
  return base.toString();
}

export async function buildPortableRelease(input) {
  assertVersion(input.version, 'version');
  assertVersion(input.minLauncherVersion, 'minLauncherVersion');
  if (input.channel !== 'stable' && input.channel !== 'internal') {
    throw new PortableReleaseError('channel must be stable or internal');
  }
  if (typeof input.signingKeyPem !== 'string' && !Buffer.isBuffer(input.signingKeyPem)) {
    throw new PortableReleaseError('private signing key is required');
  }
  if (input.signingKeyPem.length === 0) throw new PortableReleaseError('private signing key is required');

  let privateKey;
  try {
    privateKey = createPrivateKey(input.signingKeyPem);
  } catch {
    throw new PortableReleaseError('private signing key must be an Ed25519 PKCS#8 PEM');
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new PortableReleaseError('private signing key must be Ed25519');
  }
  const publicKey = decodePublicKey(input.publicKeyBase64);
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const configured = publicKey.export({ type: 'spki', format: 'der' });
  if (!Buffer.from(derived).equals(Buffer.from(configured))) {
    throw new PortableReleaseError('configured public key does not match the private signing key');
  }

  const canonicalFileManifest = Buffer.from(canonicalize(input.fileManifest), 'utf8');
  if (
    input.fileManifest.version !== input.version ||
    !Buffer.isBuffer(input.fileManifestBytes) ||
    !canonicalFileManifest.equals(input.fileManifestBytes)
  ) {
    throw new PortableReleaseError('file manifest bytes do not match the release input');
  }
  const packageInfo = await stat(input.packagePath);
  if (!packageInfo.isFile() || !Number.isSafeInteger(packageInfo.size) || packageInfo.size <= 0) {
    throw new PortableReleaseError('portable package must be a non-empty regular file');
  }
  const packageSha256 = await sha256File(input.packagePath);
  const payload = {
    schemaVersion: 1,
    channel: input.channel,
    version: input.version,
    minLauncherVersion: input.minLauncherVersion,
    packageUrl: packageUrl(input.baseUrl, input.channel, input.version),
    packageSize: packageInfo.size,
    packageSha256,
    fileManifestSha256: sha256Bytes(canonicalFileManifest),
    publishedAt: input.publishedAt,
    mandatory: false,
  };
  if (
    typeof input.publishedAt !== 'string' ||
    !Number.isFinite(Date.parse(input.publishedAt)) ||
    new Date(input.publishedAt).toISOString() !== input.publishedAt
  ) {
    throw new PortableReleaseError('publishedAt must be a canonical ISO timestamp');
  }
  const payloadBytes = Buffer.from(canonicalize(payload), 'utf8');
  const signature = sign(null, payloadBytes, privateKey).toString('base64');
  if (!verify(null, payloadBytes, publicKey, Buffer.from(signature, 'base64'))) {
    throw new PortableReleaseError('generated signature did not verify');
  }
  const manifestBytes = Buffer.from(canonicalize({ ...payload, signature }), 'utf8');
  return {
    manifestBytes,
    signature,
    fileManifestBytes: canonicalFileManifest,
    packageSha256,
  };
}

export async function verifyPortableRelease({ manifestBytes, fileManifestBytes, packagePath, publicKeyBase64 }) {
  let manifest;
  let fileManifest;
  try {
    manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));
    fileManifest = JSON.parse(Buffer.from(fileManifestBytes).toString('utf8'));
  } catch {
    throw new PortableReleaseError('release metadata is not valid JSON');
  }
  const { signature, ...payload } = manifest;
  const publicKey = decodePublicKey(publicKeyBase64);
  if (
    typeof signature !== 'string' ||
    !verify(null, Buffer.from(canonicalize(payload), 'utf8'), publicKey, Buffer.from(signature, 'base64'))
  ) {
    throw new PortableReleaseError('release manifest signature is invalid');
  }
  if (sha256Bytes(Buffer.from(canonicalize(fileManifest), 'utf8')) !== manifest.fileManifestSha256) {
    throw new PortableReleaseError('file manifest integrity check failed');
  }
  const packageInfo = await stat(packagePath);
  if (packageInfo.size !== manifest.packageSize || (await sha256File(packagePath)) !== manifest.packageSha256) {
    throw new PortableReleaseError('package integrity check failed');
  }
  return { manifest, fileManifest };
}

export async function writePortableReleaseArtifacts({ outDir, packagePath, manifestBytes, fileManifestBytes }) {
  await mkdir(outDir, { recursive: true });
  const outputInfo = await lstat(outDir);
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) {
    throw new PortableReleaseError('release output must be a real directory');
  }
  if ((await readdir(outDir)).length !== 0) {
    throw new PortableReleaseError('refusing to overwrite an existing release artifact');
  }

  const packagePart = join(outDir, `${PORTABLE_PACKAGE_NAME}.part`);
  const manifestPart = join(outDir, `${PORTABLE_MANIFEST_NAME}.part`);
  const filesPart = join(outDir, `${PORTABLE_FILE_MANIFEST_NAME}.part`);
  try {
    await copyFile(packagePath, packagePart, fsConstants.COPYFILE_EXCL);
    await writeFile(manifestPart, manifestBytes, { flag: 'wx' });
    await writeFile(filesPart, fileManifestBytes, { flag: 'wx' });
    await rename(packagePart, join(outDir, PORTABLE_PACKAGE_NAME));
    await rename(manifestPart, join(outDir, PORTABLE_MANIFEST_NAME));
    await rename(filesPart, join(outDir, PORTABLE_FILE_MANIFEST_NAME));
  } catch (error) {
    await Promise.all([
      rm(packagePart, { force: true }),
      rm(manifestPart, { force: true }),
      rm(filesPart, { force: true }),
    ]);
    throw error;
  }
}

export function assertPathOutsideRepository(target, repositoryRoot) {
  const targetPath = resolve(target);
  const rootPath = resolve(repositoryRoot);
  const relation = relative(rootPath, targetPath);
  if (relation === '' || (!isAbsolute(relation) && !relation.startsWith(`..${sep}`) && relation !== '..')) {
    throw new PortableReleaseError('the private signing key must live outside the repository');
  }
  return targetPath;
}

export async function readSigningKeyFile(target) {
  const info = await lstat(target).catch(() => null);
  if (info === null || !info.isFile() || info.isSymbolicLink()) {
    throw new PortableReleaseError('private signing key file is missing or unsafe');
  }
  return readFile(target, 'utf8');
}
