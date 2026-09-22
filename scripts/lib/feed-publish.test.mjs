import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  assertNotReusedManifest,
  buildStableManifestInput,
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

const HOST = 'publish.example.invalid';
const KNOWN_HOSTS_PATH = '/etc/mofang/known_hosts';

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
    verifySignature: () => {},
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
        calls.push(['sshRun', request.script, request]);
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

function assertEveryCallCarriesTheTrustAnchor(calls) {
  assert.ok(calls.length > 0, 'the trust anchor assertion needs at least one recorded call');
  for (const call of calls) {
    const request = call[2];
    assert.ok(request !== undefined, `the ${String(call[0])} call did not record its request`);
    assert.equal(request.host, HOST, `the ${String(call[0])} call did not carry the pinned host`);
    assert.equal(
      request.knownHostsPath,
      KNOWN_HOSTS_PATH,
      `the ${String(call[0])} call did not carry the pinned known hosts file`,
    );
  }
}

test('the anchor helper refuses an empty call list rather than passing on zero calls', () => {
  assert.throws(() => assertEveryCallCarriesTheTrustAnchor([]));
});

test('the anchor helper names a call that did not record its request', () => {
  assert.throws(
    () => assertEveryCallCarriesTheTrustAnchor([['fetchPublic', 'url']]),
    /the fetchPublic call did not record its request/u,
  );
});

async function preflightWithProbe(probe) {
  const transport = fakeReadOnlyTransport({ sshRun: () => probe });
  const result = await runPreflight({
    channel: 'internal',
    version: '1.2.3',
    transport,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
  return result;
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
  assert.ok(Object.isFrozen(PUBLISH_STAGES));
});

test('the dry run validates the triple and prints the plan without any transport', async () => {
  const paths = writeArtifacts();
  const plan = await planCommit({
    channel: 'internal',
    version: '1.2.3',
    ...paths,
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifySignature: () => {},
  });
  assert.deepEqual(
    plan.map((entry) => entry.stage),
    [...PUBLISH_STAGES],
  );
  assert.equal(plan.length, PUBLISH_STAGES.length);
  assert.ok(plan.every((entry) => entry.status === 'pending'));
});

test('the dry run follows the channel and the version it was given instead of a default', async () => {
  const paths = writeArtifacts({
    manifestOverrides: {
      channel: 'stable',
      version: '1.2.4',
      packageUrl: `${PUBLIC_BASE_URL}/stable/1.2.4/portable.zip`,
    },
  });
  const plan = await planCommit({
    channel: 'stable',
    version: '1.2.4',
    ...paths,
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifySignature: () => {},
  });
  assert.equal(plan.length, PUBLISH_STAGES.length);
});

test('the dry run propagates a local verification failure instead of printing a plan', async () => {
  const paths = writeArtifacts({ packageBytes: Buffer.from('tampered', 'utf8') });
  await assert.rejects(
    planCommit({ channel: 'internal', version: '1.2.3', ...paths, publicKeyBase64: PUBLIC_KEY_BASE64 }),
    /package integrity/u,
  );
});

test('the dry run passes the signature verifier through to the local verification', async () => {
  const paths = writeArtifacts();
  await assert.rejects(
    planCommit({
      channel: 'internal',
      version: '1.2.3',
      ...paths,
      publicKeyBase64: PUBLIC_KEY_BASE64,
      verifySignature: async () => {
        throw new Error('signature rejected through the dry run');
      },
    }),
    /signature rejected through the dry run/u,
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
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  const names = transport.calls.map((call) => call[0]);
  assert.deepEqual([...new Set(names)], ['sshRun']);
  assert.equal(transport.calls[0][1], `stat -c '%d' ${STATE_ROOT} ${UPDATE_ROOT}`);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
  assert.equal(result.sameFileSystem, true);
  assert.equal(result.writabilityIndicators.verifiedWrite, false);
  assert.match(result.writabilityIndicators.note, /indicator/u);
});

test('the preflight reports different file systems instead of assuming one', async () => {
  const transport = fakeReadOnlyTransport({ sshRun: () => ({ status: 0, stdout: '100\n200\n', stderr: '' }) });
  const result = await runPreflight({
    channel: 'internal',
    version: '1.2.3',
    transport,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
  assert.equal(result.sameFileSystem, false);
  assert.match(result.notes.join(' '), /file system/u);

  const empty = await preflightWithProbe({ status: 0, stdout: '', stderr: '' });
  assert.equal(empty.sameFileSystem, false);
  assert.match(empty.notes.join(' '), /file system/u);

  const single = await preflightWithProbe({ status: 0, stdout: '5\n', stderr: '' });
  assert.equal(single.sameFileSystem, false);
});

test('the preflight records a failed probe instead of reporting all clear', async () => {
  const failed = await preflightWithProbe({ status: 1, stdout: '5\n5\n', stderr: 'stat: cannot statx' });
  assert.equal(failed.sameFileSystem, true);
  assert.match(failed.notes.join(' '), /did not succeed/u);
});

import {
  LOCK_STATES,
  acquireChannelLock,
  breakChannelLock,
  planHashOf,
  readOwnerRecord,
  releaseChannelLock,
  resolveLockDisposition,
} from './feed-publish.mjs';

const PLAN_INPUT = {
  channel: 'internal',
  version: '1.2.3',
  packageSha256: 'a'.repeat(64),
  fileManifestSha256: 'b'.repeat(64),
  manifestSha256: 'c'.repeat(64),
};

const OWNER_RECORD = {
  runid: 'r1',
  operator: 'ops',
  startedAt: '2026-09-22T00:00:00.000Z',
  planHash: 'p1',
  machine: 'builder-01',
};

function fakeWriteTransport(handlers = {}) {
  const calls = [];
  return {
    calls,
    readOnly: {
      sshRun: async (request) => {
        calls.push(['readSsh', request.script, request]);
        return handlers.readSsh ? handlers.readSsh(request) : { status: 0, stdout: '', stderr: '' };
      },
    },
    write: {
      sshRun: async (request) => {
        calls.push(['writeSsh', request.script, request]);
        return handlers.writeSsh ? handlers.writeSsh(request) : { status: 0, stdout: '', stderr: '' };
      },
      sftpUpload: async () => ({ status: 0, bytesSent: 1 }),
    },
    fetchPublic: async () => ({ status: 200, bodyBytes: new Uint8Array() }),
  };
}

test('the lock states are exactly the four documented ones', () => {
  assert.deepEqual([...LOCK_STATES], ['not-acquired', 'released', 'retained-by-this-run', 'ownership-unknown']);
});

test('the plan hash binds channel, version and all three artifact digests', () => {
  const base = planHashOf(PLAN_INPUT);
  assert.equal(base, planHashOf({ ...PLAN_INPUT }));
  const other = {
    channel: 'stable',
    version: '1.2.4',
    packageSha256: 'changed',
    fileManifestSha256: 'changed',
    manifestSha256: 'changed',
  };
  for (const key of ['version', 'channel', 'packageSha256', 'fileManifestSha256', 'manifestSha256']) {
    assert.notEqual(base, planHashOf({ ...PLAN_INPUT, [key]: other[key] }), `planHash ignored ${key}`);
  }
});

test('the lock mkdir is pinned to the C locale so its diagnostics do not move with the host locale', async () => {
  const transport = fakeWriteTransport();
  await acquireChannelLock(lockInput(transport));
  assert.equal(writeScripts(transport)[0], `LC_ALL=C mkdir ${LOCK_DIR}`);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('the plan hash refuses a field that is not a non empty string', () => {
  for (const field of ['channel', 'version', 'packageSha256', 'fileManifestSha256', 'manifestSha256']) {
    for (const value of [undefined, null, '', '   ', 7, {}]) {
      assert.throws(
        () => planHashOf({ ...PLAN_INPUT, [field]: value }),
        FeedPublishError,
        `${field} = ${String(value)}`,
      );
    }
  }
  assert.throws(() => planHashOf({}), FeedPublishError);
  assert.throws(() => planHashOf(undefined), FeedPublishError);
  assert.equal(typeof planHashOf(PLAN_INPUT), 'string');
});

test('an existing lock is a determinate not-acquired and never stolen', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      isLockDirectoryCommand(request)
        ? { status: 1, stdout: '', stderr: "mkdir: cannot create directory '/x': File exists" }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await acquireChannelLock({
    channel: 'internal',
    transport,
    owner: OWNER_RECORD,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assert.equal(result.state, 'not-acquired');
  assert.equal(result.requiresExplicitRecovery, true);
  assert.equal(transport.calls.filter((call) => /rm |rmdir/u.test(String(call[1] ?? ''))).length, 0);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('an ssh failure while taking the lock is ownership unknown, not not-acquired', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      isLockDirectoryCommand(request)
        ? { status: -1, stdout: '', stderr: 'connection timed out' }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await acquireChannelLock({
    channel: 'internal',
    transport,
    owner: OWNER_RECORD,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assert.equal(result.state, 'ownership-unknown');
  assert.match(result.reason, /cannot confirm/u);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a failed owner write is an incident that keeps the lock', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      request.script.includes('owner.json')
        ? { status: 1, stdout: '', stderr: 'read only file system' }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await acquireChannelLock({
    channel: 'internal',
    transport,
    owner: OWNER_RECORD,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assert.equal(result.state, 'retained-by-this-run');
  assert.equal(result.incident, true);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('release verifies the owner, then removes the owner file, then the lock directory', async () => {
  const owner = OWNER_RECORD;
  const order = [];
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }),
    writeSsh: (request) => {
      if (request.script.startsWith('rm ')) order.push('rm-owner');
      if (request.script.startsWith('rmdir ')) order.push('rmdir-lock');
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const verdict = await releaseChannelLock({
    channel: 'internal',
    transport,
    owner,
    runid: 'r1',
    planHash: 'p1',
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
    acquisitionConfirmed: true,
    safeToExit: true,
  });
  assert.equal(verdict.state, 'released');
  assert.deepEqual(order, ['rm-owner', 'rmdir-lock']);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a failed owner removal is never reported as released', async () => {
  const owner = OWNER_RECORD;
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }),
    writeSsh: (request) =>
      request.script.startsWith('rm ')
        ? { status: 1, stdout: '', stderr: 'permission denied' }
        : { status: 0, stdout: '', stderr: '' },
  });
  const verdict = await releaseChannelLock({
    channel: 'internal',
    transport,
    owner,
    runid: 'r1',
    planHash: 'p1',
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
    acquisitionConfirmed: true,
    safeToExit: true,
  });
  assert.equal(verdict.state, 'retained-by-this-run');
  assert.equal(verdict.incident, true);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('release re-reads the owner and refuses when it belongs to another run', async () => {
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 0, stdout: JSON.stringify({ runid: 'other', planHash: 'p1' }), stderr: '' }),
  });
  const verdict = await releaseChannelLock({
    channel: 'internal',
    transport,
    owner: null,
    runid: 'r1',
    planHash: 'p1',
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
    acquisitionConfirmed: true,
    safeToExit: true,
  });
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(transport.calls.filter((call) => /rm |rmdir/u.test(String(call[1] ?? ''))).length, 0);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a run that holds the lock but cannot close safely keeps it', () => {
  const owner = { runid: 'r1', planHash: 'p1' };
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: true,
    owner,
    runid: 'r1',
    planHash: 'p1',
    safeToExit: false,
  });
  assert.equal(verdict.state, 'retained-by-this-run');
  assert.equal(verdict.release, false);
});

test('an unconfirmed acquisition is ownership unknown and never touches the lock', () => {
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: false,
    owner: null,
    runid: 'r1',
    planHash: 'p1',
    safeToExit: true,
  });
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(verdict.release, false);
});

test('breaking a lock needs a reason, an audit log and a matching runid', async () => {
  const owner = { runid: 'r0', planHash: 'p0' };
  const transport = fakeWriteTransport({ readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }) });
  const base = {
    channel: 'internal',
    transport,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
    confirmRunid: 'r0',
    auditOut: '/outside/audit.jsonl',
    operator: 'ops',
  };
  await assert.rejects(breakChannelLock({ ...base, reason: '' }), FeedPublishError);
  await assert.rejects(breakChannelLock({ ...base, reason: 'stopped', auditOut: null }), FeedPublishError);
  await assert.rejects(
    breakChannelLock({ ...base, reason: 'stopped', confirmRunid: 'wrong' }),
    /does not match the owner/u,
  );
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('breaking a lock records the real previous owner and the operator', async () => {
  const owner = { runid: 'r0', planHash: 'p0' };
  const transport = fakeWriteTransport({ readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }) });
  const record = await breakChannelLock({
    channel: 'internal',
    transport,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
    reason: 'operator confirmed the previous run stopped',
    confirmRunid: 'r0',
    auditOut: '/outside/audit.jsonl',
    operator: 'ops',
  });
  assert.equal(record.outcome, 'lock-broken');
  assert.deepEqual(record.previousOwner, owner);
  assert.equal(record.operator, 'ops');
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a failed remote deletion is not recorded as lock-broken', async () => {
  const owner = { runid: 'r0', planHash: 'p0' };
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(owner), stderr: '' }),
    writeSsh: (request) =>
      request.script.startsWith('rm ')
        ? { status: 1, stdout: '', stderr: 'permission denied' }
        : { status: 0, stdout: '', stderr: '' },
  });
  await assert.rejects(
    breakChannelLock({
      channel: 'internal',
      transport,
      host: HOST,
      knownHostsPath: KNOWN_HOSTS_PATH,
      reason: 'stopped',
      confirmRunid: 'r0',
      auditOut: '/outside/audit.jsonl',
      operator: 'ops',
    }),
    /could not be removed/u,
  );
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('the lock states are frozen so no run can add a fifth one', () => {
  assert.ok(Object.isFrozen(LOCK_STATES));
  assert.throws(() => LOCK_STATES.push('fifth'), TypeError);
});

