import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cli = join(repositoryRoot, 'scripts', 'feed-publish.mjs');

function runCli(args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('the cli prints usage when no mode is given', () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /--dry-run/u);
  assert.match(result.stdout, /--preflight/u);
  assert.match(result.stdout, /--commit/u);
  assert.match(result.stdout, /--break-lock/u);
  assert.match(result.stdout, /--re-sign-stable/u);
});

test('the cli refuses a stable re-sign without a version, an output path or a stable channel', () => {
  const base = [
    '--re-sign-stable',
    '--channel',
    'stable',
    '--version',
    '1.2.3',
    '--package',
    'portable.zip',
    '--file-manifest',
    'portable-files.json',
    '--manifest',
    'manifest.json',
  ];
  assert.match(runCli(['--re-sign-stable', '--channel', 'stable']).stderr, /--version is required/u);
  assert.match(
    runCli(['--re-sign-stable', '--channel', 'internal', '--version', '1.2.3']).stderr,
    /--re-sign-stable requires --channel stable/u,
  );
  assert.match(runCli(base).stderr, /--stable-out is required/u);
});

test('the cli rejects an unknown channel before touching anything', () => {
  const result = runCli(['--dry-run', '--channel', 'beta', '--version', '1.2.3']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /channel must be one of/u);
});

test('the cli refuses a network mode without a host or known hosts file', () => {
  const result = runCli(['--preflight', '--channel', 'internal', '--version', '1.2.3']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ssh host|known hosts/u);
});

