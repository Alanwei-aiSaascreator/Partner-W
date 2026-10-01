import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  normal: vi.fn(),
  command: vi.fn(),
  render: vi.fn(),
  app: { setPath: vi.fn(), disableHardwareAcceleration: vi.fn(), whenReady: vi.fn(), exit: vi.fn() },
  session: {
    webRequest: { onBeforeRequest: vi.fn() },
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
  },
}));
vi.mock('../src/main/index.js', () => {
  mocks.normal();
  return {};
});
vi.mock('electron', () => ({ app: mocks.app, session: { defaultSession: mocks.session } }));
vi.mock('../src/main/slidegen/render-file.js', () => ({ renderSlideSourceFile: mocks.render }));

const originalArgv = process.argv;
const originalTemp = process.env.TEMP;
const originalTmp = process.env.TMP;
const originalProfile = process.env.ROYIN_SLIDEGEN_PROFILE;
let root = '';
let ready: () => void;
let output: string[] = [];
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-command-test-'));
  process.env.TEMP = root;
  process.env.TMP = root;
  process.argv = ['electron', 'app', '--royin-render-slidegen', 'report.slidegen'];
  delete process.env.ROYIN_SLIDEGEN_PROFILE;
  output = [];
  mocks.app.whenReady.mockReturnValue(new Promise<void>((resolve) => (ready = resolve)));
  mocks.render.mockResolvedValue({ status: 'file-generated', fileCreated: true, pages: 2 });
  const originalWrite = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk, ...args) => {
    if (typeof chunk !== 'string' || !chunk.startsWith('{'))
      return Reflect.apply(originalWrite, process.stdout, [chunk, ...args]);
    output.push(chunk);
    const callback = args.find((arg) => typeof arg === 'function');
    if (typeof callback === 'function') callback();
    return true;
  });
});
afterEach(() => {
  process.argv = originalArgv;
  if (originalTemp === undefined) delete process.env.TEMP;
  else process.env.TEMP = originalTemp;
  if (originalTmp === undefined) delete process.env.TMP;
  else process.env.TMP = originalTmp;
  if (originalProfile === undefined) delete process.env.ROYIN_SLIDEGEN_PROFILE;
  else process.env.ROYIN_SLIDEGEN_PROFILE = originalProfile;
  vi.restoreAllMocks();
  if (!path.resolve(root).startsWith(path.resolve(originalTemp ?? originalTmp ?? os.tmpdir()) + path.sep))
    throw new Error('test path escaped');
  fs.rmSync(root, { recursive: true, force: true });
});

async function load(file: string) {
  try {
    return await import(file);
  } catch (error) {
    if (error instanceof Error && /Cannot find module|Failed to load url/.test(error.message)) return undefined;
    throw error;
  }
}
async function loadCommand() {
  const loaded = await load('../src/main/slidegen/render-command.js');
  expect(loaded).toBeDefined();
  ready();
  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalled());
  return JSON.parse(output[0]);
}

it('routes ordinary startup to the existing main module', async () => {
  process.argv = ['electron', 'app'];
  expect(await load('../src/main/entry.js')).toBeDefined();
  expect(mocks.normal).toHaveBeenCalledOnce();
  expect(mocks.app.whenReady).not.toHaveBeenCalled();
  expect(mocks.render).not.toHaveBeenCalled();
});

it('routes command startup without loading normal startup or awaiting ready at module top level', async () => {
  expect(await load('../src/main/entry.js')).toBeDefined();
  expect(mocks.normal).not.toHaveBeenCalled();
  expect(mocks.app.whenReady).toHaveBeenCalledOnce();
  expect(mocks.render).not.toHaveBeenCalled();
  ready();
  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(0));
});