const LOCK_DIR = `${STATE_ROOT}/lock/internal`;
const OWNER_FILE = `${LOCK_DIR}/owner.json`;
const THIS_RUN = OWNER_RECORD;
const PREVIOUS_RUN = { runid: 'r0', planHash: 'p0' };
const OTHER_RUN_REASON = 'operator confirmed the previous run is not running';

const lockInput = (transport, overrides = {}) => ({
  channel: 'internal',
  transport,
  owner: THIS_RUN,
  host: HOST,
  knownHostsPath: KNOWN_HOSTS_PATH,
  ...overrides,
});

const releaseInput = (transport, overrides = {}) => ({
  channel: 'internal',
  transport,
  owner: THIS_RUN,
  runid: 'r1',
  planHash: 'p1',
  host: HOST,
  knownHostsPath: KNOWN_HOSTS_PATH,
  acquisitionConfirmed: true,
  safeToExit: true,
  ...overrides,
});

const breakInput = (transport, overrides = {}) => ({
  channel: 'internal',
  transport,
  host: HOST,
  knownHostsPath: KNOWN_HOSTS_PATH,
  reason: OTHER_RUN_REASON,
  confirmRunid: 'r0',
  auditOut: '/outside/repo/audit.jsonl',
  operator: 'ops',
  ...overrides,
});

const readablePreviousOwner = () => ({ status: 0, stdout: JSON.stringify(PREVIOUS_RUN), stderr: '' });

const readableThisRunOwner = () => ({ status: 0, stdout: JSON.stringify(THIS_RUN), stderr: '' });

const existingEntryFailure = { status: 1, stdout: '', stderr: "mkdir: cannot create directory '/x': File exists" };

const refusesLockWrites = (transport) =>
  transport.calls.filter((call) => /rm |rmdir/u.test(String(call[1] ?? ''))).length === 0;

const writeScripts = (transport) => transport.calls.filter((call) => call[0] === 'writeSsh').map((call) => call[1]);

const isLockDirectoryCommand = (request) => /(?:^|\s)mkdir \S*\/lock\//u.test(request.script);

const OBSERVED_OPERATOR = { ...OWNER_RECORD, operator: "O'Brien (release engineer)" };

const ownerWriteScript = (owner, path = OWNER_FILE) =>
  `printf '%s' '${Buffer.from(JSON.stringify(owner), 'utf8').toString('base64')}' | base64 -d > ${path}`;

const ownerPayloadOf = (script) => {
  const matched = /^printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > /u.exec(script);
  assert.ok(matched !== null, `the owner write did not carry a base64 payload: ${String(script)}`);
  return JSON.parse(Buffer.from(matched[1], 'base64').toString('utf8'));
};

