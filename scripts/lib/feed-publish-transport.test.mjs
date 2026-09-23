import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FeedTransportError,
  createFeedTransport,
  mapExecFileOutcome,
  quoteBatchPath,
} from './feed-publish-transport.mjs';

const KNOWN_HOSTS = '/outside/repo/known_hosts';
const HOST = 'updates.example.invalid';

function makeFake({ status = 0, stdout = '', stderr = '', error = null } = {}) {
  const calls = [];
  const execFile = async (command, args, options) => {
    calls.push({ command, args, options });
    if (error !== null) return { status: -1, stdout: '', stderr: String(error.message ?? error) };
    return { status, stdout, stderr };
  };
  return { calls, execFile };
}

function makeTransport(overrides = {}) {
  return createFeedTransport({
    host: HOST,
    knownHostsPath: KNOWN_HOSTS,
    execFile: overrides.execFile,
    fetchPublic: overrides.fetchPublic,
    batchFile: overrides.batchFile ?? '/outside/repo/batch.txt',
    writeBatch: overrides.writeBatch,
  });
}

test('the batch path quoting refuses a carriage return, a newline and a nul byte', () => {
  for (const value of ['a\rb', 'a\nb', 'a\u0000b']) {
    assert.throws(() => quoteBatchPath(value), FeedTransportError);
  }
});

test('the batch path quoting wraps a path with spaces and escapes inner quotes', () => {
  assert.equal(quoteBatchPath('/opt/plain'), '/opt/plain');
  assert.equal(quoteBatchPath('C:/build dir/portable.zip'), '"C:/build dir/portable.zip"');
  assert.equal(quoteBatchPath('/opt/we"ird'), '"/opt/we\\"ird"');
});

test('every ssh call carries the pinned options as separate argv entries', async () => {
  const fake = makeFake({ stdout: 'ok' });
  const transport = makeTransport({ execFile: fake.execFile });
  const result = await transport.readOnly.sshRun({ script: 'ls /opt' });

  assert.equal(result.status, 0);
  const [call] = fake.calls;
  assert.equal(call.command, 'ssh');
  assert.ok(Array.isArray(call.args));
  assert.deepEqual(call.args.slice(0, 8), [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    `UserKnownHostsFile=${KNOWN_HOSTS}`,
    '-o',
    'ConnectTimeout=15',
  ]);
  assert.equal(call.args.at(-2), HOST);
  assert.equal(call.args.at(-1), 'ls /opt');
  assert.equal(call.options.shell, undefined);
});

test('no ssh option ever relaxes host key checking', async () => {
  const fake = makeFake();
  await makeTransport({ execFile: fake.execFile }).readOnly.sshRun({ script: 'ls' });
  const joined = fake.calls[0].args.join(' ');
  assert.doesNotMatch(joined, /StrictHostKeyChecking=no/u);
  assert.doesNotMatch(joined, /accept-new/u);
  assert.doesNotMatch(joined, /UserKnownHostsFile=\/dev\/null/u);
});

test('a missing known hosts path is refused before any process starts', () => {
  const fake = makeFake();
  assert.throws(
    () => createFeedTransport({ host: HOST, knownHostsPath: '', execFile: fake.execFile }),
    FeedTransportError,
  );
  assert.deepEqual(fake.calls, []);
});

test('an sftp upload writes a quoted batch line and runs sftp with -b', async () => {
  const fake = makeFake();
  const batches = [];
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: (text) => batches.push(text) });
  const result = await transport.write.sftpUpload({
    localPath: 'C:/build dir/portable.zip',
    remotePath: '/opt/rongying/updates-state/staging/internal/1.2.3/abc/portable.zip.part-r1',
    resume: true,
  });

  assert.equal(result.status, 0);
  assert.equal(batches.length, 1);
  assert.match(batches[0], /^reput "/u);
  assert.match(batches[0], /"C:\/build dir\/portable\.zip"/u);
  const [call] = fake.calls;
  assert.equal(call.command, 'sftp');
  assert.ok(call.args.includes('-b'));
  assert.ok(call.args.includes('BatchMode=yes'));
  assert.equal(call.options.shell, undefined);
});

test('a non resuming sftp upload uses put instead of reput', async () => {
  const batches = [];
  const transport = makeTransport({ execFile: makeFake().execFile, writeBatch: (text) => batches.push(text) });
  await transport.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false });
  assert.match(batches[0], /^put /u);
});

test('an undefined exit status is reported as a failure rather than success', async () => {
  const fake = makeFake({ error: new Error('spawn ssh ENOENT') });
  const result = await makeTransport({ execFile: fake.execFile }).readOnly.sshRun({ script: 'ls' });
  assert.equal(result.status, -1);
  assert.match(result.stderr, /ENOENT/u);
});

