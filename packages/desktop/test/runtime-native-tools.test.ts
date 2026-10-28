import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBundledNativeTools } from '../src/main/runtime/native-tools.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tools-test-'));
  roots.push(root);
  const native = path.join(root, 'node_modules/openclaw/native-tools');
  fs.mkdirSync(native, { recursive: true });
  const paths = [
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
  ];
  const files = paths.map((relative) => {
    const bytes = Buffer.from(relative);
    const full = path.join(native, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
    return { path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const manifest = { formatVersion: 1, platform: 'win32', arch: 'x64', files };
  const save = () => fs.writeFileSync(path.join(native, 'native-tools-manifest.json'), JSON.stringify(manifest));
  save();
  return { root, native, manifest, save };
}
describe('bundled native tool eligibility', () => {
  it('rejects a directory junction even when its module bytes match the declared inventory', () => {
    const f = fixture(),
      external = path.join(f.root, 'external-lib');
    fs.renameSync(path.join(f.native, 'Lib'), external);
    fs.symlinkSync(external, path.join(f.native, 'Lib'), 'junction');
    expect(() => resolveBundledNativeTools(f.root)).toThrow(/link/);
  });
  it('rejects undeclared interpreter configuration and arbitrary extra modules', () => {
    for (const relative of ['python3._pth', 'Lib/unlisted.py']) {
      const f = fixture();
      fs.writeFileSync(path.join(f.native, relative), 'unverified');
      expect(() => resolveBundledNativeTools(f.root)).toThrow(/inventory/);
    }
  });
  it('requires native dependencies when the cached runtime declares the native patch', () => {
    const f = fixture();
    fs.rmSync(f.native, { recursive: true });
    fs.writeFileSync(
      path.join(f.root, 'manifest.json'),
      JSON.stringify({
        runtimes: [
          {
            platform: 'win32',
            arch: 'x64',
            patches: ['partner-w-native-tools-ffmpeg-9.0.2-python-3.13.15-debugpy-1.8.22'],
          },
        ],
      }),
    );
    expect(() => resolveBundledNativeTools(f.root)).toThrow(/required/i);
  });
  it('does not advertise legacy missing tools and rejects incomplete native bundles', () => {
    const f = fixture();
    fs.rmSync(f.native, { recursive: true });
    expect(resolveBundledNativeTools(f.root)).toBeUndefined();
    fs.mkdirSync(f.native);
    expect(() => resolveBundledNativeTools(f.root)).toThrow(/manifest/);
  });
  it('requires every declared file hash and the actual interpreter, decoder and license payloads', () => {
    const f = fixture();
    expect(resolveBundledNativeTools(f.root)).toBe(f.native);
    fs.writeFileSync(path.join(f.native, 'ffmpeg.exe'), 'modified');
    expect(() => resolveBundledNativeTools(f.root)).toThrow(/integrity/);
    const g = fixture();
    g.manifest.files = g.manifest.files.filter((file) => file.path !== 'python3.exe');
    g.save();
    expect(() => resolveBundledNativeTools(g.root)).toThrow(/python3/);
  });
  it('rejects escaping paths and duplicate Windows paths before making tools eligible', () => {
    const f = fixture();
    f.manifest.files[0].path = '../outside.exe';
    f.save();
    expect(() => resolveBundledNativeTools(f.root)).toThrow(/path/);
    const g = fixture();
    g.manifest.files.push({ ...g.manifest.files[0], path: 'FFMPEG.EXE' });
    g.save();
    expect(() => resolveBundledNativeTools(g.root)).toThrow(/duplicate/i);
  });
});