test('an owner record with an apostrophe cannot end the shell word it is written into', async () => {
  const transport = fakeWriteTransport();
  const result = await acquireChannelLock(lockInput(transport, { owner: OBSERVED_OPERATOR }));
  assert.equal(result.state, 'retained-by-this-run');
  assert.equal(result.incident, false);
  const scripts = writeScripts(transport);
  assert.deepEqual(scripts, [`LC_ALL=C mkdir ${LOCK_DIR}`, ownerWriteScript(OBSERVED_OPERATOR)]);
  assert.deepEqual(ownerPayloadOf(scripts[1]), OBSERVED_OPERATOR);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a successful acquisition writes the owner record for this run', async () => {
  const transport = fakeWriteTransport();
  const result = await acquireChannelLock(lockInput(transport));
  assert.equal(result.state, 'retained-by-this-run');
  assert.equal(result.acquired, true);
  assert.equal(result.incident, false);
  assert.equal(result.requiresExplicitRecovery, false);
  assert.deepEqual(result.owner, THIS_RUN);
  assert.deepEqual(writeScripts(transport), [`LC_ALL=C mkdir ${LOCK_DIR}`, ownerWriteScript(THIS_RUN)]);
  for (const field of ['runid', 'operator', 'startedAt', 'planHash', 'machine']) {
    assert.match(
      JSON.stringify(ownerPayloadOf(writeScripts(transport)[1])),
      new RegExp(`"${field}":`, 'u'),
      `the recorded owner must carry ${field}`,
    );
  }
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('the lock lives under the channel it was given rather than a fixed one', async () => {
  const transport = fakeWriteTransport();
  const result = await acquireChannelLock(lockInput(transport, { channel: 'stable' }));
  assert.equal(result.state, 'retained-by-this-run');
  assert.deepEqual(writeScripts(transport), [
    `LC_ALL=C mkdir ${STATE_ROOT}/lock/stable`,
    ownerWriteScript(THIS_RUN, `${STATE_ROOT}/lock/stable/owner.json`),
  ]);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a lock mkdir that fails without an existing entry signal is ownership unknown', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      isLockDirectoryCommand(request)
        ? { status: 1, stdout: '', stderr: "mkdir: cannot create directory '/x': Permission denied" }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await acquireChannelLock(lockInput(transport));
  assert.equal(result.state, 'ownership-unknown');
  assert.equal(result.incident, true);
  assert.match(result.reason, /cannot confirm/u);
  assert.ok(refusesLockWrites(transport));
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a transport level mkdir failure is ownership unknown even when its output looks like an existing entry', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      isLockDirectoryCommand(request)
        ? { status: -1, stdout: existingEntryFailure.stdout, stderr: existingEntryFailure.stderr }
        : { status: 0, stdout: '', stderr: '' },
  });
  const result = await acquireChannelLock(lockInput(transport));
  assert.equal(result.state, 'ownership-unknown');
  assert.equal(result.acquired, false);
  assert.equal(result.requiresExplicitRecovery, true);
  assert.ok(refusesLockWrites(transport));
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('the existing entry signal is read from either stream and without regard to case', async () => {
  const transport = fakeWriteTransport({
    writeSsh: (request) =>
      isLockDirectoryCommand(request) ? { status: 1, stdout: 'mkdir: FILE EXISTS', stderr: '' } : { status: 0 },
  });
  const result = await acquireChannelLock(lockInput(transport));
  assert.equal(result.state, 'not-acquired');
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('an existing lock reports the owner it found so a human can confirm it', async () => {
  const transport = fakeWriteTransport({
    readSsh: readablePreviousOwner,
    writeSsh: (request) => (isLockDirectoryCommand(request) ? existingEntryFailure : { status: 0 }),
  });
  const result = await acquireChannelLock(lockInput(transport));
  assert.equal(result.state, 'not-acquired');
  assert.equal(result.acquired, false);
  assert.equal(result.incident, false);
  assert.deepEqual(result.owner, PREVIOUS_RUN);
  assert.deepEqual(
    transport.calls.filter((call) => call[0] === 'readSsh').map((call) => call[1]),
    [`cat ${OWNER_FILE}`],
  );
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('an owner read that exits non-zero is unreadable even when it printed a record', async () => {
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 1, stdout: JSON.stringify(PREVIOUS_RUN), stderr: 'permission denied' }),
    writeSsh: (request) => (isLockDirectoryCommand(request) ? existingEntryFailure : { status: 0 }),
  });
  const result = await acquireChannelLock(lockInput(transport));
  assert.equal(result.state, 'not-acquired');
  assert.equal(result.owner, null);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a lock owner that is missing or not a record is ownership unknown', () => {
  for (const owner of [null, undefined]) {
    const label = `owner ${String(owner)}`;
    const verdict = resolveLockDisposition({
      acquisitionConfirmed: true,
      owner,
      runid: 'r1',
      planHash: 'p1',
      safeToExit: true,
    });
    assert.equal(verdict.release, false, label);
    assert.equal(verdict.state, 'ownership-unknown', label);
    assert.equal(verdict.incident, true, label);
  }
});

test('an owner record that matches the runid but not the plan hash is ownership unknown', () => {
  const verdict = resolveLockDisposition({
    acquisitionConfirmed: true,
    owner: { runid: 'r1', planHash: 'other' },
    runid: 'r1',
    planHash: 'p1',
    safeToExit: true,
  });
  assert.equal(verdict.release, false);
  assert.equal(verdict.state, 'ownership-unknown');
  assert.equal(verdict.incident, true);
  assert.match(verdict.reason, /planHash/u);
});

test('release re-reads the owner from the lock when the caller has none', async () => {
  const transport = fakeWriteTransport({ readSsh: readableThisRunOwner });
  const verdict = await releaseChannelLock(releaseInput(transport, { owner: undefined }));
  assert.equal(verdict.state, 'released');
  assert.deepEqual(writeScripts(transport), [`rm ${OWNER_FILE}`, `rmdir ${LOCK_DIR}`]);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('release that removed the owner file but not the lock directory is not released', async () => {
  const transport = fakeWriteTransport({
    readSsh: readablePreviousOwner,
    writeSsh: (request) =>
      request.script.startsWith('rmdir ')
        ? { status: 1, stdout: '', stderr: 'rmdir: failed to remove: Directory not empty' }
        : { status: 0 },
  });
  const verdict = await releaseChannelLock(releaseInput(transport));
  assert.equal(verdict.state, 'retained-by-this-run');
  assert.equal(verdict.release, false);
  assert.equal(verdict.incident, true);
  assert.match(verdict.reason, /lock directory/u);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('breaking a lock removes the owner file before the lock directory and records the reason', async () => {
  const order = [];
  const transport = fakeWriteTransport({
    readSsh: readablePreviousOwner,
    writeSsh: (request) => {
      order.push(request.script);
      return { status: 0 };
    },
  });
  const record = await breakChannelLock(breakInput(transport));
  assert.deepEqual(order, [`rm ${OWNER_FILE}`, `rmdir ${LOCK_DIR}`]);
  assert.equal(record.reason, OTHER_RUN_REASON);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a break whose lock directory survives is not recorded as lock-broken', async () => {
  const transport = fakeWriteTransport({
    readSsh: readablePreviousOwner,
    writeSsh: (request) =>
      request.script.startsWith('rmdir ')
        ? { status: 1, stdout: '', stderr: 'rmdir: failed to remove: Permission denied' }
        : { status: 0 },
  });
  await assert.rejects(breakChannelLock(breakInput(transport)), /could not be removed/u);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('breaking a lock without a readable owner record is refused', async () => {
  const transport = fakeWriteTransport({
    readSsh: () => ({ status: 1, stdout: '', stderr: 'permission denied' }),
  });
  await assert.rejects(breakChannelLock(breakInput(transport)), /no readable owner record/u);
  assert.deepEqual(writeScripts(transport), []);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('breaking a lock refuses a reason that is not a written string', async () => {
  const transport = fakeWriteTransport({ readSsh: readablePreviousOwner });
  await assert.rejects(breakChannelLock(breakInput(transport, { reason: '   ' })), FeedPublishError);
  await assert.rejects(breakChannelLock(breakInput(transport, { reason: 42 })), FeedPublishError);
  await assert.rejects(breakChannelLock(breakInput(transport, { auditOut: undefined })), FeedPublishError);
  assert.deepEqual(writeScripts(transport), []);
});

test('breaking a lock refuses an empty audit log path', async () => {
  const transport = fakeWriteTransport({ readSsh: readablePreviousOwner });
  await assert.rejects(breakChannelLock(breakInput(transport, { auditOut: '' })), FeedPublishError);
  assert.deepEqual(transport.calls, []);
});

test('the owner record read separates an absent record from a failed read', async () => {
  const unread = fakeWriteTransport({
    readSsh: () => ({ status: 1, stdout: JSON.stringify(PREVIOUS_RUN), stderr: 'permission denied' }),
  });
  const broken = fakeWriteTransport({ readSsh: () => ({ status: 0, stdout: 'not json{', stderr: '' }) });
  const present = fakeWriteTransport({ readSsh: () => readableThisRunOwner() });
  assert.deepEqual(await readOwnerRecord(lockInput(unread)), {
    ok: false,
    record: null,
    cause: 'the owner record could not be read',
  });
  assert.deepEqual(await readOwnerRecord(lockInput(broken)), {
    ok: false,
    record: null,
    cause: 'the owner record is not valid JSON',
  });
  assert.deepEqual(await readOwnerRecord(lockInput(present)), { ok: true, record: THIS_RUN, cause: null });
});

test('a corrupt owner record on the lock is unreadable rather than a crash', async () => {
  const transport = fakeWriteTransport({ readSsh: () => ({ status: 0, stdout: 'not json{', stderr: '' }) });
  const verdict = await releaseChannelLock(releaseInput(transport, { owner: null }));
  assert.equal(verdict.release, false);
  assert.equal(verdict.state, 'ownership-unknown');
  assert.deepEqual(writeScripts(transport), []);
  assertEveryCallCarriesTheTrustAnchor(transport.calls);
});

test('a release that never confirmed its own acquisition refuses and writes nothing', async () => {
  const absent = releaseInput(fakeWriteTransport({ readSsh: readableThisRunOwner }));
  delete absent.acquisitionConfirmed;
  const absentVerdict = await releaseChannelLock(absent);
  assert.equal(absentVerdict.release, false);
  assert.equal(absentVerdict.state, 'ownership-unknown');
  assert.deepEqual(absent.transport.calls, []);

  const deniedTransport = fakeWriteTransport({ readSsh: readableThisRunOwner });
  const deniedVerdict = await releaseChannelLock(releaseInput(deniedTransport, { acquisitionConfirmed: false }));
  assert.equal(deniedVerdict.release, false);
  assert.equal(deniedVerdict.state, 'ownership-unknown');
  assert.deepEqual(deniedTransport.calls, []);
});

test('a release that is not safe to exit keeps the lock this run owns', async () => {
  const transport = fakeWriteTransport({ readSsh: readableThisRunOwner });
  const verdict = await releaseChannelLock(releaseInput(transport, { safeToExit: false }));
  assert.equal(verdict.release, false);
  assert.equal(verdict.state, 'retained-by-this-run');
  assert.deepEqual(transport.calls, []);
});

const withoutOwnerField = (field) => {
  const owner = { ...OWNER_RECORD };
  delete owner[field];
  return owner;
};

test('an owner record without a runid never creates a lock', async () => {
  const transport = fakeWriteTransport();
  await assert.rejects(
    acquireChannelLock(lockInput(transport, { owner: withoutOwnerField('runid') })),
    (error) => error instanceof FeedPublishError && /runid/u.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test('an owner record without an operator never creates a lock', async () => {
  const transport = fakeWriteTransport();
  await assert.rejects(
    acquireChannelLock(lockInput(transport, { owner: withoutOwnerField('operator') })),
    (error) => error instanceof FeedPublishError && /operator/u.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test('an owner record without a startedAt never creates a lock', async () => {
  const transport = fakeWriteTransport();
  await assert.rejects(
    acquireChannelLock(lockInput(transport, { owner: withoutOwnerField('startedAt') })),
    (error) => error instanceof FeedPublishError && /startedAt/u.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test('an owner record without a planHash never creates a lock', async () => {
  const transport = fakeWriteTransport();
  await assert.rejects(
    acquireChannelLock(lockInput(transport, { owner: withoutOwnerField('planHash') })),
    (error) => error instanceof FeedPublishError && /planHash/u.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test('an owner record without a machine never creates a lock', async () => {
  const transport = fakeWriteTransport();
  await assert.rejects(
    acquireChannelLock(lockInput(transport, { owner: withoutOwnerField('machine') })),
    (error) => error instanceof FeedPublishError && /machine/u.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test('an owner record with a blank machine never creates a lock', async () => {
  const transport = fakeWriteTransport();
  await assert.rejects(
    acquireChannelLock(lockInput(transport, { owner: { ...OWNER_RECORD, machine: '   ' } })),
    (error) => error instanceof FeedPublishError && /machine/u.test(error.message),
  );
  assert.equal(transport.calls.length, 0);
});

test('a missing owner record never creates a lock', async () => {
  for (const owner of [null, undefined]) {
    const transport = fakeWriteTransport();
    await assert.rejects(
      acquireChannelLock(lockInput(transport, { owner })),
      (error) => error instanceof FeedPublishError && /owner record/u.test(error.message),
    );
    assert.equal(transport.calls.length, 0);
  }
});

const UNSAFE_CHANNELS = [
  '../evil',
  'internal/x',
  'internal; id',
  '',
  'INTERNAL',
  'internal lock',
  'internal\nx',
  'internall',
];

test('a channel that could escape its remote path never reaches a remote call', async () => {
  for (const channel of UNSAFE_CHANNELS) {
    const acquiring = fakeWriteTransport();
    await assert.rejects(acquireChannelLock(lockInput(acquiring, { channel })), FeedPublishError, channel);
    assert.equal(acquiring.calls.length, 0, channel);
    const breaking = fakeWriteTransport({ readSsh: readablePreviousOwner });
    await assert.rejects(breakChannelLock(breakInput(breaking, { channel })), FeedPublishError, channel);
    assert.equal(breaking.calls.length, 0, channel);
  }
});

test('the channel precondition admits every channel the whitelist allows', async () => {
  for (const channel of CHANNELS) {
    const transport = fakeWriteTransport();
    const result = await acquireChannelLock(lockInput(transport, { channel }));
    assert.equal(result.state, 'retained-by-this-run', channel);
    assert.equal(transport.calls.length, 2, channel);
  }
});

test('the plan hash refuses a channel outside the whitelist', () => {
  assert.throws(() => planHashOf({ ...PLAN_INPUT, channel: 'internall' }), FeedPublishError);
  for (const channel of CHANNELS) {
    assert.equal(typeof planHashOf({ ...PLAN_INPUT, channel }), 'string', channel);
  }
});

test('the version the input gate admits carries no shell metacharacter and no newline', () => {
  const admitted = parsePublishInput({
    channel: 'internal',
    version: '1.2.3',
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assert.equal(admitted.version, '1.2.3');
  for (const version of [
    '1.2.3; id',
    '1.2.3+;id',
    '1.2.3$(id)',
    '1.2.3|x',
    '1.2.3`id`',
    "1.2.3'",
    '1.2.3"',
    '1.2.3\n',
    '1.2.3\n1.2.3',
    '1.2.3 1.2.3',
  ]) {
    assert.throws(
      () => parsePublishInput({ channel: 'internal', version, host: HOST, knownHostsPath: KNOWN_HOSTS_PATH }),
      FeedPublishError,
      version,
    );
  }
});

import {
  PORTABLE_FILE_MANIFEST_NAME,
  PORTABLE_PACKAGE_NAME,
  appendAuditStage,
  assertNoReservedEvidenceKeys,
  runCommit,
  verifyPublicArtifacts,
} from './feed-publish.mjs';
import { buildPortableRelease, verifyPortableRelease } from './portable-update-release.mjs';

const BASELINE_BODY = '{"baseline":true}\n';
const THIRD_BODY = '{"third":true}\n';
const digestOf = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const BASELINE_SHA = digestOf(BASELINE_BODY);
const THIRD_SHA = digestOf(THIRD_BODY);

const auditEntriesOf = (auditOut) =>
  readFileSync(auditOut, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

function commitTransport(options = {}) {
  const calls = [];
  let manifestReads = 0;
  let ownerJson = null;
  const listing = `f ${PORTABLE_PACKAGE_NAME} ${PACKAGE_BYTES.length}\nf ${PORTABLE_FILE_MANIFEST_NAME} ${FILE_MANIFEST_BYTES.length}\n`;
  const stagingListing = options.stagingListing ?? listing;
  const digests = (directory, zipDigest) =>
    `${zipDigest}  ${directory}/${PORTABLE_PACKAGE_NAME}\n${FILE_MANIFEST_SHA256}  ${directory}/${PORTABLE_FILE_MANIFEST_NAME}\n`;

  return {
    anchor: null,
    calls,
    readOnly: {
      sshRun: async (request) => {
        calls.push(['readSsh', request.script, request]);
        if (request.script.includes('owner.json')) {
          if (options.foreignOwnerFromReVerify === true) {
            return { status: 0, stdout: JSON.stringify({ runid: 'other', planHash: 'other' }), stderr: '' };
          }
          if (options.ownerReadFailsAfterLock === true && ownerJson !== null) {
            return { status: 1, stdout: '', stderr: 'connection reset' };
          }
          return ownerJson === null
            ? { status: 1, stdout: '', stderr: 'no such file' }
            : { status: 0, stdout: ownerJson, stderr: '' };
        }
        if (request.script.includes('-mindepth 1 -maxdepth 1 -printf')) {
          if (typeof options.listingStatus === 'number' && options.listingStatus !== 0) {
            return { status: options.listingStatus, stdout: 'find: Permission denied\n', stderr: '' };
          }
          if (request.script.includes('/staging/')) return { status: 0, stdout: stagingListing, stderr: '' };
          const state = options.versionDirState ?? 'absent';
          if (state === 'absent' || state === 'empty') return { status: 0, stdout: '', stderr: '' };
          if (state === 'extra') return { status: 0, stdout: `${listing}f extra.bin 3\n`, stderr: '' };
          if (state === 'size') {
            return {
              status: 0,
              stdout: `f ${PORTABLE_PACKAGE_NAME} ${PACKAGE_BYTES.length + 1}\nf ${PORTABLE_FILE_MANIFEST_NAME} ${FILE_MANIFEST_BYTES.length}\n`,
              stderr: '',
            };
          }
          return { status: 0, stdout: listing, stderr: '' };
        }
        if (request.script.startsWith('if [ -d ')) {
          if (typeof options.directoryProbeStatus === 'number' && options.directoryProbeStatus !== 0) {
            return { status: options.directoryProbeStatus, stdout: 'present\n', stderr: 'connection reset' };
          }
          const state = options.versionDirState ?? 'absent';
          const present = state !== 'absent';
          const insideStaging = request.script.includes('/staging/');
          if (!present && !insideStaging) return { status: 0, stdout: '', stderr: '' };
          return { status: 0, stdout: 'present\n', stderr: '' };
        }
        if (request.script.includes('sha256sum') && request.script.includes('portable-files.json')) {
          if (typeof options.digestStatus === 'number' && options.digestStatus !== 0) {
            return { status: options.digestStatus, stdout: '', stderr: 'sha256sum: Permission denied' };
          }
          const inStaging = request.script.includes('/staging/');
          if (!inStaging && (options.versionDirState ?? 'absent') === 'absent')
            return { status: 0, stdout: '', stderr: '' };
          const zipDigest = options.versionDirState === 'digest' ? THIRD_SHA : PACKAGE_SHA256;
          return { status: 0, stdout: digests(inStaging ? 'staging' : 'version', zipDigest), stderr: '' };
        }
        if (request.script.includes("stat -c '%d'")) {
          if (typeof options.deviceProbeStatus === 'number' && options.deviceProbeStatus !== 0) {
            return { status: options.deviceProbeStatus, stdout: '100\n100\n', stderr: 'stat: cannot statx' };
          }
          return { status: 0, stdout: options.sameFileSystem === false ? '100\n200\n' : '100\n100\n', stderr: '' };
        }
        if (request.script.includes('manifest.json') && request.script.includes('.tmp')) {
          if (options.tempManifestReadStatus !== undefined) {
            return { status: options.tempManifestReadStatus, stdout: '', stderr: 'sha256sum: Permission denied' };
          }
          return {
            status: 0,
            stdout: `${options.tempManifestSha ?? 'MISSING'}  ${request.script.split(/\s+/u)[1]}\n`,
            stderr: '',
          };
        }
        if (request.script.includes('manifest.json')) {
          manifestReads += 1;
          if (options.baselineDigestReadFails === true && manifestReads === 1) {
            return { status: 1, stdout: '', stderr: 'sha256sum: Permission denied' };
          }
          if (options.casDigestReadFails === true && manifestReads > 1) {
            return { status: 1, stdout: '', stderr: 'sha256sum: Permission denied' };
          }
          if (options.firstPublish === true) return { status: 0, stdout: '', stderr: '' };
          if (options.baselineDigestAbsent === true && manifestReads === 1) {
            return { status: 0, stdout: '', stderr: '' };
          }
          const digest = options.casDrift === true && manifestReads > 1 ? THIRD_SHA : BASELINE_SHA;
          return { status: 0, stdout: `${digest}  ${UPDATE_ROOT}/internal/manifest.json\n`, stderr: '' };
        }
        return { status: 0, stdout: '', stderr: '' };
      },
    },
    write: {
      sshRun: async (request) => {
        calls.push(['writeSsh', request.script, request]);
        if (
          request.script.startsWith('mkdir -p ') &&
          typeof options.stagingCreateStatus === 'number' &&
          options.stagingCreateStatus !== 0
        ) {
          return {
            status: options.stagingCreateStatus,
            stdout: '',
            stderr: 'mkdir: cannot create directory: Permission denied',
          };
        }
        if (isLockDirectoryCommand(request)) {
          if (typeof options.lockStatus === 'number' && options.lockStatus !== 0) {
            return {
              status: options.lockStatus,
              stdout: '',
              stderr: options.lockStderr ?? 'mkdir: cannot create directory: File exists',
            };
          }
          return options.lockState === 'exists'
            ? { status: 1, stdout: '', stderr: 'mkdir: cannot create directory: File exists' }
            : { status: 0, stdout: '', stderr: '' };
        }
        const ownerMatch = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > /u.exec(request.script);
        if (ownerMatch !== null) {
          if (typeof options.ownerWriteStatus === 'number' && options.ownerWriteStatus !== 0) {
            return { status: options.ownerWriteStatus, stdout: '', stderr: 'read only file system' };
          }
          ownerJson = Buffer.from(ownerMatch[1], 'base64').toString('utf8');
        }
        if (
          request.script.startsWith('rmdir ') &&
          typeof options.lockRemovalStatus === 'number' &&
          options.lockRemovalStatus !== 0
        ) {
          return {
            status: options.lockRemovalStatus,
            stdout: '',
            stderr: 'rmdir: failed to remove: Directory not empty',
          };
        }
        if (typeof options.finaliseStatus === 'number' && request.script.includes('.part-')) {
          return { status: options.finaliseStatus, stdout: '', stderr: 'mv: cannot stat: No such file or directory' };
        }
        if (typeof options.backupStatus === 'number' && request.script.includes('/backup && cp ')) {
          return { status: options.backupStatus, stdout: '', stderr: 'cp: cannot create regular file: No space left' };
        }
        if (typeof options.flipStatus === 'number' && /^mv -f \S+\.tmp \S+$/u.test(request.script)) {
          return { status: options.flipStatus, stdout: '', stderr: 'mv: cannot move: Permission denied' };
        }
        if (
          /^mv \/opt\/rongying\/updates-state\/staging\//u.test(request.script) &&
          options.commitStatus !== undefined
        ) {
          if (options.foreignOwnerAfterCommit === true) {
            ownerJson = JSON.stringify({ runid: 'other', planHash: 'other' });
          }
          return { status: options.commitStatus, stdout: '', stderr: 'commit refused' };
        }
        if (options.foreignOwnerAfterFlip === true && /^mv -f \S+\.tmp /u.test(request.script)) {
          ownerJson = JSON.stringify({ runid: 'other', planHash: 'other' });
        }
        return { status: 0, stdout: '', stderr: '' };
      },
      sftpUpload: async (request) => {
        calls.push(['sftpUpload', request.localPath, request.remotePath]);
        if (options.uploadStatus !== undefined && !request.localPath.includes('manifest.json')) {
          return { status: options.uploadStatus, bytesSent: 0, stderr: 'connection lost' };
        }
        if (options.manifestUploadStatus !== undefined && request.localPath.includes('manifest.json')) {
          return { status: options.manifestUploadStatus, bytesSent: 0, stderr: 'connection lost' };
        }
        return { status: 0, bytesSent: 1 };
      },
    },
    fetchPublic: async (url) => {
      calls.push(['fetchPublic', url]);
      if (options.publicStatus !== undefined && options.publicStatus !== 200) {
        return { status: options.publicStatus, bodyBytes: new Uint8Array() };
      }
      if (options.manifestBodyMissing === true && url.endsWith('manifest.json')) {
        return { status: 200 };
      }
      const body = url.endsWith('manifest.json')
        ? (options.publicManifestBody ?? BASELINE_BODY)
        : url.endsWith('portable.zip')
          ? (options.publicPackageBody ?? PACKAGE_BYTES.toString('binary'))
          : (options.publicFileManifestBody ?? FILE_MANIFEST_BYTES.toString('binary'));
      return { status: 200, bodyBytes: Uint8Array.from(Buffer.from(body, 'binary')) };
    },
  };
}

function commitInput(transport, overrides = {}) {
  const auditRoot = makeRoot();
  const paths = writeArtifacts();
  const input = {
    channel: 'internal',
    version: '1.2.3',
    host: 'example.invalid',
    knownHostsPath: join(tmpdir(), 'known_hosts'),
    runid: 'r1',
    operator: 'ops',
    startedAt: '2026-09-22T00:00:00.000Z',
    machine: 'builder-01',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifySignature: () => {},
    auditOut: join(auditRoot, 'audit.jsonl'),
    repositoryRoot: makeRoot(),
    temporaryRoot: makeRoot(),
    verifier: () => {},
    transport,
    ...paths,
    ...overrides,
  };
  transport.anchor = { host: input.host, knownHostsPath: input.knownHostsPath };
  return input;
}

function assertEveryCommitCallCarriesTheTrustAnchor(transport) {
  const anchor = transport.anchor;
  assert.ok(anchor !== undefined && anchor !== null, 'the commit anchor assertion needs an input that injected a host');
  const sshCalls = transport.calls.filter((call) => call[0] === 'readSsh' || call[0] === 'writeSsh');
  assert.ok(sshCalls.length > 0, 'the commit anchor assertion needs at least one recorded ssh call');
  for (const call of sshCalls) {
    const request = call[2];
    assert.ok(request !== undefined, `the ${String(call[0])} call did not record its request`);
    assert.equal(request.host, anchor.host, `the ${String(call[0])} call did not carry the injected host`);
    assert.equal(
      request.knownHostsPath,
      anchor.knownHostsPath,
      `the ${String(call[0])} call did not carry the injected known hosts file`,
    );
  }
}

function manifestShaOf(paths) {
  return createHash('sha256').update(readFileSync(paths.manifestPath)).digest('hex');
}

function happyTransport(paths, extra = {}) {
  return commitTransport({
    publicManifestBody: readFileSync(paths.manifestPath).toString('binary'),
    tempManifestSha: manifestShaOf(paths),
    ...extra,
  });
}

test('the commit anchor helper refuses a case that recorded no call', () => {
  assert.throws(() =>
    assertEveryCommitCallCarriesTheTrustAnchor({ anchor: { host: 'h', knownHostsPath: 'k' }, calls: [] }),
  );
  assert.throws(() =>
    assertEveryCommitCallCarriesTheTrustAnchor({
      anchor: null,
      calls: [['readSsh', 'ls', { host: 'h', knownHostsPath: 'k' }]],
    }),
  );
});

test('the commit anchor helper names a call that did not record its request', () => {
  assert.throws(
    () =>
      assertEveryCommitCallCarriesTheTrustAnchor({
        anchor: { host: 'h', knownHostsPath: 'k' },
        calls: [
          ['fetchPublic', 'https://example.invalid'],
          ['readSsh', 'ls'],
        ],
      }),
    /the readSsh call did not record its request/u,
  );
});

test('the local pre-verification happens before any network write', async () => {
  const transport = commitTransport();
  const input = commitInput(transport);
  const result = await runCommit({ ...input, packagePath: join(makeRoot(), 'missing.zip') });
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(
    transport.calls.filter((call) => call[0] !== 'readSsh'),
    [],
  );
  assert.deepEqual(transport.calls, []);
});

test('the run refuses to publish without a signature verifier', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths, verifySignature: undefined });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /signature verifier is required/u);
  assert.equal(result.lockState, 'not-acquired');
  assert.deepEqual(transport.calls, []);
  const entries = auditEntriesOf(input.auditOut);
  assert.equal(entries.at(-1).stage, 'fail');
});

test('a throwing local verifier stops the run before any remote call', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const seen = [];
  const input = commitInput(transport, {
    ...paths,
    verifySignature: () => {
      seen.push('called');
      throw new Error('release manifest signature is invalid');
    },
  });
  const result = await runCommit(input);
  assert.deepEqual(seen, ['called']);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'release manifest signature is invalid');
  assert.equal(result.lockState, 'not-acquired');
  assert.deepEqual(transport.calls, []);
  const entries = auditEntriesOf(input.auditOut);
  const preVerify = entries.find((entry) => entry.stage === 'pre-verify');
  assert.equal(preVerify.status, 'fail');
  assert.equal(preVerify.detail, 'release manifest signature is invalid');
  assert.equal(entries.at(-1).stage, 'fail');
});

test('a run without a temporary root fails before any remote write', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths, temporaryRoot: undefined });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /temporary root/u);
  assert.equal(result.lockState, 'not-acquired');
  assert.deepEqual(transport.calls, []);
  const entries = auditEntriesOf(input.auditOut);
  assert.equal(entries.at(-1).stage, 'fail');
});

test('a run without a public verifier fails before any remote write', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths, verifier: undefined });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /verifier is required/u);
  assert.equal(result.lockState, 'not-acquired');
  assert.deepEqual(transport.calls, []);
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'pending');
  const entries = auditEntriesOf(input.auditOut);
  assert.equal(entries.at(-1).stage, 'fail');
});

test('a clean publish walks every stage and releases its own lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'done', result.reason);
  assert.equal(result.lockState, 'released');
  assert.deepEqual(
    result.stages.map((entry) => entry.status),
    PUBLISH_STAGES.map(() => 'done'),
  );
});

test('the reveal stage reports that the version went live rather than that the run closed out', async () => {
  const livePaths = writeArtifacts();
  const live = happyTransport(livePaths);
  const liveInput = commitInput(live, { ...livePaths });
  const published = await runCommit(liveInput);
  assert.equal(published.outcome, 'done', published.reason);
  assert.equal(published.stages.find((entry) => entry.stage === 'reveal').status, 'done');

  const blockedPaths = writeArtifacts();
  const blocked = happyTransport(blockedPaths, { publicPackageBody: Buffer.from('other').toString('binary') });
  const blockedInput = commitInput(blocked, { ...blockedPaths });
  const indeterminate = await runCommit(blockedInput);
  assert.equal(indeterminate.outcome, 'incident');
  assert.equal(indeterminate.stages.find((entry) => entry.stage === 'reveal').status, 'pending');
  const entries = auditEntriesOf(blockedInput.auditOut);
  assert.ok(entries.some((entry) => entry.stage === 'public-verify' && entry.status === 'incident'));
  assert.ok(entries.some((entry) => entry.stage === 'incident' && entry.reason === indeterminate.reason));
  assert.equal(entries.at(-1).stage, 'lock-retained');
});

test('the version directory is committed with a single directory rename', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'done', result.reason);
  const renames = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && String(call[1]).startsWith('mv /opt/rongying/updates-state/staging/'),
  );
  assert.equal(renames.length, 1);
  const strayPartMoves = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && String(call[1]).includes('.part-') && !String(call[1]).includes('/staging/'),
  );
  assert.deepEqual(strayPartMoves, []);
});

test('the manifest is uploaded to the final directory and its remote digest is checked', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'done', result.reason);
  const uploads = transport.calls.filter(
    (call) => call[0] === 'sftpUpload' && String(call[1]).includes('manifest.json'),
  );
  assert.equal(uploads.length, 1);
  assert.match(String(uploads[0][2]), /\/internal\/manifest\.json\.r1\.tmp$/u);
});

test('a mismatched remote manifest digest stops before the flip', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { tempManifestSha: 'F'.repeat(64) });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
  const tempManifest = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'temp-manifest');
  assert.equal(tempManifest.manifestSha256, manifestShaOf(paths));
  assert.equal(tempManifest.remoteTempSha256, 'F'.repeat(64));
});

test('a manifest upload failure is an incident that keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { manifestUploadStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
  const tempManifest = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'temp-manifest');
  assert.equal(tempManifest.manifestSha256, manifestShaOf(paths));
  assert.equal('remoteTempSha256' in tempManifest, false);
});

test('a cas mismatch is an incident that keeps the lock and never rolls anything back', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { casDrift: true });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'cas').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
  const destructive = transport.calls.filter((call) => /rm -rf|mv -f.*manifest/u.test(String(call[1] ?? '')));
  assert.deepEqual(destructive, []);
});

