import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from '../util/json-file.js';

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const read = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Only the product's unconstrained default receives a new optional tool grant. */
function isDefaultToolPolicy(value: unknown): boolean {
  if (value === undefined) return true;
  if (!record(value) || Object.keys(value).some((key) => !['deny', 'fs', 'exec', 'elevated'].includes(key)))
    return false;
  if (
    value.deny !== undefined &&
    (!Array.isArray(value.deny) || value.deny.some((tool) => !['memory_search', 'memory_get'].includes(tool)))
  )
    return false;
  return [
    ['fs', 'workspaceOnly', true],
    ['exec', 'mode', 'ask'],
    ['elevated', 'enabled', false],
  ].every(([section, key, expected]) => {
    const policy = value[section as string];
    return (
      policy === undefined || (record(policy) && Object.keys(policy).length === 1 && policy[key as string] === expected)
    );
  });
}

const SYSTEM_WORKFLOW_AGENTS = new Set([
  'main',
  'rongying-content',
  'rongying-video',
  'rongying-office',
  'rongying-ecommerce',
  'rongying-research',
  'rongying-family',
]);
function authorizeDefaultAgents(config: Record<string, unknown>): Record<string, unknown> | undefined {
  if (config.agents !== undefined && !record(config.agents)) throw new Error('Gateway agent configuration is invalid');
  const agents = record(config.agents) ? config.agents : {};
  if (
    (agents.list !== undefined && (!Array.isArray(agents.list) || agents.list.some((agent) => !record(agent)))) ||
    (agents.entries !== undefined &&
      (!record(agents.entries) || Object.values(agents.entries).some((agent) => !record(agent)))) ||
    (agents.defaults !== undefined && !record(agents.defaults))
  )
    throw new Error('Gateway agent roster or defaults are invalid');
  if (!isDefaultToolPolicy(config.tools)) return;
  if (record(agents.defaults) && !isDefaultToolPolicy(agents.defaults.tools)) return;
  let changed = false;
  const grant = (agent: unknown, id: string): unknown => {
    if (!SYSTEM_WORKFLOW_AGENTS.has(id) || !record(agent) || !isDefaultToolPolicy(agent.tools)) return agent;
    changed = true;
    return { ...agent, tools: { ...(record(agent.tools) ? agent.tools : {}), alsoAllow: ['lobster'] } };
  };
  const updated = { ...agents };
  if (Array.isArray(agents.list)) {
    updated.list = agents.list.map((agent) =>
      grant(agent, record(agent) && typeof agent.id === 'string' ? agent.id : ''),
    );
  } else if (record(agents.entries)) {
    updated.entries = Object.fromEntries(Object.entries(agents.entries).map(([id, agent]) => [id, grant(agent, id)]));
  } else {
    updated.entries = { main: grant({}, 'main') };
  }
  return changed ? updated : undefined;
}

/** Enable the verified supplied default, while keeping explicit plugin/tool policies intact. */
export function hasBundledWorkflowTool(deployedRoot: string): boolean {
  const marker = path.join(deployedRoot, 'manifest.json');
  if (!fs.existsSync(marker)) return false;
  const manifest = read(marker);
  const variants = record(manifest) && Array.isArray(manifest.runtimes) ? manifest.runtimes : [];
  const supplied = variants.some(
    (variant: unknown) =>
      record(variant) &&
      Array.isArray(variant.patches) &&
      variant.patches.includes('official-lobster-2026.9.3') &&
      variant.patches.includes('rongying-lobster-windows-state-v1'),
  );
  if (!supplied) return false;
  const plugin = path.join(deployedRoot, 'node_modules/openclaw/dist/extensions/lobster');
  const entry = path.join(plugin, 'dist/index.js');
  if (!fs.existsSync(entry) || !fs.lstatSync(entry).isFile() || fs.statSync(entry).size === 0)
    throw new Error('Required compiled Lobster plugin is missing');
  const metadata = read(path.join(plugin, 'package.json'));
  const contract = read(path.join(plugin, 'openclaw.plugin.json'));
  if (
    !record(metadata) ||
    metadata.name !== '@openclaw/lobster' ||
    metadata.version !== '2026.9.3' ||
    !record(contract) ||
    contract.id !== 'lobster' ||
    !record(contract.contracts) ||
    !Array.isArray(contract.contracts.tools) ||
    !contract.contracts.tools.includes('lobster')
  )
    throw new Error('Required Lobster plugin identity or tool contract changed');
  return true;
}

