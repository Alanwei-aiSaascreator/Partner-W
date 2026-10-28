import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  PortableLauncherBuildError,
  buildPortableLauncher as buildLauncher,
  launcherBuildArguments,
  launcherOutputName,
  redactSecrets,
  requireEnvironment,
} from './portable-launcher-build.mjs';
import { verifyExecutableIcon } from './pe-icon.mjs';

function buildPortableLauncher(options) {
  return buildLauncher({ resourceEditorResolver: async () => 'rcedit', ...options });
}

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), 'partner-w-launcher-build-'));
  roots.push(root);
  return root;
}

const PUBLIC_KEY = 'cHVibGljLWtleS1maXh0dXJl';
const iconPath = new URL('../../packages/desktop/build/icon.ico', import.meta.url);

function iconPeBytes() {
  const ico = readFileSync(iconPath);
  const count = ico.readUInt16LE(4);
  const group = Buffer.alloc(6 + count * 14);
  ico.copy(group, 0, 0, 6);
  const icons = [];
  for (let i = 0; i < count; i += 1) {
    const entry = 6 + i * 16;
    ico.copy(group, 6 + i * 14, entry, entry + 12);
    group.writeUInt16LE(i + 1, 6 + i * 14 + 12);
    const size = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    icons.push(ico.subarray(offset, offset + size));
  }
  const resources = Buffer.alloc(ico.length + 4096);
  let cursor = 0;
  function directory(entries) {
    const offset = cursor;
    cursor += 16 + entries.length * 8;
    resources.writeUInt16LE(entries.length, offset + 14);
    entries.forEach(([id, value], i) => {
      const at = offset + 16 + i * 8;
      resources.writeUInt32LE(id, at);
      if (Array.isArray(value)) resources.writeUInt32LE((directory(value) | 0x80000000) >>> 0, at + 4);
      else {
        const dataEntry = cursor;
        cursor += 16;
        resources.writeUInt32LE(dataEntry, at + 4);
        resources.writeUInt32LE(0x1000 + cursor, dataEntry);
        resources.writeUInt32LE(value.length, dataEntry + 4);
        value.copy(resources, cursor);
        cursor += value.length;
      }
    });
    return offset;
  }
  directory([
    [3, icons.map((bytes, index) => [index + 1, [[1033, bytes]]])],
    [14, [[1, [[1033, group]]]]],
  ]);
  const pe = Buffer.alloc(0x200 + cursor);
  pe.write('MZ');
  pe.writeUInt32LE(0x80, 0x3c);
  pe.write('PE\0\0', 0x80);
  pe.writeUInt16LE(1, 0x86);
  pe.writeUInt16LE(240, 0x94);
  pe.writeUInt16LE(0x20b, 0x98);
  pe.writeUInt32LE(0x1000, 0x98 + 112 + 16);
  pe.writeUInt32LE(cursor, 0x98 + 112 + 20);
  const section = 0x98 + 240;
  pe.writeUInt32LE(cursor, section + 8);
  pe.writeUInt32LE(0x1000, section + 12);
  pe.writeUInt32LE(cursor, section + 16);
  pe.writeUInt32LE(0x200, section + 20);
  resources.copy(pe, 0x200, 0, cursor);
  return pe;
}

function peBytes() {
  const header = Buffer.alloc(64);
  header.write('MZ', 0, 'ascii');
  return header;
}

