import { expect, it, vi } from 'vitest';
import { authorizeCreatedWorkflowAgent } from '../src/main/runtime/workflow-created-agent';

const agentId = 'partner-w-office';
const original = () => ({
  tools: {
    deny: ['memory_search', 'memory_get'],
    fs: { workspaceOnly: true },
    exec: { mode: 'ask' },
    elevated: { enabled: false },
  },
  plugins: { entries: { lobster: { enabled: true } } },
  agents: { ownership: 'explicit', entries: { main: {}, [agentId]: { workspace: 'owned' } } },
});
function fixture() {
  let current = true;
  const config = original();
  const getConfig = vi.fn(async () => ({ hash: 'revision', config: structuredClone(config) }));
  const patchConfig = vi.fn(async ({ raw }: { raw: string }) => {
    Object.assign(config.agents.entries[agentId], JSON.parse(raw).agents.entries[agentId]);
    return { ok: true };
  });
  const run = (id = agentId) =>
    authorizeCreatedWorkflowAgent({
      agentId: id,
      current: () => current,
      tx: { getConfig, patchConfig },
    });
  return {
    run,
    config,
    getConfig,
    patchConfig,
    invalidate: () => {
      current = false;
    },
  };
}
it('patches only the created system agent under CAS and verifies ACK/readback ownership', async () => {
  const f = fixture();
  expect(await f.run()).toBe(true);
  expect(f.patchConfig).toHaveBeenCalledWith({
    baseHash: 'revision',
    raw: JSON.stringify({ agents: { entries: { [agentId]: { tools: { alsoAllow: ['lobster'] } } } } }),
  });
  expect(f.config.agents.entries.main).toEqual({});
  expect(f.getConfig).toHaveBeenCalledTimes(2);
});
it('does not authorize unknown IDs or dispatch after the captured owner expires', async () => {
  const f = fixture();
  expect(await f.run('custom')).toBe(false);
  f.invalidate();
  expect(await f.run()).toBe(false);
  expect(f.getConfig).not.toHaveBeenCalled();
});
it.each(['profile', 'deny', 'plugin-disabled'])('preserves an explicit %s restriction', async (kind) => {
  const f = fixture();
  if (kind === 'plugin-disabled') f.config.plugins.entries.lobster.enabled = false;
  else
    Object.assign(f.config.agents.entries[agentId], {
      tools: kind === 'profile' ? { profile: 'minimal' } : { deny: ['lobster'] },
    });
  expect(await f.run()).toBe(false);
  expect(f.patchConfig).not.toHaveBeenCalled();
});
it.each(['snapshot', 'ack', 'readback'])('rejects owner replacement during %s await', async (stage) => {
  const f = fixture();
  if (stage === 'snapshot')
    f.getConfig.mockImplementationOnce(async () => {
      f.invalidate();
      return { hash: 'revision', config: f.config };
    });
  if (stage === 'ack')
    f.patchConfig.mockImplementationOnce(async () => {
      f.invalidate();
      return { ok: true };
    });
  if (stage === 'readback')
    f.getConfig
      .mockImplementationOnce(async () => ({ hash: 'revision', config: f.config }))
      .mockImplementationOnce(async () => {
        f.invalidate();
        return { hash: 'revision', config: f.config };
      });
  expect(await f.run()).toBe(false);
  if (stage === 'snapshot') expect(f.patchConfig).not.toHaveBeenCalled();
});
it('does not claim availability on missing ACK, unchanged readback, or mismatched readback', async () => {
  const missingAck = fixture();
  missingAck.patchConfig.mockResolvedValueOnce({ ok: false });
  await expect(missingAck.run()).rejects.toThrow(/ACK/);
  const unchanged = fixture();
  unchanged.patchConfig.mockResolvedValueOnce({ ok: true });
  await expect(unchanged.run()).rejects.toThrow(/readback/);
});
it('retries CAS conflicts with fresh policy and preserves a restriction added during the conflict', async () => {
  const f = fixture();
  f.patchConfig.mockImplementationOnce(async () => {
    Object.assign(f.config.agents.entries[agentId], { tools: { deny: ['lobster'] } });
    throw Object.assign(new Error('config changed since last load'), { code: 'INVALID_REQUEST' });
  });
  expect(await f.run()).toBe(false);
  expect(f.patchConfig).toHaveBeenCalledTimes(1);
});

it('confirms an existing grant idempotently and does not apply restart-only configuration', async () => {
  const f = fixture();
  expect(await f.run()).toBe(true);
  expect(await f.run()).toBe(true);
  expect(f.patchConfig).toHaveBeenCalledTimes(1);
  for (const mode of ['off', 'restart']) {
    const guarded = fixture();
    Object.assign(guarded.config, { gateway: { reload: { mode } } });
    expect(await guarded.run()).toBe(false);
    expect(guarded.patchConfig).not.toHaveBeenCalled();
  }
});