export function ensureBundledWorkflowTools(deployedRoot: string, stateDir: string): boolean {
  if (!hasBundledWorkflowTool(deployedRoot)) return false;
  const configPath = path.join(stateDir, 'openclaw.json');
  if (!fs.existsSync(configPath)) return false;
  const config = read(configPath);
  if (!record(config)) throw new Error('Owned gateway configuration must be an object');
  if (config.plugins !== undefined && !record(config.plugins)) throw new Error('Gateway plugin policy is invalid');
  const plugins = record(config.plugins) ? config.plugins : {};
  if (plugins.enabled === false) return false;
  if (Array.isArray(plugins.deny) && plugins.deny.includes('lobster')) return false;
  if (Array.isArray(plugins.allow) && !plugins.allow.includes('lobster')) return false;
  if (plugins.entries !== undefined && !record(plugins.entries)) throw new Error('Gateway plugin entries are invalid');
  const entries = record(plugins.entries) ? plugins.entries : {};
  if (entries.lobster !== undefined && !record(entries.lobster)) throw new Error('Gateway Lobster entry is invalid');
  const lobster = record(entries.lobster) ? entries.lobster : {};
  if (lobster.enabled !== undefined && typeof lobster.enabled !== 'boolean')
    throw new Error('Gateway Lobster enabled policy is invalid');
  if (lobster.enabled === false) return false;
  const authorizedAgents = authorizeDefaultAgents(config);
  if (lobster.enabled !== undefined && !authorizedAgents) return false;
  writeJsonAtomic(configPath, {
    ...config,
    ...(authorizedAgents ? { agents: authorizedAgents } : {}),
    plugins: { ...plugins, entries: { ...entries, lobster: { ...lobster, enabled: true } } },
  });
  return true;
}

/** A patch for an existing built-in agent only; plugin activation remains a startup decision. */
export function buildCreatedWorkflowAgentPatch(config: unknown, agentId: string): Record<string, unknown> | undefined {
  if (!SYSTEM_WORKFLOW_AGENTS.has(agentId) || !record(config)) return;
  const gateway = record(config.gateway) ? config.gateway : {};
  const reload = record(gateway.reload) ? gateway.reload : {};
  if (reload.mode === 'off' || reload.mode === 'restart') return;
  const plugins = record(config.plugins) ? config.plugins : {};
  const entries = record(plugins.entries) ? plugins.entries : {};
  if (
    plugins.enabled === false ||
    !record(entries.lobster) ||
    entries.lobster.enabled !== true ||
    (Array.isArray(plugins.deny) && plugins.deny.includes('lobster')) ||
    (Array.isArray(plugins.allow) && !plugins.allow.includes('lobster'))
  )
    return;
  const agents = authorizeDefaultAgents(config);
  const originalAgents = record(config.agents) ? config.agents : {};
  const originalEntries = record(originalAgents.entries) ? originalAgents.entries : {};
  const nextEntries = agents && record(agents.entries) ? agents.entries : {};
  const next = nextEntries[agentId];
  if (!record(originalEntries[agentId]) || !record(next) || next === originalEntries[agentId]) return;
  return { agents: { entries: { [agentId]: { tools: next.tools } } } };
}
export function isSystemWorkflowAgent(agentId: string): boolean {
  return SYSTEM_WORKFLOW_AGENTS.has(agentId);
}

export function hasCreatedWorkflowAgentGrant(config: unknown, agentId: string): boolean {
  if (!record(config) || !record(config.agents) || !record(config.agents.entries)) return false;
  const agent = config.agents.entries[agentId];
  if (
    !record(agent) ||
    !record(agent.tools) ||
    !Array.isArray(agent.tools.alsoAllow) ||
    agent.tools.alsoAllow.length !== 1 ||
    agent.tools.alsoAllow[0] !== 'lobster'
  )
    return false;
  const tools = { ...agent.tools };
  delete tools.alsoAllow;
  return Boolean(
    buildCreatedWorkflowAgentPatch(
      {
        ...config,
        agents: { ...config.agents, entries: { ...config.agents.entries, [agentId]: { ...agent, tools } } },
      },
      agentId,
    ),
  );
}