test('the cli refuses a commit without an audit log path', () => {
  const result = runCli([
    '--commit',
    '--channel',
    'internal',
    '--version',
    '1.2.3',
    '--host',
    'h.invalid',
    '--known-hosts',
    'k',
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--audit-out is required/u);
});

test('the cli refuses a known hosts file inside the repository', () => {
  const result = runCli([
    '--preflight',
    '--channel',
    'internal',
    '--version',
    '1.2.3',
    '--host',
    'h.invalid',
    '--known-hosts',
    join(repositoryRoot, 'known_hosts'),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /outside the repository/u);
});

test('the cli refuses a break lock without a reason, an audit log or a confirmation', () => {
  const base = [
    '--break-lock',
    '--channel',
    'internal',
    '--version',
    '1.2.3',
    '--host',
    'h.invalid',
    '--known-hosts',
    '/outside/known_hosts',
  ];
  assert.match(runCli(base).stderr, /--reason is required/u);
  assert.match(runCli([...base, '--reason', 'stopped']).stderr, /--audit-out is required/u);
  assert.match(
    runCli([...base, '--reason', 'stopped', '--audit-out', 'x.jsonl']).stderr,
    /--confirm-runid is required/u,
  );
});

import * as cliModule from './feed-publish-cli.mjs';
import * as releaseModule from './portable-update-release.mjs';
import * as cryptoModule from 'node:crypto';
import * as fsModule from 'node:fs';
import * as osModule from 'node:os';
import { afterEach } from 'node:test';

const cliRoots = [];
afterEach(() => {
  for (const root of cliRoots.splice(0)) fsModule.rmSync(root, { recursive: true, force: true });
});

function makeCliRoot() {
  const root = fsModule.mkdtempSync(join(osModule.tmpdir(), 'partner-w-cli-'));
  cliRoots.push(root);
  return root;
}

const cliKeyPair = cryptoModule.generateKeyPairSync('ed25519');
const CLI_PUBLIC_KEY_BASE64 = cliKeyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const CLI_PACKAGE_BYTES = Buffer.from('portable-zip-bytes', 'utf8');
const FOREIGN_OWNER_RECORD = {
  runid: 'r0',
  operator: 'ops',
  startedAt: '2026-09-22T00:00:00.000Z',
  planHash: 'p0',
  machine: 'builder-01',
};
const OUTSIDE_KNOWN_HOSTS = resolve(osModule.tmpdir(), 'known_hosts');

async function writeSignedTriple({ minLauncherVersion = '1.0.0' } = {}) {
  const root = makeCliRoot();
  const packagePath = join(root, 'portable.zip');
  const fileManifestPath = join(root, 'portable-files.json');
  const manifestPath = join(root, 'manifest.json');
  fsModule.writeFileSync(packagePath, CLI_PACKAGE_BYTES);
  const fileManifest = {
    files: [{ path: 'a.txt', sha256: 'a'.repeat(64), size: 1 }],
    schemaVersion: 1,
    version: '1.2.3',
  };
  const release = await releaseModule.buildPortableRelease({
    baseUrl: 'https://api.rongyinghudong.com/updates',
    channel: 'internal',
    version: '1.2.3',
    minLauncherVersion,
    publishedAt: '2026-09-22T00:00:00.000Z',
    signingKeyPem: cliKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyBase64: CLI_PUBLIC_KEY_BASE64,
    packagePath,
    fileManifest,
    fileManifestBytes: Buffer.from(JSON.stringify(fileManifest), 'utf8'),
  });
  fsModule.writeFileSync(fileManifestPath, release.fileManifestBytes);
  fsModule.writeFileSync(manifestPath, release.manifestBytes);
  return { packagePath, fileManifestPath, manifestPath, manifestBytes: release.manifestBytes };
}

function makeHarness(handlers) {
  const calls = [];
  const factoryInputs = [];
  const createTransport = (input) => {
    factoryInputs.push(input);
    handlers.onFactory(input);
    return {
      readOnly: {
        sshRun: async (request) => {
          calls.push(['readOnly.sshRun', request.script]);
          return handlers.readSsh(request);
        },
      },
      write: {
        sshRun: async (request) => {
          calls.push(['write.sshRun', request.script]);
          return handlers.writeSsh(request);
        },
        sftpUpload: async (request) => {
          calls.push(['write.sftpUpload', request.remotePath]);
          return handlers.sftpUpload(request);
        },
      },
      fetchPublic: async (url) => {
        calls.push(['fetchPublic', url]);
        return handlers.fetchPublic(url);
      },
    };
  };
  return { createTransport, calls, factoryInputs };
}

const okRead = () => ({ status: 0, stdout: '', stderr: '' });
const okWrite = () => ({ status: 0, stdout: '', stderr: '' });
const okUpload = () => ({ status: 0, stdout: '', stderr: '' });
const okFetch = () => ({ status: 200, bodyBytes: new Uint8Array() });

const removeSemantics = (ownerRecordAbsent) => {
  return (request) => {
    const removal = /^(rm -f|rm) (\S+)$/u.exec(String(request.script ?? ''));
    if (removal === null || removal[1] === 'rm -f' || ownerRecordAbsent !== true) return okWrite();
    return { status: 1, stdout: '', stderr: `rm: cannot remove '${removal[2]}': No such file or directory` };
  };
};

const refuseConstruction = () => {
  throw new Error('the transport must not be built for this run');
};

function makeCountingRefusal() {
  let constructions = 0;
  const createTransport = () => {
    constructions += 1;
    throw new Error('the transport must not be built for this run');
  };
  return { createTransport, constructions: () => constructions };
}

function auditEntriesOf(path) {
  return fsModule
    .readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function printedObject(stdout) {
  return JSON.parse(stdout.slice(0, stdout.lastIndexOf('\n}') + 2));
}

async function captureRun(argv, dependencies) {
  const out = [];
  const err = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args) => {
    out.push(`${args.map(String).join(' ')}\n`);
  };
  console.error = (...args) => {
    err.push(`${args.map(String).join(' ')}\n`);
  };
  try {
    const code = await cliModule.runCli(argv, dependencies);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

async function withEnvironment(name, value, body) {
  const previous = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

function networkArgs(mode, extra) {
  return [
    mode,
    '--channel',
    'internal',
    '--version',
    '1.2.3',
    '--host',
    'updates.example.invalid',
    '--known-hosts',
    OUTSIDE_KNOWN_HOSTS,
    ...extra,
  ];
}

function offlineArgs(mode, triple, extra) {
  return [
    mode,
    '--channel',
    'internal',
    '--version',
    '1.2.3',
    '--package',
    triple.packagePath,
    '--file-manifest',
    triple.fileManifestPath,
    '--manifest',
    triple.manifestPath,
    ...extra,
  ];
}

test('the dry run prints the plan for a canonically signed triple', async () => {
  const triple = await writeSignedTriple();
  const factory = makeCountingRefusal();
  const result = await withEnvironment('PARTNERW_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    captureRun(offlineArgs('--dry-run', triple, []), { createTransport: factory.createTransport }),
  );
  assert.equal(result.code, 0);
  assert.equal(factory.constructions(), 0, 'an offline mode must not build a transport at all');
  const printed = printedObject(result.stdout);
  assert.equal(printed.mode, 'dry-run');
  assert.equal(printed.channel, 'internal');
  assert.equal(printed.version, '1.2.3');
  assert.equal(printed.plan.length, 13);
  assert.equal(printed.plan[0].stage, 'pre-verify');
});

test('the dry run prints the local digests, the target paths and the verified plan hash', async () => {
  const triple = await writeSignedTriple();
  const factory = makeCountingRefusal();
  const result = await withEnvironment('PARTNERW_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    captureRun(offlineArgs('--dry-run', triple, []), { createTransport: factory.createTransport }),
  );
  assert.equal(result.code, 0);
  assert.equal(factory.constructions(), 0);
  const printed = printedObject(result.stdout);
  const sha256Of = (bytes) => cryptoModule.createHash('sha256').update(bytes).digest('hex');
  assert.equal(printed.local.packageSha256, sha256Of(CLI_PACKAGE_BYTES));
  assert.equal(printed.local.packageSize, CLI_PACKAGE_BYTES.length);
  assert.equal(printed.local.fileManifestSha256, sha256Of(fsModule.readFileSync(triple.fileManifestPath)));
  assert.equal(printed.local.fileManifestSize, fsModule.readFileSync(triple.fileManifestPath).length);
  assert.equal(printed.local.manifestSha256, sha256Of(triple.manifestBytes));
  assert.equal(printed.local.manifestSize, triple.manifestBytes.length);
  assert.equal(printed.local.packageUrl, 'https://api.rongyinghudong.com/updates/internal/1.2.3/portable.zip');
  assert.equal(printed.targets.versionRoot, '/opt/partner-w/updates/internal/1.2.3');
  assert.equal(printed.targets.stagingRoot, `/opt/partner-w/updates-state/staging/internal/1.2.3/${printed.planHash}`);
  assert.deepEqual(printed.targets.stagingParts, [
    `${printed.targets.stagingRoot}/portable.zip.part`,
    `${printed.targets.stagingRoot}/portable-files.json.part`,
  ]);
  assert.equal(printed.targets.channelManifest, '/opt/partner-w/updates/internal/manifest.json');
  assert.equal(printed.targets.tempManifest, `/opt/partner-w/updates/internal/manifest.json.${printed.runid}.tmp`);
  assert.equal(printed.planHash.length, 64);
  assert.equal(printed.plan.length, 13);
});

test('the dry run refuses a triple whose manifest signature was corrupted and prints no plan', async () => {
  const triple = await writeSignedTriple();
  const parsed = JSON.parse(triple.manifestBytes.toString('utf8'));
  const flipped = parsed.signature[0] === 'A' ? 'B' : 'A';
  const corrupted = { ...parsed, signature: `${flipped}${parsed.signature.slice(1)}` };
  fsModule.writeFileSync(triple.manifestPath, Buffer.from(JSON.stringify(corrupted), 'utf8'));
  const factory = makeCountingRefusal();
  const result = await withEnvironment('PARTNERW_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    captureRun(offlineArgs('--dry-run', triple, []), { createTransport: factory.createTransport }),
  );
  assert.equal(result.code, 1);
  assert.equal(factory.constructions(), 0, 'a refused plan must not build a transport either');
  assert.match(result.stderr, /release manifest signature is invalid/u);
  assert.equal(result.stdout.includes('"plan"'), false, 'the plan must not be printed when the gate refuses');
  assert.equal(result.stdout.includes('"stage"'), false);
});

test('the dry run refuses to run without the public key in the environment', async () => {
  const triple = await writeSignedTriple();
  const factory = makeCountingRefusal();
  const result = await withEnvironment('PARTNERW_UPDATE_PUBLIC_KEY_B64', '', () =>
    captureRun(offlineArgs('--dry-run', triple, []), { createTransport: factory.createTransport }),
  );
  assert.equal(result.code, 1);
  assert.equal(factory.constructions(), 0, 'a refused plan must not build a transport either');
  assert.match(result.stderr, /PARTNERW_UPDATE_PUBLIC_KEY_B64 is required/u);
  assert.equal(result.stdout.includes('"plan"'), false);
});

test('a preflight writes one session entry that carries the time it ran', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: (request) =>
      request.script.startsWith('stat -c ')
        ? { status: 0, stdout: '100\n100\n', stderr: '' }
        : { status: 0, stdout: 'directory root root 755 100\n', stderr: '' },
    writeSsh: okWrite,
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await withEnvironment('PARTNERW_FEED_OPERATOR', 'tester', () =>
    captureRun(networkArgs('--preflight', ['--audit-out', auditOut]), { createTransport: harness.createTransport }),
  );
  assert.equal(result.code, 0);
  const entries = auditEntriesOf(auditOut);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stage, 'preflight');
  assert.equal(entries[0].status, 'done');
  assert.equal(entries[0].operator, 'tester');
  assert.equal(Number.isNaN(Date.parse(entries[0].at)), false, 'the session entry must carry a parseable time');
  const printed = printedObject(result.stdout);
  assert.equal(entries[0].runid, printed.runid);
  assert.equal(printed.result.sameFileSystem, true);
  assert.equal(
    harness.calls.every((call) => call[0] === 'readOnly.sshRun'),
    true,
    'a preflight must never reach the write face',
  );
  assert.equal(harness.calls.length, 4, 'one device probe plus one probe per root');
});

test('a failed preflight still writes its entry and tells the operator where to look', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => ({ status: 255, stdout: '', stderr: 'ssh: connect to host refused' }),
    writeSsh: okWrite,
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await captureRun(networkArgs('--preflight', ['--audit-out', auditOut]), {
    createTransport: harness.createTransport,
  });
  assert.equal(result.code, 1);
  const entries = auditEntriesOf(auditOut);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stage, 'preflight');
  assert.equal(entries[0].status, 'fail');
  assert.match(entries[0].detail, /the read only probe did not succeed/u);
  assert.equal(Number.isNaN(Date.parse(entries[0].at)), false);
  assert.match(result.stderr, /run the ssh probe by hand/u);
});

test('the cli refuses a preflight without an audit log path', async () => {
  const result = await captureRun(networkArgs('--preflight', []), { createTransport: refuseConstruction });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--audit-out is required/u);
});

