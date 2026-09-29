interface EnsureSkillsResult {
  ok: boolean;
  result?: {
    installed: string[];
    failed: Array<{ slug: string; error: string }>;
  };
  error?: string;
}

interface EnsureBundledSkillsDeps {
  ensure: (gatewayId: string) => Promise<EnsureSkillsResult>;
  sleep: (ms: number) => Promise<void>;
  delaysMs: readonly number[];
}

export async function ensureBundledSkillsWithRetry(gatewayId: string, deps: EnsureBundledSkillsDeps): Promise<boolean> {
  for (let attempt = 0; attempt <= deps.delaysMs.length; attempt += 1) {
    try {
      const result = await deps.ensure(gatewayId);
      if (result.ok && result.result && result.result.failed.length === 0) return true;
    } catch {}
    const delay = deps.delaysMs[attempt];
    if (delay === undefined) break;
    await deps.sleep(delay);
  }
  return false;
}
