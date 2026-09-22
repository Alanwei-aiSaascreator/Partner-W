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
