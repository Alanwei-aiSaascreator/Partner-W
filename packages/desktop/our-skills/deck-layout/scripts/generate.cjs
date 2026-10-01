const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const contained = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function read(root, name, limit) {
  const requested = path.resolve(root, name);
  if (!contained(root, requested)) throw new Error('outside workspace');
  const file = fs.realpathSync(requested);
  if (!contained(root, file)) throw new Error('outside workspace');
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.size > limit) throw new Error('invalid file');
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fs.fstatSync(fd),
      current = fs.statSync(file);
    if (
      length !== after.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      fs.realpathSync(file) !== file
    )
      throw new Error('changed file');
    return bytes.subarray(0, length);
  } finally {
    fs.closeSync(fd);
  }
}
function failure(status, code, fileCreated = false) {
  return {
    schemaVersion: 1,
    status,
    diagnostics: [{ code }],
    fileCreated,
    artifactIndexed: false,
    visualReview: 'not-performed',
  };
}
let profile, identity, temporaryRoot;
function run() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('--')) return failure('source-invalid', 'source-argument-invalid');
  let runtime;
  try {
    runtime = JSON.parse(fs.readFileSync(path.join(__dirname, 'generate-runtime.json'), 'utf8'));
  } catch {
    return failure('runtime-unavailable', 'render-runtime-not-configured');
  }
  if (
    runtime.schemaVersion !== 1 ||
    typeof runtime.executable !== 'string' ||
    !path.isAbsolute(runtime.executable) ||
    !fs.existsSync(runtime.executable) ||
    !Array.isArray(runtime.args) ||
    runtime.args.length > 1 ||
    runtime.args.some((arg) => typeof arg !== 'string' || !path.isAbsolute(arg) || !fs.existsSync(arg))
  )
    return failure('runtime-unavailable', 'render-runtime-unavailable');
  const workspace = fs.realpathSync(process.cwd());
  let sourceSha256;
  try {
    sourceSha256 = sha(read(workspace, args[0], 1024 * 1024));
  } catch {
    return failure('source-invalid', 'source-unreadable');
  }
  temporaryRoot = fs.realpathSync(os.tmpdir());
  profile = fs.mkdtempSync(path.join(temporaryRoot, 'royin-slidegen-launch-'));
  identity = fs.lstatSync(profile);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (
      [
        'ELECTRON_RUN_AS_NODE',
        'NODE_OPTIONS',
        'NODE_PATH',
        'APPDATA',
        'LOCALAPPDATA',
        'USERPROFILE',
        'TEMP',
        'TMP',
        'ROYIN_SLIDEGEN_PROFILE',
      ].includes(key.toUpperCase())
    )
      delete env[key];
  }
  for (const [variable, directory] of [
    ['APPDATA', 'appData'],
    ['LOCALAPPDATA', 'localAppData'],
    ['USERPROFILE', 'userProfile'],
    ['TEMP', 'temp'],
    ['TMP', 'temp'],
  ]) {
    const destination = path.join(profile, directory);
    fs.mkdirSync(destination, { recursive: true });
    env[variable] = destination;
  }
  env.ROYIN_SLIDEGEN_PROFILE = profile;
  const requestedTimeout = Number(process.env.ROYIN_SLIDEGEN_TIMEOUT_MS);
  const timeout =
    Number.isFinite(requestedTimeout) && requestedTimeout >= 1000 && requestedTimeout <= 150_000
      ? requestedTimeout
      : 150_000;
  const result = spawnSync(runtime.executable, [...runtime.args, '--royin-render-slidegen', args[0]], {
    cwd: workspace,
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error)
    return failure(
      'output-unconfirmed',
      result.error.code === 'ETIMEDOUT' ? 'render-command-timeout' : 'render-output-unconfirmed',
      null,
    );
  let report;
  try {
    report = JSON.parse(result.stdout.trim());
    if (report.schemaVersion !== 1 || report.artifactIndexed !== false || report.visualReview !== 'not-performed')
      throw new Error('invalid report');
    if (report.status !== 'file-generated') {
      if (
        result.status !== 1 ||
        !['source-invalid', 'render-failed'].includes(report.status) ||
        report.fileCreated !== false
      )
        throw new Error('invalid failure');
      return report;
    }
    if (
      result.status !== 0 ||
      report.fileCreated !== true ||
      typeof report.fileName !== 'string' ||
      report.fileName !== path.basename(report.fileName) ||
      !report.fileName.endsWith('.pptx') ||
      !Number.isInteger(report.pages) ||
      report.pages < 1 ||
      report.pages > 200 ||
      report.sourceSha256 !== sourceSha256 ||
      sha(read(workspace, args[0], 1024 * 1024)) !== sourceSha256
    )
      throw new Error('invalid receipt');
    const bytes = read(workspace, report.fileName, 128 * 1024 * 1024);
    if (bytes.length !== report.bytes || sha(bytes) !== report.outputSha256) throw new Error('changed output');
    return report;
  } catch {
    return failure('output-unconfirmed', 'render-output-unconfirmed', null);
  }
}
let report;
try {
  report = run();
} catch {
  report = failure('runtime-unavailable', 'render-runtime-unavailable');
}
let runtimeCleanup = 'not-created';
if (profile) {
  try {
    const current = fs.lstatSync(profile);
    if (
      !contained(temporaryRoot, profile) ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      current.isSymbolicLink()
    )
      throw new Error('changed profile');
    fs.rmSync(profile, { recursive: true, force: true });
    runtimeCleanup = 'complete';
  } catch {
    runtimeCleanup = 'incomplete';
  }
}
process.stdout.write(JSON.stringify({ ...report, runtimeCleanup }) + '\n');
process.exitCode = report.status === 'file-generated' ? 0 : 1;