it('redirects every profile path before readiness and renders only after readiness', async () => {
  expect(await load('../src/main/slidegen/render-command.js')).toBeDefined();
  expect(mocks.app.setPath.mock.calls.map(([name]) => name)).toEqual([
    'appData',
    'userData',
    'sessionData',
    'logs',
    'temp',
    'cache',
    'crashDumps',
  ]);
  const profile = path.dirname(mocks.app.setPath.mock.calls[0][1]);
  expect(path.dirname(profile)).toBe(root);
  fs.writeFileSync(path.join(profile, 'temp/slide.html'), 'local');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'private.txt'), 'private');
  fs.symlinkSync(outside, path.join(profile, 'temp/link'), 'junction');
  expect(mocks.app.setPath.mock.invocationCallOrder.at(-1)).toBeLessThan(
    mocks.app.whenReady.mock.invocationCallOrder[0],
  );
  expect(mocks.render).not.toHaveBeenCalled();
  ready();
  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(0));
  expect(mocks.render).toHaveBeenCalledWith('report.slidegen', process.cwd(), { onPage: expect.any(Function) });
  expect(JSON.parse(output[0])).toMatchObject({ status: 'file-generated', fileCreated: true });
  const request = mocks.session.webRequest.onBeforeRequest.mock.calls[0][0];
  for (const [url, cancel] of [
    ['https://example.com/private', true],
    [pathToFileURL(path.join(root, 'outside.txt')).href, true],
    [pathToFileURL(path.join(profile, 'temp/slide.html')).href, false],
    [pathToFileURL(path.join(profile, 'temp/link/private.txt')).href, true],
    ['data:text/plain,allowed', false],
  ]) {
    const reply = vi.fn();
    request({ url }, reply);
    expect(reply).toHaveBeenCalledWith({ cancel });
  }
  const permission = mocks.session.setPermissionRequestHandler.mock.calls[0][0];
  const reply = vi.fn();
  permission(null, 'camera', reply);
  expect(reply).toHaveBeenCalledWith(false);
  expect(mocks.session.setPermissionCheckHandler).toHaveBeenCalledOnce();
  expect(mocks.session.setPermissionCheckHandler.mock.calls[0][0](null, 'camera', 'file://local')).toBe(false);
});

it.each([
  ['electron', 'app', '--royin-render-slidegen'],
  ['electron', 'app', '--royin-render-slidegen', 'report.slidegen', 'extra'],
  ['electron', 'app', '--royin-render-slidegen', '--royin-render-slidegen'],
])('reports invalid command arguments without starting the renderer', async (...args) => {
  process.argv = args;
  expect(await loadCommand()).toMatchObject({
    status: 'source-invalid',
    fileCreated: false,
    artifactIndexed: false,
    diagnostics: [{ code: 'source-argument-invalid' }],
  });
  expect(mocks.render).not.toHaveBeenCalled();
  expect(mocks.app.exit).toHaveBeenCalledWith(1);
});

it('preserves actual source diagnostics and failure exit code', async () => {
  mocks.render.mockResolvedValue({
    status: 'source-invalid',
    fileCreated: false,
    diagnostics: [{ code: 'slidegen-unparsable' }],
  });
  expect(await loadCommand()).toMatchObject({ diagnostics: [{ code: 'slidegen-unparsable' }] });
  expect(mocks.app.exit).toHaveBeenCalledWith(1);
});

it('reuses only the parent launcher profile instead of nesting another Chromium profile', async () => {
  const profile = path.join(root, 'royin-slidegen-launch-test');
  fs.mkdirSync(path.join(profile, 'temp'), { recursive: true });
  process.env.TEMP = path.join(profile, 'temp');
  process.env.TMP = process.env.TEMP;
  process.env.ROYIN_SLIDEGEN_PROFILE = profile;
  expect((await loadCommand()).status).toBe('file-generated');
  expect(mocks.app.setPath.mock.calls.every(([, directory]) => path.dirname(directory) === profile)).toBe(true);
});

it('rejects an unrelated requested profile without falling through to normal startup', async () => {
  process.env.ROYIN_SLIDEGEN_PROFILE = root;
  expect(await loadCommand()).toMatchObject({
    status: 'render-failed',
    diagnostics: [{ code: 'render-runtime-unavailable' }],
  });
  expect(mocks.app.setPath).not.toHaveBeenCalled();
  expect(mocks.render).not.toHaveBeenCalled();
  expect(mocks.normal).not.toHaveBeenCalled();
});

it('reports unexpected command failures without exposing exception contents', async () => {
  mocks.render.mockRejectedValue(new Error('secret-token'));
  expect(await loadCommand()).toMatchObject({
    status: 'render-failed',
    diagnostics: [{ code: 'render-command-failed' }],
  });
  expect(output.join('')).not.toContain('secret-token');
  expect(mocks.app.exit).toHaveBeenCalledWith(1);
});

it('writes real progress before its final report and ignores callbacks after terminal output', async () => {
  const progress = {
    schemaVersion: 1,
    status: 'slidegen-progress',
    sourceSha256: 'a'.repeat(64),
    completed: 1,
    total: 1,
  };
  mocks.render.mockImplementation(async (_file, _workspace, options) => {
    options.onPage(progress);
    expect(mocks.app.exit).not.toHaveBeenCalled();
    expect(output.map((line) => JSON.parse(line))).toEqual([progress]);
    return { status: 'file-generated', fileCreated: true, pages: 1 };
  });
  expect(await load('../src/main/slidegen/render-command.js')).toBeDefined();
  ready();
  await vi.waitFor(() => expect(mocks.app.exit).toHaveBeenCalledWith(0));
  expect(output.map((line) => JSON.parse(line))).toEqual([
    progress,
    { status: 'file-generated', fileCreated: true, pages: 1 },
  ]);
  mocks.render.mock.calls[0][2].onPage(progress);
  expect(output).toHaveLength(2);
});