test('a commit stamps every audit entry with the time it happened', async () => {
  const triple = await writeSignedTriple();
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: okRead,
    writeSsh: okWrite,
    sftpUpload: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
      return { status: 1, stdout: '', stderr: 'upload refused' };
    },
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await withEnvironment('PARTNERW_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    captureRun(
      [
        '--commit',
        '--channel',
        'internal',
        '--version',
        '1.2.3',
        '--host',
        'updates.example.invalid',
        '--known-hosts',
        OUTSIDE_KNOWN_HOSTS,
        '--package',
        triple.packagePath,
        '--file-manifest',
        triple.fileManifestPath,
        '--manifest',
        triple.manifestPath,
        '--audit-out',
        auditOut,
      ],
      { createTransport: harness.createTransport },
    ),
  );
  assert.equal(result.code, 1);
  assert.ok(harness.calls.length > 0, 'the injected transport must be the one that ran');
  const entries = auditEntriesOf(auditOut);
  assert.ok(entries.length >= 2, 'one entry cannot show whether the clock was injected');
  assert.equal(new Set(entries.map((entry) => entry.at)).size > 1, true, 'the entries must not share one timestamp');
  for (const entry of entries) assert.equal(Number.isNaN(Date.parse(entry.at)), false);
  assert.equal(entries[0].stage, 'open');
  assert.equal(entries[1].stage, 'pre-verify');
  assert.equal(entries[2].stage, 'stage');
  assert.equal(entries[2].status, 'fail');
  const printed = printedObject(result.stdout);
  assert.equal(printed.runid, entries[0].runid);
  assert.equal(printed.planHash.length, 64);
  assert.ok(harness.factoryInputs.length > 0, 'an empty array would make the assertion below vacuous');
  assert.ok(harness.factoryInputs.every((input) => input.host === 'updates.example.invalid'));
});

