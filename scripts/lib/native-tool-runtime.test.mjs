import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('refuses missing or modified pinned archives before extraction or publishing native tools', async (t) => {
  const { buildNativeToolRuntime, NATIVE_TOOL_SOURCES } = await import('./native-tool-runtime.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'published');
  let extracted = false;
  assert.throws(
    () =>
      buildNativeToolRuntime({
        archives: dir,
        output: out,
        extract: () => {
          extracted = true;
        },
      }),
    /missing/i,
  );
  for (const source of NATIVE_TOOL_SOURCES) fs.writeFileSync(path.join(dir, source.file), 'partial download');
  assert.throws(
    () =>
      buildNativeToolRuntime({
        archives: dir,
        output: out,
        extract: () => {
          extracted = true;
        },
      }),
    /checksum/i,
  );
  assert.equal(extracted, false);
  assert.equal(fs.existsSync(out), false);
});

test('assembled runtime retains licenses, aliases Python3, and records every shipped file for integrity checks', async (t) => {
  const { assembleNativeTools, verifyNativeToolRuntime, bundleNativeTools } = await import('./native-tool-runtime.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const roots = Object.fromEntries(['ffmpeg', 'python', 'debugpy'].map((name) => [name, path.join(dir, name)]));
  const fixtures = {
    ffmpeg: { 'bin/ffmpeg.exe': 'FFmpeg', 'bin/ffprobe.exe': 'FFprobe', LICENSE: 'GPLv3' },
    python: {
      'python.exe': 'Python',
      'python313._pth': 'python313.zip\n.\n#import site\n',
      'python313.zip': 'stdlib',
      'LICENSE.txt': 'PSF',
    },
    debugpy: { 'debugpy/__init__.py': 'version', 'debugpy-1.8.22.dist-info/licenses/LICENSE': 'MIT' },
  };
  for (const [name, files] of Object.entries(fixtures))
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(roots[name], file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
  const output = path.join(dir, 'output');
  const manifest = assembleNativeTools({
    ...roots,
    output,
    compileSite: (_, module) => {
      assert.ok(fs.readFileSync(module, 'utf8').includes('sys.dont_write_bytecode = True'));
      const cache = path.join(output, '__pycache__/sitecustomize.cpython-313.pyc');
      fs.mkdirSync(path.dirname(cache));
      fs.writeFileSync(cache, 'precompiled startup');
    },
  });
  assert.equal(fs.readFileSync(path.join(output, 'python3.exe'), 'utf8'), 'Python');
  assert.ok(fs.readFileSync(path.join(output, 'python313._pth'), 'utf8').split('\n').includes('Lib'));
  assert.ok(manifest.files.some((file) => file.path === 'licenses/ffmpeg-LICENSE'));
  assert.ok(manifest.files.some((file) => file.path === 'LICENSE.txt'));
  assert.ok(manifest.files.some((file) => file.path === 'Lib/debugpy-1.8.22.dist-info/licenses/LICENSE'));
  assert.equal(manifest.files.length, 12);
  assert.equal(fs.readFileSync(path.join(output, 'ffmpeg.exe'), 'utf8'), 'FFmpeg');
  assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'native-tools-manifest.json'))).formatVersion, 1);
  assert.equal(verifyNativeToolRuntime(output).files.length, 12);
  assert.ok(
    fs
      .readFileSync(path.join(output, 'openclaw.cmd'), 'utf8')
      .includes('"%~dp0..\\..\\..\\node\\node.exe" "%~dp0..\\openclaw.mjs"'),
  );
  const stage = path.join(dir, 'stage');
  bundleNativeTools(stage, output);
  assert.equal(verifyNativeToolRuntime(path.join(stage, 'node_modules/openclaw/native-tools')).files.length, 12);
  fs.writeFileSync(path.join(output, 'ffmpeg.exe'), 'tampered');
  assert.throws(() => verifyNativeToolRuntime(output), /integrity/);
  fs.writeFileSync(path.join(output, 'unexpected.exe'), 'undeclared');
  assert.throws(() => verifyNativeToolRuntime(output), /inventory/);
});
