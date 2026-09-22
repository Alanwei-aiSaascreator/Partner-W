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
    'h',
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
    'h',
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
    'h',
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

const cliModule = await import('./feed-publish-cli.mjs');
const releaseModule = await import('./portable-update-release.mjs');
const cryptoModule = await import('node:crypto');
const fsModule = await import('node:fs');
const osModule = await import('node:os');
const { afterEach } = await import('node:test');

const cliRoots = [];
afterEach(() => {
  for (const root of cliRoots.splice(0)) fsModule.rmSync(root, { recursive: true, force: true });
});

function makeCliRoot() {
  const root = fsModule.mkdtempSync(join(osModule.tmpdir(), 'mofang-cli-'));
  cliRoots.push(root);
  return root;
}

const cliKeyPair = cryptoModule.generateKeyPairSync('ed25519');
const CLI_PUBLIC_KEY_BASE64 = cliKeyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const CLI_PACKAGE_BYTES = Buffer.from('portable-zip-bytes', 'utf8');
const OUTSIDE_KNOWN_HOSTS = resolve(osModule.tmpdir(), 'known_hosts');

async function writeSignedTriple() {
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
    minLauncherVersion: '1.0.0',
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
const refuseConstruction = () => {
  throw new Error('the transport must not be built for this run');
};

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
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => {
    out.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    err.push(String(chunk));
    return true;
  };
  try {
    const code = await cliModule.runCli(argv, dependencies);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
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
  const result = await withEnvironment('MOFANG_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    captureRun(offlineArgs('--dry-run', triple, [])),
  );
  assert.equal(result.code, 0);
  const printed = printedObject(result.stdout);
  assert.equal(printed.mode, 'dry-run');
  assert.equal(printed.channel, 'internal');
  assert.equal(printed.version, '1.2.3');
  assert.equal(printed.plan.length, 13);
  assert.equal(printed.plan[0].stage, 'pre-verify');
});

test('the dry run refuses a triple whose manifest signature was corrupted and prints no plan', async () => {
  const triple = await writeSignedTriple();
  const parsed = JSON.parse(triple.manifestBytes.toString('utf8'));
  const flipped = parsed.signature[0] === 'A' ? 'B' : 'A';
  const corrupted = { ...parsed, signature: `${flipped}${parsed.signature.slice(1)}` };
  fsModule.writeFileSync(triple.manifestPath, Buffer.from(JSON.stringify(corrupted), 'utf8'));
  const result = await withEnvironment('MOFANG_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
    captureRun(offlineArgs('--dry-run', triple, [])),
  );
  assert.equal(result.code, 1);
  assert.match(result.stderr, /release manifest signature is invalid/u);
  assert.equal(result.stdout.includes('"plan"'), false, 'the plan must not be printed when the gate refuses');
  assert.equal(result.stdout.includes('"stage"'), false);
});

test('the dry run refuses to run without the public key in the environment', async () => {
  const triple = await writeSignedTriple();
  const result = await captureRun(offlineArgs('--dry-run', triple, []));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /MOFANG_UPDATE_PUBLIC_KEY_B64 is required/u);
  assert.equal(result.stdout.includes('"plan"'), false);
});

test('a preflight writes one session entry that carries the time it ran', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => ({ status: 0, stdout: '100\n100\n', stderr: '' }),
    writeSsh: okWrite,
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await withEnvironment('MOFANG_FEED_OPERATOR', 'tester', () =>
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
  assert.deepEqual(
    harness.calls.map((call) => call[0]),
    ['readOnly.sshRun'],
  );
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
  const result = await withEnvironment('MOFANG_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
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
  assert.ok(harness.factoryInputs.every((input) => input.host === 'updates.example.invalid'));
});

test('the batch file the cli hands the factory is the file its writer appends to', async () => {
  const triple = await writeSignedTriple();
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const observed = [];
  const harness = makeHarness({
    readSsh: okRead,
    writeSsh: okWrite,
    sftpUpload: () => ({ status: 1, stdout: '', stderr: 'upload refused' }),
    fetchPublic: okFetch,
    onFactory: (input) => {
      input.writeBatch('put /a /b\n');
      observed.push({ batchFile: input.batchFile, content: fsModule.readFileSync(input.batchFile, 'utf8') });
    },
  });
  const result = await withEnvironment('MOFANG_UPDATE_PUBLIC_KEY_B64', CLI_PUBLIC_KEY_BASE64, () =>
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
  assert.equal(observed.length, 1);
  assert.match(observed[0].batchFile, /sftp-batch\.txt$/u);
  assert.equal(observed[0].content, 'put /a /b\n');
  assert.equal(fsModule.existsSync(observed[0].batchFile), false, 'the batch file must be cleaned up in the finally');
});

test('breaking a lock writes one session entry that carries the time and the previous owner', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => ({ status: 0, stdout: JSON.stringify({ runid: 'r0', planHash: 'p0' }), stderr: '' }),
    writeSsh: okWrite,
    sftpUpload: okUpload,
    fetchPublic: okFetch,
    onFactory: () => {},
  });
  const result = await withEnvironment('MOFANG_FEED_OPERATOR', 'tester', () =>
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
  assert.deepEqual(entries[0].previousOwner, { runid: 'r0', planHash: 'p0' });
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
      readSsh: () => ({ status: 1, stdout: '', stderr: 'cat: /opt/x/owner.json: No such file or directory' }),
    },
    {
      cause: 'the owner record could not be read',
      status: 'transport',
      readSsh: () => ({ status: 1, stdout: '', stderr: 'cat: /opt/x/owner.json: Permission denied' }),
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
      writeSsh: okWrite,
      sftpUpload: okUpload,
      fetchPublic: okFetch,
      onFactory: () => {},
    });
    const result = await withEnvironment('MOFANG_FEED_OPERATOR', 'ops', () =>
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
    printedCauses.push(printed.ownerRecordCause);
  }
  assert.equal(new Set(printedCauses).size, 3, `the three causes must print differently: ${printedCauses.join(' | ')}`);
});

test('the unreadable owner flag is refused when the owner record is readable', async () => {
  const auditOut = join(makeCliRoot(), 'audit.jsonl');
  const harness = makeHarness({
    readSsh: () => ({ status: 0, stdout: JSON.stringify({ runid: 'r0', planHash: 'p0' }), stderr: '' }),
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
  assert.equal(fsModule.existsSync(auditOut), false);
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
    readSsh: () => ({ status: 0, stdout: JSON.stringify({ runid: 'r0', planHash: 'p0' }), stderr: '' }),
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
