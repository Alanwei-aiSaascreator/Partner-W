import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (relativePath) => readFileSync(resolve(repositoryRoot, relativePath), 'utf8');

test('PR CI runs portable update gates on Linux and builds a real PE on Windows without production secrets', () => {
  const workflow = read('.github/workflows/pr-check.yml');

  assert.match(workflow, /portable_update:/);
  assert.match(workflow, /- 'launcher\/\*\*'/);
  assert.match(workflow, /uses: actions\/setup-go@v7/);
  assert.match(workflow, /go-version-file: launcher\/go\.mod/);
  assert.match(workflow, /run: go -C launcher test \.\/\.\.\. -count=1/);
  assert.match(workflow, /run: pnpm check:portable-update-release/);

  const windowsJob = workflow.match(/\n  portable-update-windows:[\s\S]*?(?=\n  [a-z][a-z-]+:|$)/)?.[0] ?? '';
  assert.notEqual(windowsJob, '', 'portable-update-windows job is required');
  assert.match(windowsJob, /runs-on: windows-latest/);
  assert.match(windowsJob, /generateKeyPairSync/);
  assert.match(windowsJob, /run: pnpm build:portable-launcher/);
  assert.match(windowsJob, /Windows PE header/);
  assert.doesNotMatch(windowsJob, /secrets\./);
});

test('production portable release is environment-protected, three-secret gated, and always removes the key', () => {
  const workflow = read('.github/workflows/release.yml');

  assert.doesNotMatch(workflow, /^\s*pull_request:/m);
  assert.match(workflow, /portable-update-release:/);
  assert.match(workflow, /environment:\s*\n\s+name: portable-update-production/);
  for (const secret of [
    'PARTNERW_UPDATE_PUBLIC_KEY_B64',
    'PARTNERW_UPDATE_SIGNING_KEY_PEM',
    'PARTNERW_UPDATE_FEED_UPLOAD_TOKEN',
  ]) {
    assert.match(workflow, new RegExp(`secrets\\.${secret}`));
  }
  assert.match(workflow, /PARTNERW_PORTABLE_RELEASE_ENABLED/);
  assert.match(workflow, /PARTNERW_UPDATE_SIGNING_KEY_FILE/);
  assert.match(workflow, /if: always\(\)/);
  assert.match(workflow, /Remove temporary portable signing key/);
  assert.match(workflow, /pnpm update:portable-package/);
});

test('the root check fails on launcher and release gates before the TypeScript and Vitest suite', () => {
  const packageJson = JSON.parse(read('package.json'));
  const command = packageJson.scripts.check;
  const launcher = command.indexOf('pnpm check:portable-launcher');
  const release = command.indexOf('pnpm check:portable-update-release');
  const typecheck = command.indexOf('pnpm typecheck');

  assert.ok(launcher >= 0, 'root check must include the Go launcher gate');
  assert.ok(release > launcher, 'release gate must run after the launcher gate');
  assert.ok(typecheck > release, 'portable gates must fail before the TypeScript/Vitest suite');
});