test('a remote manifest digest that could not be read is an incident rather than a bypass', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { casDigestReadFails: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /could not be read/u);
  assert.doesNotMatch(result.reason, /which means a bypass/u);
  assert.equal(result.stages.find((entry) => entry.stage === 'cas').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'temp-manifest').status, 'pending');
  const cas = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'cas');
  assert.equal(cas.status, 'incident');
  assert.equal(cas.detail, 'the remote manifest digest could not be read');
  assert.equal(cas.previousManifestSha256, BASELINE_SHA);
  assert.equal(cas.observedManifestSha256, null);
});

test('a first publish proceeds when the manifest digest is absent on both reads', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { firstPublish: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'done', result.reason);
  assert.equal(result.lockState, 'released');
  const cas = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'cas');
  assert.equal(cas.status, 'done');
  assert.equal(cas.previousManifestSha256, 'absent');
  assert.equal(cas.observedManifestSha256, 'absent');
});

test('a manifest digest that cannot be read inside the lock stops the run before anything is committed', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { baselineDigestReadFails: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 're-verify').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
  const renames = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && String(call[1]).startsWith('mv /opt/rongying/updates-state/staging/'),
  );
  assert.deepEqual(renames, []);
  const reVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 're-verify');
  assert.equal(reVerify.status, 'incident');
  assert.equal(reVerify.detail, 'the manifest digest that the CAS baseline needs could not be read');
});

