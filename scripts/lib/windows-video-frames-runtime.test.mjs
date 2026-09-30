import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('Windows skill requires Node and ffmpeg and invokes its bundled CLI without Bash', async () => {
  const { patchWindowsVideoFramesSkill } = await import('./windows-video-frames-runtime.mjs');
  const source =
    'requires: { "bins": ["ffmpeg"] }\ninstall: { "bins": ["ffmpeg"] }\n```bash\n{baseDir}/scripts/frame.sh input.mp4 --out frame.jpg\n```\n';
  const patched = patchWindowsVideoFramesSkill(source, createHash('sha256').update(source).digest('hex'));
  assert.ok(patched.includes('["node", "ffmpeg"]'));
  assert.ok(patched.includes('node "{baseDir}/scripts/frame.mjs"'));
  assert.ok(!patched.includes('frame.sh'));
  assert.throws(() => patchWindowsVideoFramesSkill(source + 'drift'), /hash/);
});

test('frame extraction preserves paths with spaces, rejects unsafe frame arguments, and propagates ffmpeg failure', async (t) => {
  const { extractFrame } = await import('./video-frame-cli.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = path.join(root, 'input clip.mp4'),
    output = path.join(root, 'output folder/frame.png');
  fs.writeFileSync(input, 'local synthetic fixture');
  let called = false;
  assert.throws(
    () =>
      extractFrame([input, '--index', '0),movie=private', '--out', output], () => {
        called = true;
      }),
    /index/,
  );
  assert.equal(called, false);
  assert.throws(
    () =>
      extractFrame([input, '--out', output], (bin, args, options) => {
        assert.equal(bin, 'ffmpeg');
        assert.ok(args.includes(input));
        assert.equal(path.dirname(args.at(-1)), path.dirname(output));
        assert.equal(path.extname(args.at(-1)), '.png');
        assert.equal(options.shell, false);
        assert.equal(options.windowsHide, true);
        return { status: 1, stderr: 'decoder failed' };
      }),
    /decoder failed/,
  );
  assert.throws(() => extractFrame([input, '--out', output], () => ({ status: 0 })), /did not produce/);
  assert.equal(
    extractFrame([input, '--time', '00:00:01.5', '--out', output], (_, args) => {
      assert.deepEqual(args.slice(4, 8), ['-ss', '00:00:01.5', '-i', input]);
      fs.writeFileSync(args.at(-1), 'verified frame');
      return { status: 0 };
    }),
    output,
  );
});