test('a commit reaches sftp with one batch file per upload, each holding exactly that upload', async () => {
  const triple = await writeSignedTriple();
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const batches = [];
  const createTransport = (input) =>
    cliModule.createFeedTransport({
      ...input,
      execFile: async (command, args) => {
        if (command !== 'sftp') {
          const script = args[args.length - 1];
          if (typeof script === 'string' && script.startsWith('if [ -L ')) {
            return {
              status: 0,
              stdout: script.includes('.part') ? 'absent\n' : 'directory root root 755 64771\n',
              stderr: '',
            };
          }
          return { status: 0, stdout: '', stderr: '' };
        }
        const batchFile = args[args.indexOf('-b') + 1];
        batches.push({ batchFile, content: fsModule.readFileSync(batchFile, 'utf8') });
        return { status: 0, stdout: '', stderr: '' };
      },
    });
  const result = await withEnvironment('PARTNERW_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    captureRun(
      [
        '--commit',
        '--channel',
        'internal',
        '--version',
        '1.2.3',
        '--host',
        'updates.example.invalid',
        '--known-hosts',
        OUTSIDE_KNOWN_HOSTS,
        '--package',
        triple.packagePath,
        '--file-manifest',
        triple.fileManifestPath,
        '--manifest',
        triple.manifestPath,
        '--audit-out',
        auditOut,
      ],
      { createTransport },
    ),
  );
  assert.equal(result.code, 1);
  assert.equal(batches.length, 2, 'the run must reach both staging uploads');
  const batchLines = batches.map((batch) => batch.content.split('\n').filter((line) => line.length > 0));
  for (const [index, lines] of batchLines.entries()) {
    assert.equal(
      lines.length,
      1,
      `the batch file handed to sftp for upload ${index + 1} carries ${lines.length} commands`,
    );
  }
  assert.equal(new Set(batches.map((batch) => batch.batchFile)).size, 2, 'two uploads shared one batch file');
  assert.equal(batches[0].content.trimEnd().endsWith('portable.zip.part'), true);
  assert.equal(batches[1].content.trimEnd().endsWith('portable-files.json.part'), true);
  assert.equal(
    batches[0].content.includes('portable-files.json'),
    false,
    'the first batch must not replay a later upload',
  );
  for (const batch of batches) {
    assert.equal(fsModule.existsSync(batch.batchFile), false, 'the batch file must be cleaned up in the finally');
  }
});

test('breaking a lock writes one session entry that carries the time and the previous owner', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(FOREIGN_OWNER_RECORD), stderr: '' }),
    writeSsh: okWrite,
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await withEnvironment('PARTNERW_FEED_OPERATOR', 'tester', () =>
    captureRun(
      networkArgs('--break-lock', ['--reason', 'stuck since friday', '--audit-out', auditOut, '--confirm-runid', 'r0']),
      {
        createTransport: harness.createTransport,
      },
    ),
  );
  assert.equal(result.code, 0);
  const entries = auditEntriesOf(auditOut);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stage, 'break-lock');
  assert.deepEqual(entries[0].previousOwner, FOREIGN_OWNER_RECORD);
  assert.equal(entries[0].reason, 'stuck since friday');
  assert.equal(entries[0].operator, 'tester');
  assert.equal(Number.isNaN(Date.parse(entries[0].at)), false);
  const removals = harness.calls.filter((call) => call[0] === 'write.sshRun').map((call) => call[1]);
  assert.equal(removals.length, 2);
  assert.match(removals[0], /^rm /u);
  assert.match(removals[1], /^rmdir /u);
});

test('the unreadable owner path prints three different causes and this run own record', async () => {
  const cases = [
    {
      cause: 'the lock carries no owner record',
      status: 'missing',
      absentOwnerRecord: true,
      readSsh: () => ({
        status: 1,
        stdout: '',
        stderr: 'cat: /opt/partner-w/updates-state/lock/internal/owner.json: No such file or directory',
      }),
    },
    {
      cause: 'the owner record could not be read',
      status: 'transport',
      readSsh: () => ({
        status: 1,
        stdout: '',
        stderr: 'cat: /opt/partner-w/updates-state/lock/internal/owner.json: Permission denied',
      }),
    },
    {
      cause: 'the owner record is not valid JSON',
      status: 'corrupt',
      readSsh: () => ({ status: 0, stdout: '{oops', stderr: '' }),
    },
  ];
  const printedCauses = [];
  for (const item of cases) {
    const auditOut = join(makeCliRoot(), 'audit.jsonl');
    const harness = makeHarness({
      readSsh: item.readSsh,
      writeSsh: removeSemantics(item.absentOwnerRecord),
      sftpUpload: okUpload,
      fetchPublic: okFetch,
      onFactory: () => {},
    });
    const result = await withEnvironment('PARTNERW_FEED_OPERATOR', 'ops', () =>
      captureRun(
        networkArgs('--break-lock', [
          '--reason',
          'confirmed idle',
          '--audit-out',
          auditOut,
          '--owner-record-unreadable',
        ]),
        {
          createTransport: harness.createTransport,
        },
      ),
    );
    assert.equal(result.code, 0);
    const printed = printedObject(result.stdout);
    assert.equal(printed.ownerRecordUnreadable, true);
    assert.equal(printed.ownerRecordStatus, item.status);
    assert.equal(printed.ownerRecordCause, item.cause);
    assert.equal(typeof printed.runid, 'string');
    assert.ok(printed.runid.length > 0);
    const entries = auditEntriesOf(auditOut);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].stage, 'break-lock');
    assert.equal(entries[0].ownerRecordUnreadable, true);
    assert.equal(entries[0].ownerRecordStatus, item.status);
    assert.equal(entries[0].ownerRecordCause, item.cause);
    assert.equal(entries[0].runid, printed.runid);
    assert.equal(entries[0].operator, 'ops');
    assert.equal(Number.isNaN(Date.parse(entries[0].at)), false);
    const removals = harness.calls.filter((call) => call[0] === 'write.sshRun').map((call) => call[1]);
    assert.equal(removals.length, 2, 'the break must remove the owner record and then the lock directory');
    assert.match(removals[0], /^rm -f \S+\/owner\.json$/u);
    assert.match(removals[1], /^rmdir \S+$/u);
    printedCauses.push(printed.ownerRecordCause);
  }
  assert.equal(new Set(printedCauses).size, 3, `the three causes must print differently: ${printedCauses.join(' | ')}`);
});