test('the public fetcher returns the raw bytes as a byte array', async () => {
  const seen = [];
  const transport = makeTransport({
    fetchPublic: async (url) => {
      seen.push(url);
      return { status: 200, arrayBuffer: async () => new TextEncoder().encode('body-bytes').buffer };
    },
  });
  const result = await transport.fetchPublic('https://api.rongyinghudong.com/updates/internal/manifest.json');
  assert.equal(result.status, 200);
  assert.equal(Buffer.from(result.bodyBytes).toString('utf8'), 'body-bytes');
  assert.deepEqual(seen, ['https://api.rongyinghudong.com/updates/internal/manifest.json']);
});

test('the transport never builds a shell command string', async () => {
  const fake = makeFake();
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: () => {} });
  await transport.readOnly.sshRun({ script: 'ls /opt' });
  await transport.write.sshRun({ script: 'rmdir /x' });
  await transport.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false });
  for (const call of fake.calls) {
    assert.ok(Array.isArray(call.args));
    assert.equal(call.options.shell, undefined);
  }
});

test('a per call host and known hosts file override the pinned defaults', async () => {
  const fake = makeFake();
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: () => {} });
  await transport.readOnly.sshRun({
    host: 'other.example.invalid',
    knownHostsPath: '/outside/repo/other_known_hosts',
    script: 'ls /opt',
  });
  await transport.write.sftpUpload({
    host: 'other.example.invalid',
    knownHostsPath: '/outside/repo/other_known_hosts',
    localPath: '/a',
    remotePath: '/b',
    resume: false,
  });

  assert.equal(fake.calls.length, 2);
  const [sshCall, sftpCall] = fake.calls;
  assert.equal(sshCall.args[5], 'UserKnownHostsFile=/outside/repo/other_known_hosts');
  assert.equal(sshCall.args.at(-2), 'other.example.invalid');
  assert.equal(sshCall.args.at(-1), 'ls /opt');
  assert.ok(sftpCall.args.includes('-b'));
  assert.equal(sftpCall.args[5], 'UserKnownHostsFile=/outside/repo/other_known_hosts');
  assert.equal(sftpCall.args.at(-1), 'other.example.invalid');
});

test('a call that carries no anchor of its own falls back to the pinned one', async () => {
  const fake = makeFake();
  const transport = makeTransport({ execFile: fake.execFile });
  await transport.readOnly.sshRun({ script: 'ls' });
  assert.equal(fake.calls[0].args[5], `UserKnownHostsFile=${KNOWN_HOSTS}`);
  assert.equal(fake.calls[0].args.at(-2), HOST);
});

test('the batch path quoting refuses a path that is not a non empty string', () => {
  for (const value of ['', 7, null, undefined]) {
    assert.throws(() => quoteBatchPath(value), FeedTransportError);
  }
});

test('a transport without a host or a pinned known hosts file is refused before any process starts', () => {
  assert.throws(() => createFeedTransport({ host: '', knownHostsPath: KNOWN_HOSTS }), FeedTransportError);
  assert.throws(() => createFeedTransport({ host: HOST }), FeedTransportError);
});

test('an sftp upload without a batch writer or a batch file path fails closed', async () => {
  const fake = makeFake();
  const writes = [];
  const withoutWriter = createFeedTransport({
    host: HOST,
    knownHostsPath: KNOWN_HOSTS,
    batchFile: '/outside/repo/batch.txt',
    execFile: fake.execFile,
  });
  await assert.rejects(
    withoutWriter.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false }),
    FeedTransportError,
  );
  const withoutBatchFile = createFeedTransport({
    host: HOST,
    knownHostsPath: KNOWN_HOSTS,
    execFile: fake.execFile,
    writeBatch: (text) => writes.push(text),
  });
  await assert.rejects(
    withoutBatchFile.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false }),
    FeedTransportError,
  );
  assert.deepEqual(writes, []);
  assert.deepEqual(fake.calls, []);
});

test('a per call batch writer and its batch file are used together instead of the factory pair', async () => {
  const factoryWrites = [];
  const callWrites = [];
  const fake = makeFake();
  const transport = makeTransport({
    execFile: fake.execFile,
    writeBatch: (text) => factoryWrites.push(text),
  });
  await transport.write.sftpUpload({
    localPath: '/a',
    remotePath: '/b',
    resume: false,
    batchFile: '/outside/repo/call-batch.txt',
    writeBatch: (text) => callWrites.push(text),
  });
  assert.deepEqual(factoryWrites, []);
  assert.equal(callWrites.length, 1);
  assert.match(callWrites[0], /^put /u);
  assert.equal(fake.calls[0].args.at(-2), '/outside/repo/call-batch.txt');
});

