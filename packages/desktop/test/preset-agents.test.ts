import { describe, expect, it } from 'vitest';
import { PRESET_AGENT_DEFINITIONS } from '../src/renderer/lib/preset-agents';

describe('preset agent definitions', () => {
  it('ships the six approved assistants with stable unique identities', () => {
    expect(PRESET_AGENT_DEFINITIONS.map((agent) => agent.id)).toEqual([
      'rongying-content',
      'rongying-video',
      'rongying-office',
      'rongying-ecommerce',
      'rongying-research',
      'rongying-family',
    ]);

    expect(new Set(PRESET_AGENT_DEFINITIONS.map((agent) => agent.creationName)).size).toBe(6);
    for (const agent of PRESET_AGENT_DEFINITIONS) {
      expect(agent.creationName).toMatch(/^[a-z0-9-]+$/);
      expect(agent.identityMd.trim().length).toBeGreaterThan(80);
      expect(agent.soulMd).toContain('supplied facts');
      expect(agent.soulMd).toContain('assumptions');
      expect(agent.soulMd).toContain('unknowns');
      expect(agent.soulMd).toContain('Simplified Chinese');
    }
  });
});