test('a remote temp manifest digest that could not be read is an incident rather than a mismatch', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { tempManifestReadStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /could not be read/u);
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
  const tempManifest = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'temp-manifest');
  assert.equal(tempManifest.detail, 'the uploaded manifest digest could not be read');
  assert.equal(tempManifest.manifestSha256, manifestShaOf(paths));
});

test('an indeterminate outcome with the old public sha allows a retry and keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { publicManifestBody: BASELINE_BODY });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'retry');
  assert.equal(result.lockState, 'retained-by-this-run');
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.status, 'retry');
  assert.equal(publicVerify.observedManifestSha256, BASELINE_SHA);
  assert.equal(publicVerify.previousManifestSha256, BASELINE_SHA);
  assert.equal(publicVerify.manifestSha256, manifestShaOf(paths));
});

test('an indeterminate outcome with a third public sha stops and keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { publicManifestBody: THIRD_BODY });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /third/u);
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.observedManifestSha256, THIRD_SHA);
  assert.equal(publicVerify.previousManifestSha256, BASELINE_SHA);
  assert.equal(publicVerify.manifestSha256, manifestShaOf(paths));
});

test('a staging failure is a plain failure and reports that no lock was acquired', async () => {
  const paths = writeArtifacts();
  const transport = commitTransport({ uploadStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'pending');
});

test('a failure after the lock but before the flip releases the lock this run owns', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { commitStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'released');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'done');
  const entries = auditEntriesOf(input.auditOut);
  assert.equal(entries.at(-2).stage, 'fail');
  assert.equal(entries.at(-2).reason, result.reason);
  assert.equal(entries.at(-1).stage, 'unlock');
  assert.ok(entries.every((entry) => entry.stage !== 'incident'));
});

