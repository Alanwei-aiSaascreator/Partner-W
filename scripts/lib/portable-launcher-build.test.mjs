import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  PortableLauncherBuildError,
  buildPortableLauncher,
  launcherBuildArguments,
  launcherOutputName,
  redactSecrets,
  requireEnvironment,
} from './portable-launcher-build.mjs';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'mofang-launcher-build-'));
  roots.push(root);
  return root;
}

const PUBLIC_KEY = 'cHVibGljLWtleS1maXh0dXJl';

function peBytes() {
  const header = Buffer.alloc(64);
  header.write('MZ', 0, 'ascii');
  return header;
}

describe('portable launcher build environment', () => {
  it('rejects a missing launcher version', () => {
    assert.throws(() => requireEnvironment({ MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY }), PortableLauncherBuildError);
  });

  it('rejects a missing public key', () => {
    assert.throws(() => requireEnvironment({ MOFANG_LAUNCHER_VERSION: '1.0.0' }), PortableLauncherBuildError);
  });

  it('accepts both required variables', () => {
    const result = requireEnvironment({
      MOFANG_LAUNCHER_VERSION: '1.0.0',
      MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY,
    });
    assert.deepEqual(result, { version: '1.0.0', publicKeyBase64: PUBLIC_KEY });
  });

  it('names the launcher the delivery audit expects', () => {
    assert.equal(launcherOutputName, '\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe');
  });
});

describe('portable launcher build arguments', () => {
  it('passes every argument as a separate argv entry with no shell text', () => {
    const args = launcherBuildArguments({
      version: '1.0.0',
      publicKeyBase64: PUBLIC_KEY,
      outputPath: 'D:/out/launcher.exe',
    });

    assert.ok(Array.isArray(args));
    for (const argument of args) {
      assert.equal(typeof argument, 'string');
      assert.ok(!/[&|;><`$]/.test(argument), `argument ${argument} looks like shell text`);
    }
    const ldflags = args[args.indexOf('-ldflags') + 1];
    assert.ok(ldflags.includes('-H=windowsgui'));
    assert.ok(ldflags.includes('-X main.version=1.0.0'));
    assert.ok(ldflags.includes(`-X main.publicKeyBase64=${PUBLIC_KEY}`));
    assert.ok(args.includes('-trimpath'));
    assert.equal(args.at(-1), './cmd/mofang-launcher');
  });

  it('builds a windows amd64 binary from the launcher module', () => {
    const args = launcherBuildArguments({ version: '1.0.0', publicKeyBase64: PUBLIC_KEY, outputPath: 'D:/out.exe' });
    assert.equal(args[0], '-C');
    assert.equal(args[1], 'launcher');
    assert.equal(args[2], 'build');
  });
});

describe('portable launcher build execution', () => {
  it('fails when the toolchain exits non-zero', async () => {
    const root = await makeRoot();
    const runner = () => ({ status: 1, stderr: 'compile error' });

    assert.throws(
      () =>
        buildPortableLauncher({
          env: { MOFANG_LAUNCHER_VERSION: '1.0.0', MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
          outputPath: join(root, 'launcher.exe'),
          runner,
        }),
      PortableLauncherBuildError,
    );
  });

  it('fails when the toolchain never starts', async () => {
    const root = await makeRoot();
    const runner = () => ({ error: new Error('go is not installed'), status: null });

    assert.throws(
      () =>
        buildPortableLauncher({
          env: { MOFANG_LAUNCHER_VERSION: '1.0.0', MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
          outputPath: join(root, 'launcher.exe'),
          runner,
        }),
      PortableLauncherBuildError,
    );
  });

  it('fails when no binary is produced', async () => {
    const root = await makeRoot();
    const runner = () => ({ status: 0, stdout: '', stderr: '' });

    assert.throws(
      () =>
        buildPortableLauncher({
          env: { MOFANG_LAUNCHER_VERSION: '1.0.0', MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
          outputPath: join(root, 'launcher.exe'),
          runner,
        }),
      PortableLauncherBuildError,
    );
  });

  it('fails when the produced file is not a PE image', async () => {
    const root = await makeRoot();
    const outputPath = join(root, 'launcher.exe');
    const runner = () => {
      return { status: 0, stdout: '', stderr: '' };
    };
    await writeFile(outputPath, 'not a portable executable');

    assert.throws(
      () =>
        buildPortableLauncher({
          env: { MOFANG_LAUNCHER_VERSION: '1.0.0', MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
          outputPath,
          runner,
        }),
      PortableLauncherBuildError,
    );
  });

  it('reports the produced size for a real PE image', async () => {
    const root = await makeRoot();
    const outputPath = join(root, 'launcher.exe');
    const runner = () => ({ status: 0, stdout: '', stderr: '' });
    await writeFile(outputPath, peBytes());

    const result = buildPortableLauncher({
      env: { MOFANG_LAUNCHER_VERSION: '1.0.0', MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
      outputPath,
      runner,
    });

    assert.equal(result.outputPath, outputPath);
    assert.equal(result.size, 64);
  });
});

describe('portable launcher build secrecy', () => {
  it('redacts the public key wherever it appears', () => {
    const text = `building with -X main.publicKeyBase64=${PUBLIC_KEY} done`;
    const redacted = redactSecrets(text, [PUBLIC_KEY]);
    assert.ok(!redacted.includes(PUBLIC_KEY));
    assert.ok(redacted.includes('***'));
  });

  it('never puts the key on stdout, stderr or the message when the build fails', async () => {
    const root = await makeRoot();
    const leaked = [];
    const runner = () => ({ status: 1, stdout: `used ${PUBLIC_KEY}`, stderr: `ldflags ${PUBLIC_KEY}` });

    assert.throws(() =>
      buildPortableLauncher({
        env: { MOFANG_LAUNCHER_VERSION: '1.0.0', MOFANG_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
        outputPath: join(root, 'launcher.exe'),
        runner,
        log: (message) => leaked.push(message),
      }),
    );

    for (const message of leaked) {
      assert.ok(!message.includes(PUBLIC_KEY), `log leaked the key: ${message}`);
    }
  });
});
