import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
const helperUrl = new URL('./web-search-availability-runtime.mjs', import.meta.url);
const source = `import { o as runWebSearch } from "./runtime-BOsnJ2Zn.mjs";
function createWebSearchTool(options) {
\tif (options?.enabled === false || isWebSearchDisabled(options?.config)) return null;
\treturn {name:"web_search"};
}`;
const hash = createHash('sha256').update(source).digest('hex');
test('omits registered search when the actual provider selection is unavailable', async () => {
  const { patchWebSearchAvailabilityRuntime } = await import(helperUrl);
  const patched = patchWebSearchAvailabilityRuntime(source, hash);
  const factory = new Function(
    'isWebSearchDisabled',
    'resolveWebSearchToolRuntimeContext',
    'hasUsableWebSearchProvider',
    patched.replace(/^import[^\n]+\n/, '') + ';return createWebSearchTool;',
  )(
    () => false,
    () => ({ config: {}, preferRuntimeProviders: true }),
    () => false,
  );
  assert.equal(factory({ config: { tools: { web: { search: { enabled: true } } } } }), null);
});
test('keeps a configured usable provider and preserves explicit disabled search', async () => {
  const { patchWebSearchAvailabilityRuntime } = await import(helperUrl);
  const patched = patchWebSearchAvailabilityRuntime(source, hash);
  const factory = new Function(
    'isWebSearchDisabled',
    'resolveWebSearchToolRuntimeContext',
    'hasUsableWebSearchProvider',
    patched.replace(/^import[^\n]+\n/, '') + ';return createWebSearchTool;',
  )(
    (cfg) => cfg.disabled,
    (options) => ({ config: options.config, preferRuntimeProviders: true }),
    () => true,
  );
  assert.equal(factory({ config: {} }).name, 'web_search');
  assert.equal(factory({ config: { disabled: true } }), null);
  assert.equal(factory({ enabled: false, config: {} }), null);
  assert.equal(patchWebSearchAvailabilityRuntime(patched, hash), patched);
  assert.throws(() => patchWebSearchAvailabilityRuntime(source + '\n// unexpected drift', hash), /hash|drift/);
});
