import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  CHANNELS,
  FeedPublishError,
  PUBLIC_BASE_URL,
  STATE_ROOT,
  UPDATE_ROOT,
  assertKnownHostsPath,
  parsePublishInput,
  verifyLocalArtifacts,
} from './feed-publish.mjs';

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'mofang-feed-'));
  roots.push(root);
  return root;
}

const keyPair = generateKeyPairSync('ed25519');
const PUBLIC_KEY_BASE64 = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

const PACKAGE_BYTES = Buffer.from('portable-zip-bytes', 'utf8');
const PACKAGE_SHA256 = createHash('sha256').update(PACKAGE_BYTES).digest('hex');

const FILE_MANIFEST = {
  schemaVersion: 1,
  version: '1.2.3',
  files: [{ path: 'a.txt', size: 1, sha256: 'a'.repeat(64) }],
};
const FILE_MANIFEST_BYTES = Buffer.from(JSON.stringify(FILE_MANIFEST), 'utf8');
const FILE_MANIFEST_SHA256 = createHash('sha256').update(FILE_MANIFEST_BYTES).digest('hex');

function signedManifest(overrides = {}) {
  const payload = {
    schemaVersion: 1,
    channel: 'internal',
    version: '1.2.3',
    minLauncherVersion: '1.0.0',
    packageUrl: `${PUBLIC_BASE_URL}/internal/1.2.3/portable.zip`,
    packageSize: PACKAGE_BYTES.length,
    packageSha256: PACKAGE_SHA256,
    fileManifestSha256: FILE_MANIFEST_SHA256,
    publishedAt: '2026-09-22T00:00:00.000Z',
    mandatory: false,
    ...overrides,
  };
  const canonical = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(canonical, 'utf8'), keyPair.privateKey).toString('base64');
  return Buffer.from(JSON.stringify({ ...payload, signature }), 'utf8');
}

function writeArtifacts(overrides = {}) {
  const root = makeRoot();
  const paths = {
    packagePath: join(root, 'portable.zip'),
    fileManifestPath: join(root, 'portable-files.json'),
    manifestPath: join(root, 'manifest.json'),
  };
  writeFileSync(paths.packagePath, overrides.packageBytes ?? PACKAGE_BYTES);
  writeFileSync(paths.fileManifestPath, overrides.fileManifestBytes ?? FILE_MANIFEST_BYTES);
  writeFileSync(paths.manifestPath, overrides.manifestBytes ?? signedManifest(overrides.manifestOverrides));
  return paths;
}

test('the roots and the channel whitelist are fixed constants', () => {
  assert.equal(UPDATE_ROOT, '/opt/rongying/updates');
  assert.equal(STATE_ROOT, '/opt/rongying/updates-state');
  assert.deepEqual([...CHANNELS], ['internal', 'stable']);
  assert.equal(PUBLIC_BASE_URL, 'https://api.rongyinghudong.com/updates');
});

test('the input rejects any channel outside the whitelist', () => {
  assert.throws(
    () => parsePublishInput({ channel: 'beta', version: '1.2.3', host: 'h', knownHostsPath: 'k' }),
    FeedPublishError,
  );
});

test('the input rejects an unstrict version', () => {
  for (const version of ['1.2', 'v1.2.3', '01.2.3', 'dev']) {
    assert.throws(
      () => parsePublishInput({ channel: 'internal', version, host: 'h', knownHostsPath: 'k' }),
      FeedPublishError,
    );
  }
});

test('the input rejects a missing host or known hosts path when the mode needs the network', () => {
  assert.throws(
    () =>
      parsePublishInput({ channel: 'internal', version: '1.2.3', host: '', knownHostsPath: 'k', needsNetwork: true }),
    FeedPublishError,
  );
  assert.throws(
    () =>
      parsePublishInput({ channel: 'internal', version: '1.2.3', host: 'h', knownHostsPath: '', needsNetwork: true }),
    FeedPublishError,
  );
});

test('the offline input does not require a host or known hosts path', () => {
  const input = parsePublishInput({
    channel: 'internal',
    version: '1.2.3',
    host: '',
    knownHostsPath: '',
    needsNetwork: false,
  });
  assert.equal(input.channel, 'internal');
  assert.equal(input.host, null);
  assert.equal(input.knownHostsPath, null);
});

test('a host that ssh would read as an option is rejected', () => {
  assert.throws(
    () =>
      parsePublishInput({
        channel: 'internal',
        version: '1.2.3',
        needsNetwork: true,
        host: '-oProxyCommand=x',
        knownHostsPath: '/tmp/known_hosts',
      }),
    /must not start with a dash/u,
  );
});

test('a host containing whitespace is rejected', () => {
  assert.throws(
    () =>
      parsePublishInput({
        channel: 'internal',
        version: '1.2.3',
        needsNetwork: true,
        host: 'bad host',
        knownHostsPath: '/tmp/known_hosts',
      }),
    /contain whitespace/u,
  );
});