test('a per call batch writer without its own batch file is refused rather than writing to a file sftp never reads', async () => {
  const factoryWrites = [];
  const callWrites = [];
  const fake = makeFake();
  const transport = makeTransport({
    execFile: fake.execFile,
    writeBatch: (text) => factoryWrites.push(text),
  });
  await assert.rejects(
    transport.write.sftpUpload({
      localPath: '/a',
      remotePath: '/b',
      resume: false,
      writeBatch: (text) => callWrites.push(text),
    }),
    FeedTransportError,
  );
  assert.deepEqual(factoryWrites, []);
  assert.deepEqual(callWrites, []);
  assert.deepEqual(fake.calls, []);
});

test('a runner result without a numeric status is reported as a failure rather than as success', async () => {
  const statusless = makeTransport({ execFile: async () => ({ stdout: 'ok', stderr: '' }), writeBatch: () => {} });
  assert.equal((await statusless.readOnly.sshRun({ script: 'ls' })).status, -1);
  assert.equal((await statusless.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false })).status, -1);
  const empty = makeTransport({ execFile: async () => null, writeBatch: () => {} });
  const bare = await empty.readOnly.sshRun({ script: 'ls' });
  assert.equal(bare.status, -1);
  assert.equal(bare.stdout, '');
  assert.equal(bare.stderr, '');
});

test('a public response without a byte reader is reported with an empty body rather than a crash', async () => {
  const noReader = makeTransport({ fetchPublic: async () => ({ status: 204 }) });
  const result = await noReader.fetchPublic('https://api.rongyinghudong.com/updates/internal/manifest.json');
  assert.equal(result.status, 204);
  assert.equal(result.bodyBytes.length, 0);
  const statusless = makeTransport({ fetchPublic: async () => ({}) });
  assert.equal(
    (await statusless.fetchPublic('https://api.rongyinghudong.com/updates/internal/manifest.json')).status,
    0,
  );
});

test('every call carries a finite timeout so a hung remote cannot hold the run', async () => {
  const fake = makeFake();
  const records = [];
  const restore = stubDefaultPublicFetch(records);
  try {
    const transport = makeTransport({ execFile: fake.execFile, writeBatch: () => {} });
    await transport.readOnly.sshRun({ script: 'ls' });
    await transport.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false });
    await transport.fetchPublic('https://api.rongyinghudong.com/updates/internal/manifest.json');
  } finally {
    restore();
  }
  const [sshCall, sftpCall] = fake.calls;
  assert.equal(sshCall.options.timeout, 60000);
  assert.equal(sftpCall.options.timeout, 600000);
  assert.equal(sshCall.options.encoding, 'utf8');
  assert.equal(sftpCall.options.encoding, 'utf8');
  const publicCall = records.find((record) => record.url !== undefined);
  const delays = records.filter((record) => record.timeoutMs !== undefined);
  assert.equal(delays.length, 1);
  assert.equal(delays[0].timeoutMs, 60000);
  assert.equal(publicCall.options.signal instanceof AbortSignal, true);
});

test('the transport exposes the five faces the publish flow calls', () => {
  const transport = makeTransport({ execFile: makeFake().execFile });
  assert.deepEqual(Object.keys(transport).sort(), ['fetchPublic', 'fetchPublicStream', 'readOnly', 'write']);
  assert.deepEqual(Object.keys(transport.readOnly), ['sshRun']);
  assert.deepEqual(Object.keys(transport.write).sort(), ['sftpUpload', 'sshRun']);
  assert.equal(typeof transport.readOnly.sshRun, 'function');
  assert.equal(typeof transport.write.sshRun, 'function');
  assert.equal(typeof transport.write.sftpUpload, 'function');
  assert.equal(typeof transport.fetchPublic, 'function');
  assert.equal(typeof transport.fetchPublicStream, 'function');
});

function stubDefaultPublicFetch(records) {
  const realFetch = globalThis.fetch;
  const realTimeout = AbortSignal.timeout;
  globalThis.fetch = async (url, options) => {
    records.push({ url, options });
    return { status: 200, arrayBuffer: async () => new TextEncoder().encode('body').buffer };
  };
  AbortSignal.timeout = (ms) => {
    records.push({ timeoutMs: ms });
    return realTimeout.call(AbortSignal, ms);
  };
  return () => {
    globalThis.fetch = realFetch;
    AbortSignal.timeout = realTimeout;
  };
}