describe('portable launcher build environment', () => {
  it('rejects a missing launcher version', () => {
    assert.throws(() => requireEnvironment({ PARTNERW_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY }), PortableLauncherBuildError);
  });

  it('rejects a missing public key', () => {
    assert.throws(() => requireEnvironment({ PARTNERW_LAUNCHER_VERSION: '1.0.0' }), PortableLauncherBuildError);
  });

  it('accepts both required variables', () => {
    const result = requireEnvironment({
      PARTNERW_LAUNCHER_VERSION: '1.0.0',
      PARTNERW_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY,
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
    assert.equal(args.at(-1), './cmd/partner-w-launcher');
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

    await assert.rejects(
      async () =>
        buildPortableLauncher({
          env: { PARTNERW_LAUNCHER_VERSION: '1.0.0', PARTNERW_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
          outputPath: join(root, 'launcher.exe'),
          runner,
        }),
      PortableLauncherBuildError,
    );
  });

  it('fails when the toolchain never starts', async () => {
    const root = await makeRoot();
    const runner = () => ({ error: new Error('go is not installed'), status: null });

    await assert.rejects(
      async () =>
        buildPortableLauncher({
          env: { PARTNERW_LAUNCHER_VERSION: '1.0.0', PARTNERW_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
          outputPath: join(root, 'launcher.exe'),
          runner,
        }),
      PortableLauncherBuildError,
    );
  });

  it('fails when no binary is produced', async () => {
    const root = await makeRoot();
    const runner = () => ({ status: 0, stdout: '', stderr: '' });

    await assert.rejects(
      async () =>
        buildPortableLauncher({
          env: { PARTNERW_LAUNCHER_VERSION: '1.0.0', PARTNERW_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
          outputPath: join(root, 'launcher.exe'),
          runner,
        }),
      PortableLauncherBuildError,
    );
  });

  it('fails when the produced file is not a PE image', async () => {
    const root = await makeRoot();
    const outputPath = join(root, 'launcher.exe');
    const runner = (_binary, args) => {
      writeFileSync(args[args.indexOf('-o') + 1], 'not a portable executable');
      return { status: 0, stdout: '', stderr: '' };
    };
    await writeFile(outputPath, 'not a portable executable');

    await assert.rejects(
      async () =>
        buildPortableLauncher({
          env: { PARTNERW_LAUNCHER_VERSION: '1.0.0', PARTNERW_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
          outputPath,
          runner,
        }),
      PortableLauncherBuildError,
    );
  });

  it('reports the produced size for a real PE image', async () => {
    const root = await makeRoot();
    const outputPath = join(root, 'launcher.exe');
    const runner = (binary, args) => {
      writeFileSync(binary === 'go' ? args[args.indexOf('-o') + 1] : args[0], iconPeBytes());
      return { status: 0, stdout: '', stderr: '' };
    };

    const result = await buildPortableLauncher({
      env: { PARTNERW_LAUNCHER_VERSION: '1.0.0', PARTNERW_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
      outputPath,
      runner,
    });

    assert.equal(result.outputPath, outputPath);
    assert.equal(result.size, iconPeBytes().length);
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

    await assert.rejects(async () =>
      buildPortableLauncher({
        env: { PARTNERW_LAUNCHER_VERSION: '1.0.0', PARTNERW_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY },
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

describe('portable launcher icon publication', () => {
  const env = { PARTNERW_LAUNCHER_VERSION: '1.0.5', PARTNERW_UPDATE_PUBLIC_KEY_B64: PUBLIC_KEY };

  it('fails closed when the resource tool is unavailable and preserves the existing artifact', async () => {
    const root = await makeRoot();
    const outputPath = join(root, 'launcher.exe');
    await writeFile(outputPath, peBytes());
    await assert.rejects(
      async () =>
        buildPortableLauncher({
          env,
          outputPath,
          runner: () => ({ status: 0 }),
          resourceEditorResolver: async () => {
            throw new Error('resource tool unavailable');
          },
        }),
      /resource tool unavailable/,
    );
    assert.deepEqual(readFileSync(outputPath), peBytes());
  });

  it('rejects a resource editor that succeeds without embedding the icon', async () => {
    const root = await makeRoot();
    const outputPath = join(root, 'launcher.exe');
    await assert.rejects(
      async () =>
        buildPortableLauncher({
          env,
          outputPath,
          resourceEditorResolver: async () => 'rcedit',
          runner: (binary, args) => {
            if (binary === 'go') writeFileSync(args[args.indexOf('-o') + 1], peBytes());
            return { status: 0 };
          },
        }),
      /icon|PE/i,
    );
  });

  it('keeps the prior artifact when resource editing fails', async () => {
    const root = await makeRoot();
    const outputPath = join(root, 'launcher.exe');
    const previous = Buffer.from('prior verified launcher');
    await writeFile(outputPath, previous);
    await assert.rejects(
      async () =>
        buildPortableLauncher({
          env,
          outputPath,
          runner: (binary, args) => {
            if (binary === 'go') writeFileSync(args[args.indexOf('-o') + 1], peBytes());
            return { status: binary === 'go' ? 0 : 1 };
          },
        }),
      /resource editor exited/,
    );
    assert.deepEqual(readFileSync(outputPath), previous);
  });

  it('embeds and verifies all source icon images before publishing the new executable', async () => {
    const root = await makeRoot();
    const outputPath = join(root, 'launcher.exe');
    const previous = Buffer.from('previous artifact');
    await writeFile(outputPath, previous);
    const calls = [];
    const result = await buildPortableLauncher({
      env,
      outputPath,
      resourceEditorResolver: async () => 'rcedit',
      runner: (binary, args) => {
        calls.push(binary);
        assert.deepEqual(readFileSync(outputPath), previous);
        if (binary === 'go') writeFileSync(args[args.indexOf('-o') + 1], peBytes());
        else {
          assert.equal(args[1], '--set-icon');
          assert.deepEqual(readFileSync(args[2]), readFileSync(iconPath));
          writeFileSync(args[0], iconPeBytes());
        }
        return { status: 0 };
      },
    });
    assert.deepEqual(calls, ['go', 'rcedit']);
    assert.equal(result.iconImages, 7);
    assert.deepEqual(readFileSync(outputPath), iconPeBytes());
  });
});

describe('PE icon verification', () => {
  it('compares the actual resource payloads with the source ICO', () => {
    const ico = readFileSync(iconPath);
    const executable = iconPeBytes();
    assert.deepEqual(verifyExecutableIcon(executable, ico), { imageCount: 7, groupCount: 1 });
    const pixels = ico.subarray(ico.readUInt32LE(18), ico.readUInt32LE(18) + ico.readUInt32LE(14));
    const offset = executable.indexOf(pixels);
    assert.ok(offset > 0);
    executable[offset] ^= 1;
    assert.throws(() => verifyExecutableIcon(executable, ico), /does not match/);
  });

  it('rejects a truncated PE and a malformed source ICO', () => {
    const ico = readFileSync(iconPath);
    assert.throws(() => verifyExecutableIcon(iconPeBytes().subarray(0, 64), ico), /outside the file/);
    assert.throws(() => verifyExecutableIcon(iconPeBytes(), Buffer.alloc(6)), /ICO/);
  });

  it('rejects an icon group that points to a missing resource', () => {
    const ico = readFileSync(iconPath);
    const executable = iconPeBytes();
    executable.writeUInt16LE(9000, executable.length - 2);
    assert.throws(() => verifyExecutableIcon(executable, ico), /does not match/);
  });
});
