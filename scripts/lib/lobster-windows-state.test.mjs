import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const source = `import path from 'node:path';
import fs from 'node:fs/promises';
const visited = [];
async function syncDirectory(dir) { assertDirectory(await fs.stat(dir)); visited.push(dir); }
function assertDirectory(stat) { if (!stat.isDirectory()) throw Error('not a directory'); }
export async function syncCreatedDirectoryChain(firstCreated, finalDir) {
    const final = path.resolve(finalDir);
    let current = path.resolve(firstCreated);
    await syncDirectory(path.dirname(current));
    while (current !== final) {
        await syncDirectory(current);
        const relative = path.relative(current, final);
        const next = relative.split(path.sep)[0];
        if (!next || next === "..") break;
        current = path.join(current, next);
    }
}
export { visited };`;
const digest = createHash('sha256').update(source).digest('hex');

test('fresh Windows namespaced mkdir paths sync only real ancestors and reach the final directory', async (t) => {
  const { patchLobsterWindowsStateSource } = await import('./lobster-windows-state.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lobster-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const final = path.join(root, 'new', 'nested', 'state');
  const firstCreated = await fs.mkdir(final, { recursive: true });
  const patched = patchLobsterWindowsStateSource(source, digest);
  const module = await import(`data:text/javascript;base64,${Buffer.from(patched).toString('base64')}`);
  await module.syncCreatedDirectoryChain(path.toNamespacedPath(firstCreated), final);
  assert.equal(module.visited.length, 3);
  assert.equal(module.visited.at(-1), path.toNamespacedPath(path.dirname(final)));
});

test('rejects upstream state source drift before applying a compatibility patch', async () => {
  const { patchLobsterWindowsStateSource } = await import('./lobster-windows-state.mjs');
  assert.throws(() => patchLobsterWindowsStateSource(`${source}\n`, digest), /source.*changed/i);
});
