import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  APP_DIR_NAME,
  ASAR_REL,
  auditDelivery,
  BUNDLED_RUNTIME_MANIFEST_REL,
  EXE_REL,
  INSTALLER_DIR_PREFIX,
  LAUNCHER_BAT_NAME,
  LAUNCHER_EXE_NAME,
  README_NAME,
  RUN_DATA_DIR_NAME,
  UPDATE_DIR_NAME,
  WORKSPACE_DIR_NAME,
} from './udisk-delivery.mjs';

const roots = [];
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const io = {
  exists: (target) => fs.existsSync(target),
  listNames: (target) => fs.readdirSync(target),
  readFile: (target) => {
    try {
      return fs.readFileSync(target);
    } catch {
      return null;
    }
  },
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeDelivery(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-delivery-'));
  roots.push(root);
  const write = (relativePath, content) => {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };

  write(LAUNCHER_EXE_NAME, Buffer.from('MZlauncher'));
  write(EXE_REL, 'desktop');
  write(ASAR_REL, 'asar');
  write(BUNDLED_RUNTIME_MANIFEST_REL, '{}');
  write(
    README_NAME,
    `\u53cc\u51fb ${LAUNCHER_EXE_NAME}\u3002\u6570\u636e\u4fdd\u5b58\u5728 ${RUN_DATA_DIR_NAME}\u3002\u8bf7\u4fdd\u6301\u76d8\u7b26\u4e0d\u53d8\u3002`,
  );

  if (overrides.noLauncher) fs.rmSync(path.join(root, LAUNCHER_EXE_NAME));
  if (overrides.bat) write(LAUNCHER_BAT_NAME, '@echo off');
  if (overrides.noRuntime) fs.rmSync(path.join(root, BUNDLED_RUNTIME_MANIFEST_REL));
  if (overrides.installer) write(`${INSTALLER_DIR_PREFIX}/setup.exe`, 'installer');
  if (overrides.launcherInsideProgram) write(path.join(APP_DIR_NAME, LAUNCHER_EXE_NAME), 'wrong-place');
  if (overrides.prepopulated) {
    write(path.join(RUN_DATA_DIR_NAME, 'state.json'), '{}');
    write(path.join(WORKSPACE_DIR_NAME, 'task.txt'), 'task');
    write(path.join(UPDATE_DIR_NAME, 'update-state.json'), '{}');
  }
  return root;
}

const ids = (findings) => findings.map((finding) => finding.id);
const errors = (findings) => findings.filter((finding) => finding.level === 'error');

test('clean launcher-enabled delivery satisfies the exact base-package contract', () => {
  const root = makeDelivery();

  assert.deepEqual(auditDelivery(io, root), []);
});

test('missing root launcher is a release-blocking error', () => {
  const root = makeDelivery({ noLauncher: true });

  assert.ok(ids(auditDelivery(io, root)).includes('missing-launcher'));
});

test('any batch launcher is a release-blocking error', () => {
  const root = makeDelivery({ bat: true });
  const finding = auditDelivery(io, root).find((entry) => entry.id === 'launcher-bat');

  assert.equal(finding?.level, 'error');
});

test('delivery CLI rejects a batch file nested inside the program tree', () => {
  const root = makeDelivery();
  const nestedBatch = path.join(root, APP_DIR_NAME, 'resources', 'legacy.bat');
  fs.writeFileSync(nestedBatch, '@echo off');

  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'udisk-delivery.mjs'), root], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /legacy\.bat/);
});

test('missing bundled runtime is a release-blocking error', () => {
  const root = makeDelivery({ noRuntime: true });

  assert.ok(ids(auditDelivery(io, root)).includes('missing-bundled-runtime'));
});

test('installer content is rejected instead of being downgraded to a warning', () => {
  const root = makeDelivery({ installer: true });
  const finding = auditDelivery(io, root).find((entry) => entry.id === 'installer-folder');

  assert.equal(finding?.level, 'error');
});

test('a launcher inside the replaceable program directory is rejected', () => {
  const root = makeDelivery({ launcherInsideProgram: true });

  assert.ok(ids(auditDelivery(io, root)).includes('launcher-inside-program'));
});

test('pre-populated data, workspace, and update directories are rejected', () => {
  const root = makeDelivery({ prepopulated: true });
  const findings = auditDelivery(io, root);

  assert.ok(ids(findings).includes('prepopulated-data'));
  assert.ok(ids(findings).includes('prepopulated-workspace'));
  assert.ok(ids(findings).includes('prepopulated-update'));
  assert.equal(errors(findings).length, 3);
});

test('assemble CLI copies only launcher, program, and instructions into an empty output', () => {
  const source = makeDelivery();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'udisk-assembled-'));
  roots.push(out);
  const result = spawnSync(
    process.execPath,
    [
      path.join(repositoryRoot, 'scripts', 'assemble-udisk-delivery.mjs'),
      '--app-dir',
      path.join(source, APP_DIR_NAME),
      '--launcher',
      path.join(source, LAUNCHER_EXE_NAME),
      '--out',
      out,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(fs.readdirSync(out).sort(), [APP_DIR_NAME, LAUNCHER_EXE_NAME, README_NAME].sort());
  assert.equal(fs.existsSync(path.join(out, RUN_DATA_DIR_NAME)), false);
  assert.equal(fs.existsSync(path.join(out, WORKSPACE_DIR_NAME)), false);
  assert.equal(fs.existsSync(path.join(out, UPDATE_DIR_NAME)), false);
  assert.deepEqual(auditDelivery(io, out), []);
});