test('the unreadable owner flag is refused when the owner record is readable', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(FOREIGN_OWNER_RECORD), stderr: '' }),
    writeSsh: okWrite,
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await captureRun(
    networkArgs('--break-lock', ['--reason', 'confirmed idle', '--audit-out', auditOut, '--owner-record-unreadable']),
    { createTransport: harness.createTransport },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /needs --confirm-runid/u);
  const entries = auditEntriesOf(auditOut);
  assert.equal(entries.length, 1, 'a refused declaration must still leave a trace');
  assert.equal(entries[0].stage, 'break-lock');
  assert.equal(entries[0].status, 'fail');
  assert.equal(entries[0].reason, 'confirmed idle');
  assert.equal(entries[0].operator, 'unknown');
  assert.match(entries[0].detail, /needs --confirm-runid/u);
  assert.deepEqual(
    harness.calls.filter((call) => call[0] === 'write.sshRun'),
    [],
  );
});

test('breaking a lock without the unreadable flag still demands a confirmation', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const result = await captureRun(
    networkArgs('--break-lock', ['--reason', 'confirmed idle', '--audit-out', auditOut]),
    {
      createTransport: refuseConstruction,
    },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--confirm-runid is required/u);
});

test('breaking a lock refuses an owner record that does not match the confirmation', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(FOREIGN_OWNER_RECORD), stderr: '' }),
    writeSsh: okWrite,
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await captureRun(
    networkArgs('--break-lock', ['--reason', 'x', '--audit-out', auditOut, '--confirm-runid', 'r9']),
    {
      createTransport: harness.createTransport,
    },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--confirm-runid does not match the owner runid r0/u);
  assert.equal(fsModule.existsSync(auditOut), false);
  assert.deepEqual(
    harness.calls.filter((call) => call[0] === 'write.sshRun'),
    [],
  );
});

function stableArgs(triple, stableOut) {
  return [
    '--re-sign-stable',
    '--channel',
    'stable',
    '--version',
    '1.2.3',
    '--package',
    triple.packagePath,
    '--file-manifest',
    triple.fileManifestPath,
    '--manifest',
    triple.manifestPath,
    '--stable-out',
    stableOut,
  ];
}

function writeSigningKey(root) {
  const signingKeyPath = join(root, 'signing-key.pem');
  fsModule.writeFileSync(signingKeyPath, cliKeyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  return signingKeyPath;
}

function withReleaseKeys(signingKeyPath, body) {
  return withEnvironment('PARTNERW_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    withEnvironment('PARTNERW_UPDATE_SIGNING_KEY_FILE', signingKeyPath, body),
  );
}

test('the stable re-sign signs the verified internal bytes for the stable channel and the stable url', async () => {
  const root = makeCliRoot();
  const triple = await writeSignedTriple({ minLauncherVersion: '7.8.9' });
  const stableOut = join(root, 'stable-manifest.json');
  const factory = makeCountingRefusal();
  const result = await withReleaseKeys(writeSigningKey(root), () =>
    captureRun(stableArgs(triple, stableOut), { createTransport: factory.createTransport }),
  );
  assert.equal(result.code, 0);
  assert.equal(factory.constructions(), 0, 'the offline re-sign must not build a transport');
  const printed = printedObject(result.stdout);
  assert.equal(printed.mode, 're-sign-stable');
  assert.equal(printed.channel, 'stable');
  const emitted = fsModule.readFileSync(stableOut);
  const fileManifestBytes = fsModule.readFileSync(triple.fileManifestPath);
  assert.equal(printed.stableManifestSha256, cryptoModule.createHash('sha256').update(emitted).digest('hex'));
  assert.equal(
    printed.reusedFileManifestSha256,
    cryptoModule.createHash('sha256').update(fileManifestBytes).digest('hex'),
  );
  assert.equal(printed.reusedPackageSha256, cryptoModule.createHash('sha256').update(CLI_PACKAGE_BYTES).digest('hex'));
  const verified = await releaseModule.verifyPortableRelease({
    manifestBytes: emitted,
    fileManifestBytes,
    packagePath: triple.packagePath,
    publicKeyBase64: CLI_PUBLIC_KEY_BASE64,
  });
  assert.equal(verified.manifest.channel, 'stable');
  assert.equal(verified.manifest.packageUrl, 'https://api.rongyinghudong.com/updates/stable/1.2.3/portable.zip');
  assert.equal(verified.manifest.minLauncherVersion, '7.8.9');
});

test('the stable re-sign refuses to overwrite the manifest it already wrote and leaves the first one byte identical', async () => {
  const root = makeCliRoot();
  const triple = await writeSignedTriple();
  const stableOut = join(root, 'stable-manifest.json');
  const signingKeyPath = writeSigningKey(root);
  const factory = makeCountingRefusal();
  const first = await withReleaseKeys(signingKeyPath, () =>
    captureRun(stableArgs(triple, stableOut), { createTransport: factory.createTransport }),
  );
  assert.equal(first.code, 0);
  const firstBytes = fsModule.readFileSync(stableOut);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);
  const second = await withReleaseKeys(signingKeyPath, () =>
    captureRun(stableArgs(triple, stableOut), { createTransport: factory.createTransport }),
  );
  assert.equal(second.code, 1);
  assert.equal(factory.constructions(), 0, 'the refused re-sign must not build a transport either');
  assert.match(second.stderr, /already exists; refusing to overwrite a signed manifest/u);
  assert.match(second.stderr, /remove it by hand to re-sign/u);
  assert.deepEqual(fsModule.readFileSync(stableOut), firstBytes);
});