test('the known hosts file must live outside the repository', () => {
  assert.throws(() => assertKnownHostsPath(join(process.cwd(), 'known_hosts'), process.cwd()), FeedPublishError);
  assert.equal(assertKnownHostsPath(join(tmpdir(), 'known_hosts'), process.cwd()), join(tmpdir(), 'known_hosts'));
});

test('the local verification returns every digest and size the flow needs', async () => {
  const paths = writeArtifacts();
  const result = await verifyLocalArtifacts({
    ...paths,
    expectedChannel: 'internal',
    expectedVersion: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
  });
  assert.equal(result.packageSha256, PACKAGE_SHA256);
  assert.equal(result.packageSize, PACKAGE_BYTES.length);
  assert.equal(result.fileManifestSha256, FILE_MANIFEST_SHA256);
  assert.equal(result.fileManifestSize, FILE_MANIFEST_BYTES.length);
  assert.equal(result.manifestSha256, createHash('sha256').update(result.manifestBytes).digest('hex'));
  assert.equal(result.packageUrl, `${PUBLIC_BASE_URL}/internal/1.2.3/portable.zip`);
});

test('the local verification requires the channel and the version explicitly', async () => {
  const withoutChannel = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({ ...withoutChannel, expectedVersion: '1.2.3', publicKeyBase64: PUBLIC_KEY_BASE64 }),
    /expectedChannel/u,
  );
  const withoutVersion = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({ ...withoutVersion, expectedChannel: 'internal', publicKeyBase64: PUBLIC_KEY_BASE64 }),
    /expectedVersion/u,
  );
});

test('the local verification rejects a package whose bytes do not match the manifest', async () => {
  const paths = writeArtifacts({ packageBytes: Buffer.from('tampered', 'utf8') });
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /package integrity/u,
  );
});

test('the local verification rejects a file manifest whose bytes do not match the manifest', async () => {
  const paths = writeArtifacts({ fileManifestBytes: Buffer.from('[]', 'utf8') });
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /file manifest/u,
  );
});

test('the local verification rejects a manifest for another channel or version', async () => {
  const otherChannel = writeArtifacts({
    manifestOverrides: {
      channel: 'stable',
      packageUrl: `${PUBLIC_BASE_URL}/stable/1.2.3/portable.zip`,
    },
  });
  await assert.rejects(
    verifyLocalArtifacts({
      ...otherChannel,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /channel/u,
  );
  const otherVersion = writeArtifacts({
    manifestOverrides: {
      version: '1.2.4',
      packageUrl: `${PUBLIC_BASE_URL}/internal/1.2.4/portable.zip`,
    },
  });
  await assert.rejects(
    verifyLocalArtifacts({
      ...otherVersion,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /version/u,
  );
});

test('the local verification rejects a package url that leaves the fixed public origin', async () => {
  for (const url of [
    'https://evil.example.invalid/updates/internal/1.2.3/portable.zip',
    'https://user:pass@api.rongyinghudong.com/updates/internal/1.2.3/portable.zip',
    'https://api.rongyinghudong.com/updates/internal/1.2.3/portable.zip?x=1',
    'https://api.rongyinghudong.com/updates/internal/1.2.3/portable.zip#frag',
    'http://api.rongyinghudong.com/updates/internal/1.2.3/portable.zip',
  ]) {
    const paths = writeArtifacts({ manifestOverrides: { packageUrl: url } });
    await assert.rejects(
      verifyLocalArtifacts({
        ...paths,
        expectedChannel: 'internal',
        expectedVersion: '1.2.3',
        publicKeyBase64: PUBLIC_KEY_BASE64,
      }),
      /package url/u,
      `expected ${url} to be rejected`,
    );
  }
});

test('a throwing signature verifier fails the local verification instead of returning', async () => {
  const paths = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
      verifySignature: () => {
        throw new Error('release manifest signature is invalid');
      },
    }),
    /signature is invalid/u,
  );
});

test('a missing public key is a hard failure rather than a skipped signature check', async () => {
  const paths = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({ ...paths, expectedChannel: 'internal', expectedVersion: '1.2.3', publicKeyBase64: '' }),
    /public key/u,
  );
});

test('the local verification propagates an async verifier rejection', async () => {
  const paths = writeArtifacts();
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
      verifySignature: async () => {
        throw new Error('signature rejected by the async verifier');
      },
    }),
    /signature rejected by the async verifier/u,
  );
});

