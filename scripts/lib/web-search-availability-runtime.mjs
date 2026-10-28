import { createHash } from 'node:crypto';
export const WEB_SEARCH_AVAILABILITY_ENTRY = 'node_modules/openclaw/dist/openclaw-tools-INLTkEBK.mjs';
export const WEB_SEARCH_AVAILABILITY_SOURCE_SHA256 = '5d35c4c79bd70d6799ec91d0e3b4527ee56836949fc09835152b27c4e12a238d';
export const WEB_SEARCH_AVAILABILITY_PATCH_ID = 'partner-w-web-search-availability-v1';
const originalImport = 'import { o as runWebSearch } from "./runtime-BOsnJ2Zn.mjs";';
const patchedImport = 'import { o as runWebSearch, t as hasUsableWebSearchProvider } from "./runtime-BOsnJ2Zn.mjs";';
const entry =
  'function createWebSearchTool(options) {\n\tif (options?.enabled === false || isWebSearchDisabled(options?.config)) return null;';
const inserted = `
\tconst partner-wSearchContext = resolveWebSearchToolRuntimeContext({config:options?.config,lateBindRuntimeConfig:options?.lateBindRuntimeConfig,runtimeWebSearch:options?.runtimeWebSearch});
\tif (!hasUsableWebSearchProvider({config:partner-wSearchContext.config,agentDir:options?.agentDir,runtimeWebSearch:partner-wSearchContext.runtimeWebSearch,preferRuntimeProviders:partner-wSearchContext.preferRuntimeProviders})) return null;`;
export function patchWebSearchAvailabilityRuntime(source, expectedHash = WEB_SEARCH_AVAILABILITY_SOURCE_SHA256) {
  const alreadyPatched = source.includes(inserted);
  const original = alreadyPatched ? source.replace(inserted, '').replace(patchedImport, originalImport) : source;
  if (createHash('sha256').update(original).digest('hex') !== expectedHash)
    throw new Error('web search availability source hash drift');
  if (original.split(originalImport).length !== 2 || original.split(entry).length !== 2)
    throw new Error('web search availability anchor drift');
  if (alreadyPatched) return source;
  return original.replace(originalImport, patchedImport).replace(entry, entry + inserted);
}