test('the default public fetcher refuses a redirect instead of following it', async () => {
  const records = [];
  const restore = stubDefaultPublicFetch(records);
  try {
    await makeTransport({}).fetchPublic('https://api.rongyinghudong.com/updates/internal/manifest.json');
  } finally {
    restore();
  }
  const calls = records.filter((record) => record.url !== undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.rongyinghudong.com/updates/internal/manifest.json');
  assert.equal(calls[0].options.redirect, 'error');
});

test('a per call anchor that could become an option is refused before any process starts', async () => {
  const fake = makeFake();
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: () => {} });
  for (const bad of ['', '-oProxyCommand=calc', 'has space', 'has\ttab', 'has\u0000nul']) {
    await assert.rejects(transport.readOnly.sshRun({ host: bad, script: 'ls' }), FeedTransportError);
    await assert.rejects(
      transport.write.sftpUpload({ host: bad, localPath: '/a', remotePath: '/b', resume: false }),
      FeedTransportError,
    );
  }
  for (const bad of ['', 7]) {
    await assert.rejects(transport.readOnly.sshRun({ knownHostsPath: bad, script: 'ls' }), FeedTransportError);
    await assert.rejects(
      transport.write.sftpUpload({ knownHostsPath: bad, localPath: '/a', remotePath: '/b', resume: false }),
      FeedTransportError,
    );
  }
  assert.deepEqual(fake.calls, []);
});

test('an sftp upload that carries no anchor of its own falls back to the pinned one', async () => {
  const fake = makeFake();
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: () => {} });
  await transport.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false });
  const [call] = fake.calls;
  assert.equal(call.args[5], `UserKnownHostsFile=${KNOWN_HOSTS}`);
  assert.equal(call.args.at(-1), HOST);
});

test('the batch file sftp is pointed at is the one the factory was given', async () => {
  const fake = makeFake();
  const writes = [];
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: (text) => writes.push(text) });
  await transport.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false });
  const [call] = fake.calls;
  const at = call.args.indexOf('-b');
  assert.equal(writes.length, 1);
  assert.ok(at > 0);
  assert.equal(call.args[at + 1], '/outside/repo/batch.txt');
});

test('every pinned call also refuses the global known hosts file', async () => {
  const fake = makeFake();
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: () => {} });
  await transport.readOnly.sshRun({ script: 'ls' });
  await transport.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false });
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    assert.ok(call.args.includes('GlobalKnownHostsFile=/dev/null'));
  }
});

test('every remote call hides the console window the process would otherwise open', async () => {
  const fake = makeFake();
  const transport = makeTransport({ execFile: fake.execFile, writeBatch: () => {} });
  await transport.readOnly.sshRun({ script: 'ls' });
  await transport.write.sftpUpload({ localPath: '/a', remotePath: '/b', resume: false });
  assert.equal(fake.calls.length, 2);
  for (const call of fake.calls) {
    assert.equal(call.options.windowsHide, true);
  }
});

test('the exec outcome mapping reports a numeric code, a missing code and a success', () => {
  assert.deepEqual(mapExecFileOutcome(null, 'out', 'err'), { status: 0, stdout: 'out', stderr: 'err' });
  assert.deepEqual(mapExecFileOutcome({ code: 255 }, '', ''), { status: 255, stdout: '', stderr: '' });
  assert.deepEqual(mapExecFileOutcome({ code: 'ENOENT', message: 'spawn ssh ENOENT' }), {
    status: -1,
    stdout: '',
    stderr: 'spawn ssh ENOENT',
  });
  assert.deepEqual(mapExecFileOutcome({ message: undefined }), { status: -1, stdout: '', stderr: '' });
});

test('a batch path outside the safe alphabet is quoted so a backslash cannot be read as an escape', () => {
  const backslash = String.fromCharCode(92);
  const doubled = backslash.repeat(2);
  const windowsDrive = `C:${backslash}x.zip`;
  const windowsDir = `C:${backslash}build dir${backslash}x.zip`;
  assert.equal(quoteBatchPath(windowsDrive), `"C:${doubled}x.zip"`);
  assert.equal(quoteBatchPath(windowsDir), `"C:${doubled}build dir${doubled}x.zip"`);
  assert.equal(quoteBatchPath('/opt/plain'), '/opt/plain');
  assert.equal(quoteBatchPath('C:/build dir/portable.zip'), '"C:/build dir/portable.zip"');
});

test('a factory ssh host that could become an option is refused when the transport is built', () => {
  for (const host of ['-oProxyCommand=calc', 'bad host', 'bad\thost', 'bad\u0000host']) {
    assert.throws(() => createFeedTransport({ host, knownHostsPath: KNOWN_HOSTS }), FeedTransportError);
  }
});

test('a known hosts path that carries whitespace reaches ssh as one argument', async () => {
  const fake = makeFake();
  const transport = createFeedTransport({
    host: HOST,
    knownHostsPath: '/outside/repo/known hosts',
    execFile: fake.execFile,
    writeBatch: () => {},
  });
  await transport.readOnly.sshRun({ script: 'ls' });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].args[5], 'UserKnownHostsFile=/outside/repo/known hosts');
  assert.equal(fake.calls[0].args.at(-2), HOST);
});