test('the local verification hands the verifier bytes rather than paths', async () => {
  const paths = writeArtifacts();
  const received = [];
  await verifyLocalArtifacts({
    ...paths,
    expectedChannel: 'internal',
    expectedVersion: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifySignature: async (context) => {
      received.push(context);
    },
  });
  assert.equal(received.length, 1);
  const [context] = received;
  assert.deepEqual(Object.keys(context).sort(), [
    'fileManifestBytes',
    'manifestBytes',
    'packagePath',
    'publicKeyBase64',
  ]);
  assert.ok(Buffer.isBuffer(context.manifestBytes));
  assert.ok(Buffer.isBuffer(context.fileManifestBytes));
  assert.ok(context.fileManifestBytes.equals(FILE_MANIFEST_BYTES));
  assert.ok(context.manifestBytes.equals(readFileSync(paths.manifestPath)));
  assert.equal(context.packagePath, paths.packagePath);
  assert.equal(context.publicKeyBase64, PUBLIC_KEY_BASE64);
});

test('a well formed network input keeps its host and resolves the known hosts path', () => {
  const parsed = parsePublishInput({
    channel: 'internal',
    version: '1.2.3',
    needsNetwork: true,
    host: 'release.example.com',
    knownHostsPath: '/tmp/known_hosts',
  });
  assert.equal(parsed.host, 'release.example.com');
  assert.equal(parsed.knownHostsPath, resolve('/tmp/known_hosts'));
});

test('the known hosts guard is insensitive to case on windows', { skip: process.platform !== 'win32' }, (t) => {
  const root = process.cwd();
  if (root.toUpperCase() === root) {
    t.skip('the working directory has no lowercase letters to vary');
    return;
  }
  assert.throws(
    () => assertKnownHostsPath(join(root, 'known_hosts').toUpperCase(), root),
    /must live outside the repository/u,
  );
});

test('a manifest that is not a JSON object is rejected', async () => {
  const paths = writeArtifacts({ manifestBytes: Buffer.from('null', 'utf8') });
  await assert.rejects(
    verifyLocalArtifacts({
      ...paths,
      expectedChannel: 'internal',
      expectedVersion: '1.2.3',
      publicKeyBase64: PUBLIC_KEY_BASE64,
    }),
    /is not a JSON object/u,
  );
});

import { PUBLISH_STAGES, planCommit, runPreflight } from './feed-publish.mjs';

function fakeReadOnlyTransport(overrides = {}) {
  const calls = [];
  return {
    calls,
    readOnly: {
      sshRun: async (request) => {
        calls.push(['sshRun', request.script]);
        return overrides.sshRun ? overrides.sshRun(request) : { status: 0, stdout: '', stderr: '' };
      },
    },
    write: {
      sshRun: async () => ({ status: 0, stdout: '', stderr: '' }),
      sftpUpload: async () => ({ status: 0, bytesSent: 1 }),
    },
    fetchPublic: async (url) => {
      calls.push(['fetchPublic', url]);
      return { status: 200, bodyBytes: new Uint8Array() };
    },
  };
}

test('the commit plan lists the thirteen stages in the fixed order', () => {
  assert.deepEqual(PUBLISH_STAGES, [
    'pre-verify',
    'stage',
    'remote-verify',
    'lock',
    're-verify',
    'commit-version',
    'backup-manifest',
    'cas',
    'temp-manifest',
    'flip',
    'public-verify',
    'reveal',
    'unlock',
  ]);
});

test('the dry run validates the triple and prints the plan without any transport', async () => {
  const paths = writeArtifacts();
  const plan = await planCommit({
    channel: 'internal',
    version: '1.2.3',
    ...paths,
    publicKeyBase64: PUBLIC_KEY_BASE64,
  });
  assert.deepEqual(
    plan.map((entry) => entry.stage),
    [...PUBLISH_STAGES],
  );
  assert.equal(plan[0].status, 'pending');
});

test('the dry run propagates a local verification failure instead of printing a plan', async () => {
  const paths = writeArtifacts({ packageBytes: Buffer.from('tampered', 'utf8') });
  await assert.rejects(
    planCommit({ channel: 'internal', version: '1.2.3', ...paths, publicKeyBase64: PUBLIC_KEY_BASE64 }),
    /package integrity/u,
  );
});

test('the preflight only performs read only actions and never claims writability', async () => {
  const transport = fakeReadOnlyTransport({
    sshRun: (request) =>
      request.script.includes('stat -c')
        ? { status: 0, stdout: '100\n100\n', stderr: '' }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await runPreflight({
    channel: 'internal',
    version: '1.2.3',
    transport,
    host: 'h',
    knownHostsPath: 'k',
  });
  const names = transport.calls.map((call) => call[0]);
  assert.deepEqual([...new Set(names)], ['sshRun']);
  assert.equal(result.writabilityIndicators.verifiedWrite, false);
  assert.match(result.writabilityIndicators.note, /indicator/u);
});

test('the preflight reports different file systems instead of assuming one', async () => {
  const transport = fakeReadOnlyTransport({ sshRun: () => ({ status: 0, stdout: '100\n200\n', stderr: '' }) });
  const result = await runPreflight({
    channel: 'internal',
    version: '1.2.3',
    transport,
    host: 'h',
    knownHostsPath: 'k',
  });
  assert.equal(result.sameFileSystem, false);
  assert.match(result.notes.join(' '), /file system/u);
});