test('the stable re-sign refuses to run without the signing key file in the environment', async () => {
  const root = makeCliRoot();
  const triple = await writeSignedTriple();
  const stableOut = join(root, 'stable-manifest.json');
  const factory = makeCountingRefusal();
  const result = await withEnvironment('PARTNERW_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    captureRun(stableArgs(triple, stableOut), { createTransport: factory.createTransport }),
  );
  assert.equal(result.code, 1);
  assert.equal(factory.constructions(), 0, 'the refused re-sign must not build a transport either');
  assert.match(result.stderr, /PARTNERW_UPDATE_SIGNING_KEY_FILE is required to sign the stable manifest offline/u);
  assert.equal(fsModule.existsSync(stableOut), false);
});

test('the dry run refuses to run without the three artifact paths and prints no plan', async () => {
  const result = await captureRun(['--dry-run', '--channel', 'internal', '--version', '1.2.3'], {
    createTransport: refuseConstruction,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--package, --file-manifest and --manifest are required/u);
  assert.equal(result.stdout.includes('"plan"'), false);
});

test('the stable re-sign refuses to run without the three artifact paths', async () => {
  const stableOut = join(makeCliRoot(), 'stable-manifest.json');
  const result = await captureRun(
    ['--re-sign-stable', '--channel', 'stable', '--version', '1.2.3', '--stable-out', stableOut],
    { createTransport: refuseConstruction },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--package, --file-manifest and --manifest are required/u);
  assert.equal(fsModule.existsSync(stableOut), false);
});

test('the commit refuses to run without the three artifact paths', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const result = await captureRun(networkArgs('--commit', ['--audit-out', auditOut]), {
    createTransport: refuseConstruction,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--package, --file-manifest and --manifest are required/u);
  assert.equal(fsModule.existsSync(auditOut), false);
});

function explicitArgs(mode, knownHostsPath, extra) {
  return [
    mode,
    '--channel',
    'internal',
    '--version',
    '1.2.3',
    '--host',
    'updates.example.invalid',
    '--known-hosts',
    knownHostsPath,
    ...extra,
  ];
}

test('the commit mode refuses a known hosts file inside the repository before it builds a transport', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const result = await captureRun(
    explicitArgs('--commit', join(repositoryRoot, 'known_hosts'), [
      '--package',
      'p.zip',
      '--file-manifest',
      'f.json',
      '--manifest',
      'm.json',
      '--audit-out',
      auditOut,
    ]),
    { createTransport: refuseConstruction },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /outside the repository/u);
  assert.equal(fsModule.existsSync(auditOut), false);
});

test('the break lock mode refuses a known hosts file inside the repository before it builds a transport', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const result = await captureRun(
    explicitArgs('--break-lock', join(repositoryRoot, 'known_hosts'), [
      '--reason',
      'stopped',
      '--audit-out',
      auditOut,
      '--confirm-runid',
      'r0',
    ]),
    { createTransport: refuseConstruction },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /outside the repository/u);
  assert.equal(fsModule.existsSync(auditOut), false);
});

test('a command line carrying two mode flags is refused instead of letting the destructive one win', async () => {
  for (const pair of [
    ['--dry-run', '--commit'],
    ['--dry-run', '--break-lock'],
    ['--preflight', '--break-lock'],
  ]) {
    const result = await captureRun([...pair, '--channel', 'internal', '--version', '1.2.3'], {
      createTransport: refuseConstruction,
    });
    assert.equal(result.code, 1, pair.join(' '));
    assert.match(result.stderr, /only one mode flag may be given/u, pair.join(' '));
    assert.ok(result.stderr.includes(pair[0]) && result.stderr.includes(pair[1]), pair.join(' '));
    assert.equal(result.stdout.includes('"plan"'), false, pair.join(' '));
  }
});

test('the usage text documents every exit code the operator can act on', () => {
  const result = runCli([]);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /Exit codes: 0 the run finished, 1 it refused or failed, 2 no mode flag/u);
  assert.match(result.stdout, /3 the flip did not take effect/u);
  assert.match(result.stdout, /only code that means a --commit is safe to/u);
});

