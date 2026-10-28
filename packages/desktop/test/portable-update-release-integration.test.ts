import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePortableFileManifest } from '@clawwork/shared';
import { extractPortablePackage, verifyPortableProgramTree } from '../src/main/update/portable-package.js';

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('portable release tooling integration', () => {
  it('builds an archive accepted by the Electron extractor and exact-tree verifier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'partner-w-release-integration-'));
    roots.push(root);
    const programDir = join(root, 'program');
    const files = new Map([
      ['\u8363\u76c8\u9b54\u65b9.exe', 'desktop'],
      ['resources/app.asar', 'asar'],
      ['resources/runtime/openclaw-runtime-manifest.json', '{}'],
    ]);
    for (const [relativePath, content] of files) {
      const target = join(programDir, ...relativePath.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const keyFile = join(root, 'signing-key.pem');
    await writeFile(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const outDir = join(root, 'release');
    const result = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, 'scripts', 'make-portable-update.mjs'),
        '--program-dir',
        programDir,
        '--version',
        '0.0.26',
        '--channel',
        'internal',
        '--base-url',
        'https://updates.example.com',
        '--out',
        outDir,
      ],
      {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          PARTNERW_UPDATE_SIGNING_KEY_FILE: keyFile,
          PARTNERW_UPDATE_PUBLIC_KEY_B64: publicKeyBase64,
          PARTNERW_LAUNCHER_VERSION: '1.0.0',
          PARTNERW_MIN_LAUNCHER_VERSION: '1.0.0',
        },
      },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

    const fileManifest = parsePortableFileManifest(
      JSON.parse(await readFile(join(outDir, 'portable-files.json'), 'utf8')),
    );
    const extracted = await extractPortablePackage({
      archivePath: join(outDir, 'portable.zip'),
      temporaryRoot: join(root, 'staged'),
      fileManifest,
      // 这条用例关心的是"签名包能被真解压并逐文件验过"，不是空间门禁：
      // 给一个肯定放得下的预算（空间行为有它自己的按名测试，见 portable-update-package.test.ts）。
      requiredFreeBytes: 1,
    });
    await expect(
      verifyPortableProgramTree({ programRoot: extracted.programRoot, fileManifest }),
    ).resolves.toBeUndefined();
    await expect(readFile(join(extracted.programRoot, 'resources', 'app.asar'), 'utf8')).resolves.toBe('asar');
  });
});
