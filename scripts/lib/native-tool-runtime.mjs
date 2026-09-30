import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact Windows x64 distributions, checked against their publisher's checksums.
export const NATIVE_TOOL_SOURCES = Object.freeze(
  [
    {
      name: 'ffmpeg',
      version: '9.0.2',
      file: 'ffmpeg-9.0.2-essentials_build.7z',
      url: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.7z',
      sha256: '4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077',
    },
    {
      name: 'python',
      version: '3.13.15',
      file: 'python-3.13.15-embed-amd64.zip',
      url: 'https://www.python.org/ftp/python/3.13.15/python-3.13.15-embed-amd64.zip',
      sha256: 'd1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf',
    },
    {
      name: 'debugpy',
      version: '1.8.22',
      file: 'debugpy-1.8.22-cp313-cp313-win_amd64.whl',
      url: 'https://files.pythonhosted.org/packages/d0/f5/c2b3e8260388d7b76bc4e5a3a29648a0ca47dca6a2721d6549ff2d944eee/debugpy-1.8.22-cp313-cp313-win_amd64.whl',
      sha256: 'f49b1d6cecf326b63c06d7f517e4a6642777f758c58cb799e7bc5a6dd74721c2',
    },
  ].map(Object.freeze),
);
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
function walk(root, prefix = '') {
  return fs
    .readdirSync(path.join(root, prefix), { withFileTypes: true })
    .flatMap((entry) => {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Native bundle cannot contain links: ${relative}`);
      return entry.isDirectory() ? walk(root, relative) : [relative];
    })
    .sort();
}

export function verifyNativeToolRuntime(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'native-tools-manifest.json'), 'utf8'));
  if (
    manifest.formatVersion !== 1 ||
    manifest.platform !== 'win32' ||
    manifest.arch !== 'x64' ||
    JSON.stringify(manifest.sources) !== JSON.stringify(NATIVE_TOOL_SOURCES) ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Native bundle manifest contract mismatch');
  const actual = walk(directory).filter((file) => file !== 'native-tools-manifest.json');
  const paths = manifest.files.map((file) => file.path);
  if (
    new Set(paths.map((file) => String(file).toLowerCase())).size !== paths.length ||
    JSON.stringify([...paths].sort()) !== JSON.stringify(actual)
  )
    throw new Error('Native bundle file inventory mismatch');
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(directory, file.path));
    if (bytes.length !== file.size || digest(bytes) !== file.sha256)
      throw new Error(`Native bundle integrity mismatch: ${file.path}`);
  }
  for (const file of [
    'ffmpeg.exe',
    'openclaw.cmd',
    'python.exe',
    'python3.exe',
    'python313._pth',
    'python313.zip',
    'sitecustomize.py',
    '__pycache__/sitecustomize.cpython-313.pyc',
    'LICENSE.txt',
    'licenses/ffmpeg-LICENSE',
    'Lib/debugpy/__init__.py',
    'Lib/debugpy-1.8.22.dist-info/licenses/LICENSE',
  ]) {
    if (!paths.includes(file)) throw new Error(`Native bundle is missing ${file}`);
  }
  return manifest;
}

export function bundleNativeTools(stage, directory) {
  const manifest = verifyNativeToolRuntime(directory);
  const destination = path.join(stage, 'node_modules/openclaw/native-tools');
  if (fs.existsSync(destination)) throw new Error('Native stage destination already exists');
  fs.cpSync(directory, destination, { recursive: true });
  verifyNativeToolRuntime(destination);
  return `rongying-native-tools-${manifest.sources.map((source) => `${source.name}-${source.version}`).join('-')}`;
}

export function assembleNativeTools({ ffmpeg, python, debugpy, output, compileSite }) {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(
    path.join(output, 'openclaw.cmd'),
    '@echo off\r\n"%~dp0..\\..\\..\\node\\node.exe" "%~dp0..\\openclaw.mjs" %*\r\nexit /b %errorlevel%\r\n',
  );
  fs.copyFileSync(path.join(ffmpeg, 'bin/ffmpeg.exe'), path.join(output, 'ffmpeg.exe'));
  fs.mkdirSync(path.join(output, 'licenses'), { recursive: true });
  fs.copyFileSync(path.join(ffmpeg, 'LICENSE'), path.join(output, 'licenses/ffmpeg-LICENSE'));
  fs.cpSync(python, output, { recursive: true });
  fs.copyFileSync(path.join(output, 'python.exe'), path.join(output, 'python3.exe'));
  fs.cpSync(debugpy, path.join(output, 'Lib'), { recursive: true });
  // Embedded Python deliberately isolates module discovery; add only our bundled library.
  const pth = path.join(output, 'python313._pth');
  const lines = fs.readFileSync(pth, 'utf8').split(/\r?\n/);
  const site = path.join(output, 'sitecustomize.py');
  fs.writeFileSync(site, 'import sys\nsys.dont_write_bytecode = True\n');
  // Precompile this startup module before enabling site. Its own import must not
  // create an undeclared cache file, even when Python is invoked with -I.
  const compile =
    compileSite ??
    ((interpreter, module) =>
      execFileSync(
        interpreter,
        [
          '-I',
          '-B',
          '-c',
          'import py_compile,sys; py_compile.compile(sys.argv[1], dfile="sitecustomize.py", invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH, doraise=True)',
          module,
        ],
        { windowsHide: true, timeout: 30000 },
      ));
  compile(path.resolve(output, 'python3.exe'), path.resolve(site));
  fs.writeFileSync(
    pth,
    [...lines.filter((line) => line !== 'Lib' && line !== 'import site'), 'Lib', 'import site', ''].join('\n'),
  );
  for (const required of ['LICENSE.txt', 'Lib/debugpy-1.8.22.dist-info/licenses/LICENSE']) {
    if (!fs.statSync(path.join(output, required)).isFile()) throw new Error(`Missing native license: ${required}`);
  }
  const manifest = {
    formatVersion: 1,
    platform: 'win32',
    arch: 'x64',
    sources: NATIVE_TOOL_SOURCES,
    files: walk(output).map((relative) => {
      const bytes = fs.readFileSync(path.join(output, relative));
      return { path: relative, size: bytes.length, sha256: digest(bytes) };
    }),
  };
  fs.writeFileSync(path.join(output, 'native-tools-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

export function buildNativeToolRuntime({ archives, output, extractor = '7z', extract }) {
  // Verify all archives before any extraction; a partial download never becomes a usable bundle.
  for (const source of NATIVE_TOOL_SOURCES) {
    const archive = path.join(archives, source.file);
    if (!fs.existsSync(archive)) throw new Error(`Missing native archive: ${source.file}`);
    if (digest(fs.readFileSync(archive)) !== source.sha256)
      throw new Error(`Native archive checksum mismatch: ${source.file}`);
  }
  if (fs.existsSync(output)) throw new Error('Native output already exists; choose a fresh output directory');
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), '.native-tools-'));
  try {
    const unpack =
      extract ??
      ((archive, destination) =>
        execFileSync(extractor, ['x', archive, `-o${destination}`, '-y', '-bso0', '-bsp0'], {
          windowsHide: true,
          timeout: 120000,
        }));
    for (const source of NATIVE_TOOL_SOURCES)
      unpack(path.resolve(archives, source.file), path.join(temporary, source.name));
    const built = path.join(temporary, 'built');
    const manifest = assembleNativeTools({
      ffmpeg: path.join(temporary, 'ffmpeg/ffmpeg-9.0.2-essentials_build'),
      python: path.join(temporary, 'python'),
      debugpy: path.join(temporary, 'debugpy'),
      output: built,
    });
    fs.renameSync(built, output);
    return manifest;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

export async function downloadNativeToolArchives(archives) {
  fs.mkdirSync(archives, { recursive: true });
  for (const source of NATIVE_TOOL_SOURCES) {
    const destination = path.join(archives, source.file);
    if (fs.existsSync(destination) && digest(fs.readFileSync(destination)) === source.sha256) continue;
    const response = await fetch(source.url, { redirect: 'follow', signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`Native download failed (${response.status}): ${source.name}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (digest(bytes) !== source.sha256) throw new Error(`Native download checksum mismatch: ${source.name}`);
    fs.writeFileSync(destination, bytes);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2),
    value = (flag) => args[args.indexOf(flag) + 1];
  if (!args.includes('--archives') || !args.includes('--out'))
    throw new Error(
      'Usage: native-tool-runtime.mjs --archives <dir> --out <fresh-dir> [--extractor <7z>] [--download]',
    );
  const archives = path.resolve(value('--archives'));
  if (args.includes('--download')) await downloadNativeToolArchives(archives);
  console.log(
    JSON.stringify(
      buildNativeToolRuntime({
        archives,
        output: path.resolve(value('--out')),
        extractor: args.includes('--extractor') ? value('--extractor') : '7z',
      }),
    ),
  );
}