test('the commit never runs when the lock already exists', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { lockState: 'exists' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
});

test('a staging directory and a final directory on different file systems stops the commit', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { sameFileSystem: false });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /file system/u);
  assert.equal(result.lockState, 'released');
});

test('an existing version directory that is empty is incomplete and refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'empty' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /incomplete/u);
});

test('an existing version directory with an extra entry is refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'extra' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /unexpected entry/u);
});

test('an existing version directory with a different size is refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'size' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /size/u);
});

test('an existing version directory with a different digest is refused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'digest' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /digest/u);
});

test('an existing version directory that matches every byte is reused', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { versionDirState: 'present' });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'done', result.reason);
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'done');
  assert.deepEqual(
    transport.calls.filter(
      (call) => call[0] === 'writeSsh' && String(call[1]).startsWith('mv /opt/rongying/updates-state/staging/'),
    ),
    [],
  );
});

test('every stage is appended to the audit log as it happens', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'done', result.reason);
  const stages = auditEntriesOf(input.auditOut).map((entry) => entry.stage);
  assert.equal(stages[0], 'open');
  assert.equal(stages[1], 'pre-verify');
  assert.ok(stages.includes('cas'));
  assert.ok(stages.includes('flip'));
  assert.ok(stages.includes('public-verify'));
  assert.ok(stages.includes('done'));
  assert.ok(stages.indexOf('done') < stages.indexOf('unlock'), 'the outcome entry is written before the unlock entry');
  assert.equal(stages.at(-1), 'unlock');
});

test('the audit log refuses to be written inside the repository', () => {
  const repositoryRoot = makeRoot();
  assert.throws(
    () => appendAuditStage({ auditOut: join(repositoryRoot, 'audit.jsonl'), entry: { stage: 'open' }, repositoryRoot }),
    FeedPublishError,
  );
});

test('the audit stage append refuses a missing repository root or an empty path', () => {
  const auditOut = join(makeRoot(), 'audit.jsonl');
  assert.throws(() => appendAuditStage({ auditOut, entry: { stage: 'open' } }), /repository root is required/u);
  assert.throws(
    () => appendAuditStage({ auditOut: '', entry: { stage: 'open' }, repositoryRoot: makeRoot() }),
    /non empty path/u,
  );
  assert.equal(existsSync(auditOut), false);
});

test('a failed audit write stops the run instead of publishing silently', async () => {
  const paths = writeArtifacts();
  const transport = commitTransport();
  const result = await runCommit(
    commitInput(transport, { ...paths, auditOut: join(makeRoot(), 'no-such-dir', 'audit.jsonl') }),
  );
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /audit/u);
});

test('the public verification checks the manifest, the signature and both artifacts', async () => {
  const paths = writeArtifacts();
  const calls = [];
  const result = await verifyPublicArtifacts({
    channel: 'internal',
    version: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifier: () => {},
    expectedManifestBytes: readFileSync(paths.manifestPath),
    expectedPackageSha256: PACKAGE_SHA256,
    expectedPackageSize: PACKAGE_BYTES.length,
    expectedFileManifestSha256: FILE_MANIFEST_SHA256,
    expectedFileManifestSize: FILE_MANIFEST_BYTES.length,
    temporaryRoot: makeRoot(),
    transport: {
      fetchPublic: async (url) => {
        calls.push(url);
        if (url.endsWith('manifest.json'))
          return { status: 200, bodyBytes: Uint8Array.from(readFileSync(paths.manifestPath)) };
        if (url.endsWith('portable.zip')) return { status: 200, bodyBytes: Uint8Array.from(PACKAGE_BYTES) };
        return { status: 200, bodyBytes: Uint8Array.from(FILE_MANIFEST_BYTES) };
      },
    },
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(calls.length, 3);
});

test('the public verification fails when the served package differs', async () => {
  const paths = writeArtifacts();
  const result = await verifyPublicArtifacts({
    channel: 'internal',
    version: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifier: () => {},
    expectedManifestBytes: readFileSync(paths.manifestPath),
    expectedPackageSha256: PACKAGE_SHA256,
    expectedPackageSize: PACKAGE_BYTES.length,
    expectedFileManifestSha256: FILE_MANIFEST_SHA256,
    expectedFileManifestSize: FILE_MANIFEST_BYTES.length,
    temporaryRoot: makeRoot(),
    transport: {
      fetchPublic: async (url) => {
        if (url.endsWith('manifest.json'))
          return { status: 200, bodyBytes: Uint8Array.from(readFileSync(paths.manifestPath)) };
        if (url.endsWith('portable.zip')) return { status: 200, bodyBytes: Uint8Array.from(Buffer.from('other')) };
        return { status: 200, bodyBytes: Uint8Array.from(FILE_MANIFEST_BYTES) };
      },
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /package/u);
});

function publicVerificationInput(fetches, overrides = {}) {
  const paths = writeArtifacts();
  return {
    channel: 'internal',
    version: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifier: () => {},
    expectedManifestBytes: readFileSync(paths.manifestPath),
    expectedPackageSha256: PACKAGE_SHA256,
    expectedPackageSize: PACKAGE_BYTES.length,
    expectedFileManifestSha256: FILE_MANIFEST_SHA256,
    expectedFileManifestSize: FILE_MANIFEST_BYTES.length,
    temporaryRoot: makeRoot(),
    transport: {
      fetchPublic: async (url) => {
        fetches.push(url);
        return { status: 200, bodyBytes: new Uint8Array() };
      },
    },
    ...overrides,
  };
}

test('the public verification refuses an unsafe channel or version before any fetch', async () => {
  const fetches = [];
  await assert.rejects(
    verifyPublicArtifacts(publicVerificationInput(fetches, { channel: 'internal/x' })),
    /not safe to interpolate/u,
  );
  await assert.rejects(
    verifyPublicArtifacts(publicVerificationInput(fetches, { version: '1.2.3;id' })),
    /not a strict semantic version/u,
  );
  assert.deepEqual(fetches, []);
});

test('the public verification refuses a missing temporary root or verifier before any fetch', async () => {
  const fetches = [];
  await assert.rejects(
    verifyPublicArtifacts(publicVerificationInput(fetches, { temporaryRoot: undefined })),
    /temporary root/u,
  );
  await assert.rejects(
    verifyPublicArtifacts(publicVerificationInput(fetches, { verifier: undefined })),
    /verifier is required/u,
  );
  assert.deepEqual(fetches, []);
});

test('a staging directory that cannot be created is a plain failure', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { stagingCreateStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'not-acquired');
  assert.match(result.reason, /staging directory could not be created/u);
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'pending');
});

test('the public verification is actually run after the flip', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { publicPackageBody: Buffer.from('other').toString('binary') });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /public package integrity/u);
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.detail, 'the public package integrity check failed');
  assert.equal(publicVerify.observedManifestSha256, manifestShaOf(paths));
});

test('a lock that fails for any reason other than an existing entry is an incident', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, {
    lockStatus: 1,
    lockStderr: 'mkdir: cannot create directory /opt/rongying/updates-state/lock: Permission denied',
  });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'ownership-unknown');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
  const removals = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && /(?:^|\s)(?:rm|rmdir) /u.test(String(call[1])),
  );
  assert.deepEqual(removals, []);
});

test('an owner record that cannot be re-read inside the lock window stops the run and touches nothing', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { ownerReadFailsAfterLock: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.match(result.reason, /could not be re-read/u);
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 're-verify').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
  const removals = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && /(?:^|\s)(?:rm|rmdir) /u.test(String(call[1])),
  );
  assert.deepEqual(removals, []);
  const entries = auditEntriesOf(input.auditOut);
  const reVerify = entries.find((entry) => entry.stage === 're-verify');
  assert.equal(reVerify.status, 'incident');
  assert.equal(reVerify.detail, 'the owner record could not be read');
  assert.equal(entries.at(-1).stage, 'lock-retained');
});

test('an owner write that fails after the lock is an incident that keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { ownerWriteStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'retained');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
  const entries = auditEntriesOf(input.auditOut);
  assert.equal(entries.at(-1).stage, 'lock-retained');
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
});

test('an owner record replaced before the unlock stops the run and deletes nothing', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { foreignOwnerAfterFlip: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'ownership-unknown');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'done');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'retained');
  const removals = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && /(?:^|\s)(?:rm|rmdir) /u.test(String(call[1])),
  );
  assert.deepEqual(removals, []);
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.some((entry) => entry.stage === 'unlock' && entry.status === 'retained'));
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
});

test('an owner record replaced inside the lock window stops the run and touches nothing', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { foreignOwnerFromReVerify: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'ownership-unknown');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'done');
  assert.equal(result.stages.find((entry) => entry.stage === 're-verify').status, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'pending');
  const removals = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && /(?:^|\s)(?:rm|rmdir) /u.test(String(call[1])),
  );
  assert.deepEqual(removals, []);
});

test('a lock that cannot be removed after a successful publish is not reported as released', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { lockRemovalStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.notEqual(result.lockState, 'released');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'retained');
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
});

test('a public verifier that rejects after the flip is an incident that keeps the lock', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, {
    ...paths,
    verifier: () => {
      throw new Error('release manifest signature is invalid');
    },
  });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /signature is invalid/u);
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
  const publicVerify = entries.find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.manifestSha256, manifestShaOf(paths));
  assert.equal(publicVerify.observedManifestSha256, manifestShaOf(paths));
  assert.equal(publicVerify.previousManifestSha256, BASELINE_SHA);
});

test('every early failure records its outcome in the audit log before it returns', async () => {
  const paths = writeArtifacts();
  const fixtures = [
    {
      stage: 'pre-verify',
      transport: commitTransport(),
      overrides: { packagePath: join(makeRoot(), 'missing.zip') },
      outcome: 'fail',
    },
    { stage: 'stage', transport: commitTransport({ uploadStatus: 1 }), overrides: {}, outcome: 'fail' },
    {
      stage: 'remote-verify',
      transport: commitTransport({ stagingListing: `f ${PORTABLE_PACKAGE_NAME} 1\n` }),
      overrides: {},
      outcome: 'fail',
    },
    {
      stage: 'lock',
      transport: happyTransport(paths, { lockState: 'exists' }),
      overrides: { ...paths },
      outcome: 'blocked',
    },
  ];
  for (const fixture of fixtures) {
    const input = commitInput(fixture.transport, fixture.overrides);
    const result = await runCommit(input);
    assert.equal(result.outcome, fixture.outcome, fixture.stage);
    if (fixture.stage === 'pre-verify') {
      assert.deepEqual(fixture.transport.calls, []);
    } else {
      assertEveryCommitCallCarriesTheTrustAnchor(fixture.transport);
    }
    const entries = auditEntriesOf(input.auditOut);
    assert.equal(entries.at(-1).stage, fixture.outcome, fixture.stage);
    assert.equal(entries.at(-1).runid, 'r1', fixture.stage);
    assert.equal(typeof entries.at(-1).reason, 'string', fixture.stage);
  }
});