test('the cli refuses a version flag that is missing rather than inventing one', async () => {
  const result = await captureRun(
    ['--dry-run', '--channel', 'internal', '--package', 'p.zip', '--file-manifest', 'f.json', '--manifest', 'm.json'],
    { createTransport: refuseConstruction },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--version is required/u);
  assert.doesNotMatch(result.stderr, /semantic version/u);
  assert.equal(result.stdout.includes('"plan"'), false);
});

test('a reason flag whose value is another flag is refused rather than audited as the reason', async () => {
  const result = await captureRun(
    networkArgs('--break-lock', ['--reason', '--owner-record-unreadable', '--audit-out', 'x.jsonl']),
    { createTransport: refuseConstruction },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--reason is required/u);
});

test('the stable re-sign refuses an output path inside the repository', async () => {
  const triple = await writeSignedTriple();
  const inside = join(repositoryRoot, 'stable-manifest.json');
  const result = await captureRun(stableArgs(triple, inside), { createTransport: refuseConstruction });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--stable-out must live outside the repository/u);
  assert.equal(fsModule.existsSync(inside), false);
});

test('a preflight whose probe throws still leaves a failed session entry', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => {
      throw new Error('the probe transport died');
    },
    writeSsh: okWrite,
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await captureRun(networkArgs('--preflight', ['--audit-out', auditOut]), {
    createTransport: harness.createTransport,
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /the probe transport died/u);
  const entries = auditEntriesOf(auditOut);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stage, 'preflight');
  assert.equal(entries[0].status, 'fail');
  assert.match(entries[0].detail, /the probe transport died/u);
  assert.equal(Number.isNaN(Date.parse(entries[0].at)), false);
});

test('a break that fails to remove the lock directory still records the operators declaration', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => ({
      status: 1,
      stdout: '',
      stderr: 'cat: /opt/partner-w/updates-state/lock/internal/owner.json: No such file or directory',
    }),
    writeSsh: (request) =>
      request.script.startsWith('rmdir ')
        ? { status: 1, stdout: '', stderr: 'rmdir: failed to remove: Permission denied' }
        : removeSemantics(true)(request),
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await captureRun(
    networkArgs('--break-lock', ['--reason', 'confirmed idle', '--audit-out', auditOut, '--owner-record-unreadable']),
    { createTransport: harness.createTransport },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /the lock directory could not be removed/u);
  const entries = auditEntriesOf(auditOut);
  assert.equal(entries.length, 1, 'a failed break must leave a trace');
  assert.equal(entries[0].stage, 'break-lock');
  assert.equal(entries[0].status, 'fail');
  assert.equal(entries[0].reason, 'confirmed idle');
  assert.match(entries[0].detail, /the lock directory could not be removed/u);
});

const RETRY_PUBLIC_BODY = '{"baseline":true}\n';
const retryPublicSha = cryptoModule.createHash('sha256').update(Buffer.from(RETRY_PUBLIC_BODY, 'utf8')).digest('hex');

