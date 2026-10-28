import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

test('requires configured Lobster and checks actual session tools before any example call', async () => {
  const { patchTaskflowSkillSource } = await import('./taskflow-skill-availability.mjs');
  const source =
    '---\nname: taskflow\nmetadata: { "openclaw": { "emoji": "test" } }\n---\n\n# TaskFlow\n\nExample action run and exact flow revision.\n';
  const hash = createHash('sha256').update(source).digest('hex');
  const patched = patchTaskflowSkillSource(source, hash);
  assert.deepEqual(JSON.parse(patched.match(/^metadata: (.+)$/m)[1]).openclaw.requires.config, [
    'plugins.entries.lobster.enabled',
  ]);
  assert.ok(patched.indexOf('current session') < patched.indexOf('Example action run'));
  assert.match(patched, /If `lobster` is absent.*stop before calling/s);
  assert.match(patched, /Do not retry.*unavailable/s);
  assert.ok(patched.includes('exact flow revision'));
  assert.throws(() => patchTaskflowSkillSource(`${source}\n`, hash), /changed/);
});