test('a channel that could escape its remote path is refused before any remote write', async () => {
  const paths = writeArtifacts({
    manifestOverrides: { channel: 'internal/x', packageUrl: `${PUBLIC_BASE_URL}/internal/x/1.2.3/portable.zip` },
  });
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths, channel: 'internal/x' }));
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(transport.calls, []);
});

test('a version that could escape its remote path is refused before any remote write', async () => {
  const paths = writeArtifacts({
    manifestOverrides: { version: '1.2.3;id', packageUrl: `${PUBLIC_BASE_URL}/internal/1.2.3;id/portable.zip` },
  });
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths, version: '1.2.3;id' }));
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(transport.calls, []);
});

test('a run id that could escape its remote path is refused before any remote write', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths, runid: 'r1; id' }));
  assert.equal(result.outcome, 'fail');
  assert.deepEqual(transport.calls, []);
});

test('a sibling whose name begins with two dots is still inside the repository', () => {
  const root = process.cwd();
  assert.throws(
    () => assertKnownHostsPath(join(root, '..foo', 'known_hosts'), root),
    /must live outside the repository/u,
  );
  assert.throws(
    () =>
      appendAuditStage({
        auditOut: join(root, '..foo', 'audit.jsonl'),
        entry: { stage: 'open' },
        repositoryRoot: root,
      }),
    /must live outside the repository/u,
  );
});

test('the real release verifier accepts a canonically signed manifest and rejects an insertion ordered one', async () => {
  const canonicalFileManifest = {
    files: [{ path: 'a.txt', sha256: 'a'.repeat(64), size: 1 }],
    schemaVersion: 1,
    version: '1.2.3',
  };
  const fileManifestBytes = Buffer.from(JSON.stringify(canonicalFileManifest), 'utf8');
  const packageRoot = makeRoot();
  const packagePath = join(packageRoot, PORTABLE_PACKAGE_NAME);
  writeFileSync(packagePath, PACKAGE_BYTES);
  const built = await buildPortableRelease({
    baseUrl: PUBLIC_BASE_URL,
    channel: 'internal',
    version: '1.2.3',
    minLauncherVersion: '1.0.0',
    publishedAt: '2026-09-22T00:00:00.000Z',
    signingKeyPem: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyBase64: PUBLIC_KEY_BASE64,
    packagePath,
    fileManifest: canonicalFileManifest,
    fileManifestBytes,
  });
  assert.equal(
    createHash('sha256').update(built.fileManifestBytes).digest('hex'),
    createHash('sha256').update(fileManifestBytes).digest('hex'),
  );

  const serving = (manifestBytes, packageBytes) => ({
    fetchPublic: async (url) => {
      if (url.endsWith('manifest.json')) return { status: 200, bodyBytes: Uint8Array.from(manifestBytes) };
      if (url.endsWith('portable.zip')) return { status: 200, bodyBytes: Uint8Array.from(packageBytes) };
      return { status: 200, bodyBytes: Uint8Array.from(fileManifestBytes) };
    },
  });
  const publicInput = (manifestBytes, packageBytes, expectedManifestBytes) => ({
    channel: 'internal',
    version: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifier: verifyPortableRelease,
    expectedManifestBytes,
    expectedPackageSha256: createHash('sha256').update(packageBytes).digest('hex'),
    expectedPackageSize: packageBytes.length,
    expectedFileManifestSha256: createHash('sha256').update(fileManifestBytes).digest('hex'),
    expectedFileManifestSize: fileManifestBytes.length,
    temporaryRoot: makeRoot(),
    transport: serving(manifestBytes, packageBytes),
  });

  const accepted = await verifyPublicArtifacts(publicInput(built.manifestBytes, PACKAGE_BYTES, built.manifestBytes));
  assert.equal(accepted.ok, true, accepted.reason);

  const insertionOrdered = signedManifest();
  await assert.rejects(
    verifyPublicArtifacts(publicInput(insertionOrdered, PACKAGE_BYTES, insertionOrdered)),
    /release manifest signature is invalid/u,
  );
});

test('an owner record replaced before the unlock on the failure path stops the run and deletes nothing', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { commitStatus: 1, foreignOwnerAfterCommit: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'the version directory was not committed');
  assert.equal(result.lockState, 'ownership-unknown');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'fail');
  assert.equal(result.stages.find((entry) => entry.stage === 'unlock').status, 'retained');
  const removals = transport.calls.filter(
    (call) => call[0] === 'writeSsh' && /(?:^|\s)(?:rm|rmdir) /u.test(String(call[1])),
  );
  assert.deepEqual(removals, []);
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.some((entry) => entry.stage === 'unlock' && entry.status === 'retained'));
  assert.ok(entries.every((entry) => entry.stage !== 'unlock' || entry.status !== 'done'));
});

test('the channel precondition refuses an empty channel by its own reason before any remote write', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const result = await runCommit(commitInput(transport, { ...paths, channel: '' }));
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'the channel is empty, so it cannot be interpolated into a remote path');
  assert.deepEqual(transport.calls, []);
});

test('a staging entry that is not a regular file is refused', async () => {
  const paths = writeArtifacts();
  const stagingListing = `d ${PORTABLE_PACKAGE_NAME} ${PACKAGE_BYTES.length}\nf ${PORTABLE_FILE_MANIFEST_NAME} ${FILE_MANIFEST_BYTES.length}\n`;
  const transport = happyTransport(paths, { stagingListing });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /is not a regular file/u);
  const remoteVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'remote-verify');
  assert.equal(remoteVerify.status, 'fail');
  assert.match(remoteVerify.detail, /is not a regular file/u);
  assert.equal(remoteVerify.remote.entries[0].type, 'd');
  assert.equal(remoteVerify.remote.digests, null);
});

test('a staging listing that failed is reported as an empty directory rather than parsed', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { listingStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.reason, 'the staging directory is not the exact final file set: the staging directory is empty');
});

test('a presence probe that failed is not read as a present directory', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { directoryProbeStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'not-acquired');
  assert.equal(result.stages.find((entry) => entry.stage === 'remote-verify').status, 'fail');
  assert.equal(result.stages.find((entry) => entry.stage === 'lock').status, 'pending');
});

test('a digest read that failed stops the run instead of throwing out of the commit', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { digestStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(
    result.reason,
    'the staging directory is not the exact final file set: the remote digests could not be read',
  );
});

test('a remote manifest whose digest could not be read is logged as absent rather than as a blank', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { baselineDigestAbsent: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.stages.find((entry) => entry.stage === 'cas').status, 'incident');
  const cas = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'cas');
  assert.equal(cas.previousManifestSha256, 'absent');
  assert.equal(cas.observedManifestSha256, BASELINE_SHA);
});

test('a device probe that failed stops the commit even when it printed matching numbers', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { deviceProbeStatus: 1 });
  const result = await runCommit(commitInput(transport, { ...paths }));
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.match(result.reason, /file system/u);
  assert.equal(result.lockState, 'released');
  assert.equal(result.stages.find((entry) => entry.stage === 'commit-version').status, 'fail');
});

test('a public manifest response without body bytes is an incident rather than a crash', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { manifestBodyMissing: true });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /public manifest could not be read/u);
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.equal(publicVerify.manifestSha256, manifestShaOf(paths));
});

test('the audit log carries the operator, the run time and the local digests and sizes', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const entries = auditEntriesOf(input.auditOut);
  for (const entry of entries) {
    assert.equal(entry.operator, 'ops', entry.stage);
    assert.equal(entry.at, '2026-09-22T00:00:00.000Z', entry.stage);
  }
  const preVerify = entries.find((entry) => entry.stage === 'pre-verify');
  assert.deepEqual(preVerify.local, {
    packageSha256: PACKAGE_SHA256,
    packageSize: PACKAGE_BYTES.length,
    fileManifestSha256: FILE_MANIFEST_SHA256,
    fileManifestSize: FILE_MANIFEST_BYTES.length,
    manifestSha256: manifestShaOf(paths),
    manifestSize: readFileSync(paths.manifestPath).length,
  });
});

test('the audit log carries the entries and digests the staging directory reported', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const remoteVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'remote-verify');
  assert.equal(remoteVerify.status, 'done');
  assert.equal(remoteVerify.remote.present, true);
  assert.equal(remoteVerify.remote.empty, false);
  assert.deepEqual(remoteVerify.remote.entries, [
    { type: 'f', name: PORTABLE_PACKAGE_NAME, size: PACKAGE_BYTES.length },
    { type: 'f', name: PORTABLE_FILE_MANIFEST_NAME, size: FILE_MANIFEST_BYTES.length },
  ]);
  assert.deepEqual(remoteVerify.remote.digests, {
    [PORTABLE_PACKAGE_NAME]: PACKAGE_SHA256,
    [PORTABLE_FILE_MANIFEST_NAME]: FILE_MANIFEST_SHA256,
  });
});

test('the audit log carries the previous manifest digest and the backup path', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const entries = auditEntriesOf(input.auditOut);
  const backup = entries.find((entry) => entry.stage === 'backup-manifest');
  assert.equal(backup.previousManifestSha256, BASELINE_SHA);
  assert.equal(backup.backupPath, `${STATE_ROOT}/backup/internal-manifest.json-pre-1.2.3`);
  const cas = entries.find((entry) => entry.stage === 'cas');
  assert.equal(cas.previousManifestSha256, BASELINE_SHA);
  assert.equal(cas.observedManifestSha256, BASELINE_SHA);
});

test('the audit log carries the new manifest digest at the temp manifest, the flip and the outcome', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const manifestSha = manifestShaOf(paths);
  const entries = auditEntriesOf(input.auditOut);
  const tempManifest = entries.find((entry) => entry.stage === 'temp-manifest');
  assert.equal(tempManifest.manifestSha256, manifestSha);
  assert.equal(tempManifest.remoteTempSha256, manifestSha);
  assert.equal(entries.find((entry) => entry.stage === 'flip').manifestSha256, manifestSha);
  assert.equal(entries.find((entry) => entry.stage === 'done').manifestSha256, manifestSha);
});

test('the audit log carries the public digests and sizes the verification compared', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const publicVerify = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'public-verify');
  assert.deepEqual(publicVerify.public, {
    ok: true,
    manifestSha256: manifestShaOf(paths),
    packageSha256: PACKAGE_SHA256,
    packageSize: PACKAGE_BYTES.length,
    fileManifestSha256: FILE_MANIFEST_SHA256,
    fileManifestSize: FILE_MANIFEST_BYTES.length,
  });
});

