import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Native tools become PATH-visible only after verifying the complete shipped inventory. */
export function resolveBundledNativeTools(deployedRoot: string): string | undefined {
  const directory = path.join(deployedRoot, 'node_modules/openclaw/native-tools');
  if (!fs.existsSync(directory)) {
    const cached = path.join(deployedRoot, 'manifest.json');
    if (fs.existsSync(cached)) {
      const runtime = JSON.parse(fs.readFileSync(cached, 'utf8')) as { runtimes?: { patches?: unknown[] }[] };
      if (
        runtime.runtimes?.some((variant) =>
          variant.patches?.some((patch) => typeof patch === 'string' && patch.startsWith('partner-w-native-tools-')),
        )
      )
        throw new Error('Required native tools bundle is missing');
    }
    return undefined;
  }
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Native tools bundle path cannot be a link');
  const manifestFile = path.join(directory, 'native-tools-manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error('Native tools manifest is missing');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>;
  if (
    manifest.formatVersion !== 1 ||
    manifest.platform !== 'win32' ||
    manifest.arch !== 'x64' ||
    !Array.isArray(manifest.files)
  )
    throw new Error('Native tools manifest contract is invalid');
  const files = new Map<string, { path: string; size: number; sha256: string }>();
  for (const file of manifest.files as Record<string, unknown>[]) {
    if (
      !file ||
      typeof file.path !== 'string' ||
      file.path.startsWith('/') ||
      /[\\:\0]/.test(file.path) ||
      file.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
    )
      throw new Error('Native tools manifest path is invalid');
    const key = file.path.toLowerCase();
    if (files.has(key)) throw new Error('Native tools manifest contains duplicate paths');
    if (
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('Native tools manifest integrity fields are invalid');
    files.set(key, file as { path: string; size: number; sha256: string });
  }
  for (const required of [
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
    if (!files.has(required.toLowerCase())) throw new Error(`Native tools manifest is incomplete: ${required}`);
  }
  const realDirectory = fs.realpathSync(directory);
  const actual: string[] = [];
  const enumerate = (prefix = ''): void => {
    for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true })) {
      const relative = path.posix.join(prefix, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Native tools inventory cannot contain links');
      if (entry.isDirectory()) enumerate(relative);
      else if (relative !== 'native-tools-manifest.json') actual.push(relative);
    }
  };
  enumerate();
  if (JSON.stringify(actual.sort()) !== JSON.stringify([...files.values()].map((file) => file.path).sort()))
    throw new Error('Native tools file inventory mismatch');
  for (const file of files.values()) {
    const full = path.join(directory, file.path);
    const relative = path.relative(realDirectory, fs.realpathSync(full));
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(full).isFile())
      throw new Error('Native tools file path escapes its bundle');
    const bytes = fs.readFileSync(full);
    if (bytes.length !== file.size || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
      throw new Error(`Native tools integrity check failed: ${file.path}`);
  }
  return directory;
}