function makeRetryHarness(paths) {
  const digest = (buffer) => cryptoModule.createHash('sha256').update(buffer).digest('hex');
  const packageBytes = fsModule.readFileSync(paths.packagePath);
  const fileManifestBytes = fsModule.readFileSync(paths.fileManifestPath);
  const manifestSha = digest(fsModule.readFileSync(paths.manifestPath));
  const listing = `f portable.zip ${packageBytes.length}\nf portable-files.json ${fileManifestBytes.length}\n`;
  let ownerJson = null;
  return makeHarness({
    readSsh: (request) => {
      const script = request.script;
      if (script.includes('owner.json')) {
        return ownerJson === null
          ? { status: 1, stdout: '', stderr: 'cat: owner.json: No such file or directory' }
          : { status: 0, stdout: ownerJson, stderr: '' };
      }
      if (script.includes("stat -c '%d'")) return { status: 0, stdout: '100\n100\n', stderr: '' };
      if (script.includes('-printf')) {
        return { status: 0, stdout: script.includes('/staging/') ? listing : '', stderr: '' };
      }
      if (script.startsWith('if [ -L ')) {
        return {
          status: 0,
          stdout: script.includes('.part') ? 'absent\n' : 'directory root root 755 64771\n',
          stderr: '',
        };
      }
      if (script.startsWith('if [ -d ')) {
        return { status: 0, stdout: script.includes('/staging/') ? 'present\n' : '', stderr: '' };
      }
      if (script.includes('sha256sum') && script.includes('/staging/')) {
        const directory = script.split(/\s+/u)[1].replace(/\/[^/]+$/u, '');
        return {
          status: 0,
          stdout: `${digest(packageBytes)}  ${directory}/portable.zip\n${digest(fileManifestBytes)}  ${directory}/portable-files.json\n`,
          stderr: '',
        };
      }
      if (script.includes('sha256sum') && script.includes('manifest.json')) {
        const observed = script.includes('.tmp') ? manifestSha : retryPublicSha;
        return { status: 0, stdout: `${observed}  ${script.split(/\s+/u)[1]}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    writeSsh: (request) => {
      const ownerMatch = /printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > /u.exec(request.script);
      if (ownerMatch !== null) ownerJson = Buffer.from(ownerMatch[1], 'base64').toString('utf8');
      if (request.script.includes('/backup && cp ') && request.script.includes('sha256sum ')) {
        const target = String(request.script).trim().split(/\s+/u).pop();
        return { status: 0, stdout: `${retryPublicSha}  ${target}\n`, stderr: '' };
      }
      return { status: 0, stdout: '', stderr: '' };
    },
    sftpUpload: () => ({ status: 0, bytesSent: 1 }),
    fetchPublic: () => ({ status: 200, bodyBytes: Uint8Array.from(Buffer.from(RETRY_PUBLIC_BODY, 'utf8')) }),
    onFactory: () => {},
  });
}

test('a commit whose flip did not take effect exits 3 so the operator knows a re-run is safe', async () => {
  const triple = await writeSignedTriple();
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeRetryHarness(triple);
  const result = await withEnvironment('PARTNERW_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    captureRun(
      explicitArgs('--commit', OUTSIDE_KNOWN_HOSTS, [
        '--package',
        triple.packagePath,
        '--file-manifest',
        triple.fileManifestPath,
        '--manifest',
        triple.manifestPath,
        '--audit-out',
        auditOut,
      ]),
      { createTransport: harness.createTransport },
    ),
  );
  assert.equal(harness.factoryInputs.length, 1, 'the injected factory must be the only transport this run built');
  assert.equal(result.code, 3, 'exit 3 is the only code that means a commit is safe to re-run');
  const printed = printedObject(result.stdout);
  assert.equal(printed.outcome, 'retry');
  assert.equal(printed.lockState, 'retained-by-this-run');
  assert.equal(printed.reason, 'the flip did not take effect');
  const entries = auditEntriesOf(auditOut);
  assert.equal(entries.at(-1).stage, 'lock-retained');
});

test('the break lock mode succeeds without a version flag and echoes no version it never read', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => ({ status: 0, stdout: JSON.stringify(FOREIGN_OWNER_RECORD), stderr: '' }),
    writeSsh: okWrite,
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await withEnvironment('PARTNERW_FEED_OPERATOR', 'ops', () =>
    captureRun(
      [
        '--break-lock',
        '--channel',
        'internal',
        '--host',
        'updates.example.invalid',
        '--known-hosts',
        OUTSIDE_KNOWN_HOSTS,
        '--reason',
        'confirmed idle',
        '--audit-out',
        auditOut,
        '--confirm-runid',
        'r0',
      ],
      { createTransport: harness.createTransport },
    ),
  );
  assert.equal(result.code, 0, result.stderr);
  const printed = printedObject(result.stdout);
  assert.equal(printed.mode, 'break-lock');
  assert.equal(printed.channel, 'internal');
  assert.equal(
    'version' in printed,
    false,
    'the break lock path never reads a version, so echoing one would be invented',
  );
  assert.deepEqual(printed.previousOwner, FOREIGN_OWNER_RECORD);
  const entries = auditEntriesOf(auditOut);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].stage, 'break-lock');
  assert.equal('version' in entries[0], false);
});

test('the break lock mode still refuses a version flag that is not a semantic version', async () => {
  const result = await captureRun(
    [
      '--break-lock',
      '--channel',
      'internal',
      '--host',
      'updates.example.invalid',
      '--known-hosts',
      OUTSIDE_KNOWN_HOSTS,
      '--version',
      'banana',
      '--reason',
      'confirmed idle',
      '--audit-out',
      'a.jsonl',
      '--confirm-runid',
      'r0',
    ],
    { createTransport: refuseConstruction },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /version must be a strict semantic version/u);
});

test('the break lock mode still refuses a channel that is not in the whitelist', async () => {
  const result = await captureRun(
    [
      '--break-lock',
      '--channel',
      'beta',
      '--host',
      'updates.example.invalid',
      '--known-hosts',
      OUTSIDE_KNOWN_HOSTS,
      '--reason',
      'confirmed idle',
      '--audit-out',
      'a.jsonl',
      '--confirm-runid',
      'r0',
    ],
    { createTransport: refuseConstruction },
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /channel must be one of internal, stable/u);
});

test('the cli refuses to run without an injected transport factory instead of reaching the real one', async () => {
  const triple = await writeSignedTriple();
  await assert.rejects(
    () => captureRun(offlineArgs('--dry-run', triple, [])),
    /createTransport/u,
    'an offline mode must refuse rather than fall through to the real transport',
  );
  await assert.rejects(
    () => captureRun(networkArgs('--break-lock', ['--reason', 'x', '--audit-out', 'a.jsonl', '--confirm-runid', 'r0'])),
    /createTransport/u,
    'a network mode must refuse too, and never build the real transport',
  );
});

test('the entry script injects a transport factory, so a run with no mode flag prints usage rather than the missing factory error', () => {
  const result = runCli([]);
  assert.equal(result.status, 2, 'exit 2 is the usage banner; an entry without the factory exits 1 instead');
  assert.match(result.stdout, /Usage: node scripts\/feed-publish\.mjs/u);
  assert.doesNotMatch(result.stderr, /createTransport/u);
});

const feedPublishSources = [
  join(repositoryRoot, 'scripts', 'feed-publish.mjs'),
  join(repositoryRoot, 'scripts', 'lib', 'feed-publish-cli.mjs'),
  join(repositoryRoot, 'scripts', 'lib', 'feed-publish.mjs'),
  join(repositoryRoot, 'scripts', 'lib', 'feed-publish-transport.mjs'),
];

test('the four feed publishing sources carry no comment line and no CJK, which the global eslint ignore leaves unpinned', () => {
  const cjk = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/u;
  const comment = /^\s*(\/\/|\/\*|\*)/u;
  for (const source of feedPublishSources) {
    fsModule
      .readFileSync(source, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        assert.doesNotMatch(line, cjk, `${source}:${index + 1} carries CJK`);
        assert.doesNotMatch(line, comment, `${source}:${index + 1} is a comment`);
      });
  }
});