test('the audit log takes each entry time from the injected clock rather than the run start', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const ticks = ['2026-09-22T00:00:01.000Z', '2026-09-22T00:00:02.000Z', '2026-09-22T00:00:03.000Z'];
  let taken = 0;
  const input = commitInput(transport, { ...paths, now: () => ticks[Math.min(taken++, ticks.length - 1)] });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'done', result.reason);
  const entries = auditEntriesOf(input.auditOut);
  assert.equal(entries[0].at, ticks[0]);
  assert.equal(entries[1].at, ticks[1]);
  assert.equal(entries[2].at, ticks[2]);
  assert.equal(entries.at(-1).at, ticks[2]);
});

test('the audit log keeps the operator and the time as null instead of dropping them', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths);
  const input = commitInput(transport, { ...paths, operator: undefined, startedAt: undefined });
  const result = await runCommit(input);
  assert.equal(result.outcome, 'fail', result.reason);
  assert.match(result.reason, /operator/u);
  assert.equal(result.lockState, 'not-acquired');
  assert.deepEqual(transport.calls, []);
  const entries = auditEntriesOf(input.auditOut);
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    assert.equal(entry.operator, null, entry.stage);
    assert.equal(entry.at, null, entry.stage);
  }
  assert.equal(entries.at(-1).stage, 'fail');
});

test('a staging directory that cannot be finalised is a plain failure', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { finaliseStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'fail');
  assert.equal(result.lockState, 'not-acquired');
  assert.match(result.reason, /staging directory could not be finalised/u);
  assert.equal(result.stages.find((entry) => entry.stage === 'stage').status, 'fail');
});

test('a manifest backup that fails is an incident that keeps the lock before anything is flipped', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { backupStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.match(result.reason, /previous manifest could not be backed up/u);
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'pending');
  assert.deepEqual(
    transport.calls.filter((call) => call[0] === 'writeSsh' && /^mv -f \S+\.tmp \S+$/u.test(String(call[1]))),
    [],
  );
});

test('an atomic flip that failed is an incident that records the manifest digest', async () => {
  const paths = writeArtifacts();
  const transport = happyTransport(paths, { flipStatus: 1 });
  const input = commitInput(transport, { ...paths });
  const result = await runCommit(input);
  assertEveryCommitCallCarriesTheTrustAnchor(transport);
  assert.equal(result.outcome, 'incident');
  assert.equal(result.lockState, 'retained-by-this-run');
  assert.equal(result.stages.find((entry) => entry.stage === 'flip').status, 'incident');
  const flip = auditEntriesOf(input.auditOut).find((entry) => entry.stage === 'flip');
  assert.equal(flip.manifestSha256, manifestShaOf(paths));
});

test('the audit evidence refuses a key that would override the entry it is attached to', () => {
  for (const key of ['stage', 'status', 'reason', 'detail', 'runid', 'planHash', 'operator', 'at']) {
    assert.throws(
      () => assertNoReservedEvidenceKeys({ [key]: 'x' }),
      new RegExp(`reserved key\\(s\\) ${key}`, 'u'),
      key,
    );
  }
  assert.doesNotThrow(() => assertNoReservedEvidenceKeys(undefined));
  assert.doesNotThrow(() => assertNoReservedEvidenceKeys({ manifestSha256: 'x', remoteTempSha256: 'y' }));
});

test('the stable manifest is re-signed with the stable channel and the stable url', () => {
  const input = buildStableManifestInput({
    version: '1.2.3',
    minLauncherVersion: '1.0.0',
    fileManifest: FILE_MANIFEST,
    fileManifestBytes: FILE_MANIFEST_BYTES,
    packagePath: '/outside/portable.zip',
    publishedAt: '2026-09-22T00:00:00.000Z',
  });
  assert.equal(input.channel, 'stable');
  assert.equal(input.baseUrl, PUBLIC_BASE_URL);
  assert.equal(input.version, '1.2.3');
  assert.equal(input.fileManifestBytes, FILE_MANIFEST_BYTES);
  assert.equal(input.packagePath, '/outside/portable.zip');
});

test('the stable input refuses to reuse an internal manifest', () => {
  const reuse = () =>
    buildStableManifestInput({
      version: '1.2.3',
      minLauncherVersion: '1.0.0',
      fileManifest: FILE_MANIFEST,
      fileManifestBytes: FILE_MANIFEST_BYTES,
      packagePath: '/outside/portable.zip',
      publishedAt: '2026-09-22T00:00:00.000Z',
      manifestBytes: Buffer.from('reuse-me'),
    });
  assert.throws(reuse, FeedPublishError);
  assert.throws(reuse, /must be signed on its own/u);
});

test('the stable input carries every field it was given instead of a default', () => {
  for (const arm of [
    { version: '2.3.4', minLauncherVersion: '9.1.0', publishedAt: '2026-01-02T03:04:05.000Z' },
    { version: '3.4.5', minLauncherVersion: '9.2.0', publishedAt: '2026-02-03T04:05:06.000Z' },
  ]) {
    const fileManifest = { ...FILE_MANIFEST, version: arm.version };
    const fileManifestBytes = Buffer.from(`stable-files-${arm.version}`, 'utf8');
    const input = buildStableManifestInput({
      version: arm.version,
      minLauncherVersion: arm.minLauncherVersion,
      fileManifest,
      fileManifestBytes,
      packagePath: '/outside/portable.zip',
      publishedAt: arm.publishedAt,
    });
    assert.equal(input.version, arm.version);
    assert.equal(input.minLauncherVersion, arm.minLauncherVersion);
    assert.equal(input.publishedAt, arm.publishedAt);
    assert.deepEqual(input.fileManifest, fileManifest);
    assert.ok(input.fileManifestBytes.equals(fileManifestBytes));
    assert.equal(input.packagePath, '/outside/portable.zip');
  }
});

test('the reused manifest guard is exported and keeps the module error class', () => {
  assert.equal(typeof assertNotReusedManifest, 'function');
  assert.throws(() => assertNotReusedManifest({ manifestBytes: Buffer.from('reuse-me') }), FeedPublishError);
  assert.throws(
    () => assertNotReusedManifest({ manifestBytes: undefined }),
    (error) => error instanceof FeedPublishError && /manifestBytes with no value/u.test(error.message),
  );
  assert.doesNotThrow(() => assertNotReusedManifest({ fileManifest: FILE_MANIFEST }));
});

test('the stable input feeds the real release builder the stable channel and the original bytes', async () => {
  const canonicalFileManifest = {
    files: [{ path: 'a.txt', sha256: 'a'.repeat(64), size: 1 }],
    schemaVersion: 1,
    version: '1.2.3',
  };
  const fileManifestBytes = Buffer.from(JSON.stringify(canonicalFileManifest), 'utf8');
  const packageRoot = makeRoot();
  const packagePath = join(packageRoot, PORTABLE_PACKAGE_NAME);
  writeFileSync(packagePath, PACKAGE_BYTES);
  const release = await buildPortableRelease({
    ...buildStableManifestInput({
      version: '1.2.3',
      minLauncherVersion: '1.0.0',
      fileManifest: canonicalFileManifest,
      fileManifestBytes,
      packagePath,
      publishedAt: '2026-09-22T00:00:00.000Z',
    }),
    signingKeyPem: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyBase64: PUBLIC_KEY_BASE64,
  });
  const manifest = JSON.parse(release.manifestBytes.toString('utf8'));
  assert.equal(manifest.channel, 'stable');
  assert.equal(manifest.packageUrl, 'https://api.rongyinghudong.com/updates/stable/1.2.3/portable.zip');
  assert.equal(manifest.fileManifestSha256, createHash('sha256').update(fileManifestBytes).digest('hex'));
  assert.equal(release.fileManifestBytes.equals(fileManifestBytes), true);
});

test('the local verification hands back the file manifest bytes it verified', async () => {
  const paths = writeArtifacts();
  const verified = await verifyLocalArtifacts({
    ...paths,
    expectedChannel: 'internal',
    expectedVersion: '1.2.3',
    publicKeyBase64: PUBLIC_KEY_BASE64,
    verifySignature: () => {},
  });
  assert.ok(Buffer.isBuffer(verified.fileManifestBytes));
  assert.ok(verified.fileManifestBytes.equals(FILE_MANIFEST_BYTES));
  assert.equal(createHash('sha256').update(verified.fileManifestBytes).digest('hex'), verified.fileManifestSha256);
});

function identityTaggedTransport(handlers = {}) {
  const calls = [];
  const respond = (face) => async (request) => {
    calls.push({ face, request });
    return handlers[face] ? handlers[face](request) : { status: 0, stdout: '', stderr: '' };
  };
  return {
    calls,
    readOnly: { sshRun: respond('readOnly.sshRun') },
    write: { sshRun: respond('write.sshRun'), sftpUpload: respond('write.sftpUpload') },
    fetchPublic: async (url) => {
      calls.push({ face: 'fetchPublic', request: { url } });
      return { status: 200, bodyBytes: new Uint8Array() };
    },
  };
}

test('the preflight read only promise is pinned by transport identity rather than by a shared tag', async () => {
  const transport = identityTaggedTransport({
    'readOnly.sshRun': () => ({ status: 0, stdout: '100\n100\n', stderr: '' }),
  });
  const result = await runPreflight({
    channel: 'internal',
    version: '1.2.3',
    transport,
    host: HOST,
    knownHostsPath: KNOWN_HOSTS_PATH,
  });
  assert.equal(result.sameFileSystem, true);
  assert.equal(result.writabilityIndicators.verifiedWrite, false);
  assert.ok(transport.calls.length > 0, 'the identity pin needs at least one recorded call');
  assert.deepEqual([...new Set(transport.calls.map((call) => call.face))], ['readOnly.sshRun']);
});

test('a known hosts path that carries whitespace is accepted by the input and by the guard', () => {
  const spaced = join(tmpdir(), 'known hosts');
  const input = parsePublishInput({
    channel: 'internal',
    version: '1.2.3',
    needsNetwork: true,
    host: 'h',
    knownHostsPath: spaced,
  });
  assert.equal(input.knownHostsPath, resolve(spaced));
  assert.equal(assertKnownHostsPath(spaced, process.cwd()), spaced);
});

test('a host that carries a control character is rejected by the same class the transport uses', () => {
  assert.throws(
    () =>
      parsePublishInput({
        channel: 'internal',
        version: '1.2.3',
        needsNetwork: true,
        host: 'bad\u0001host',
        knownHostsPath: '/tmp/known_hosts',
      }),
    /must not start with a dash or contain whitespace/u,
  );
});
