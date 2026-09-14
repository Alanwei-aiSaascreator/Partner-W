import { describe, expect, it } from 'vitest';
import {
  PRESET_AGENT_DEFINITIONS,
  STARTER_AGENT_BY_ID,
  resolveAgentDisplayNameKey,
  resolveStarterAgentId,
} from '../src/renderer/lib/preset-agents';

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

  it('routes every starter to the matching professional assistant', () => {
    expect(STARTER_AGENT_BY_ID).toEqual({
      content: 'rongying-content',
      photography: 'rongying-video',
      office: 'rongying-office',
      research: 'rongying-research',
      ecommerce: 'rongying-ecommerce',
      family: 'rongying-family',
    });
  });

  it('uses the professional assistant only when it exists in the current gateway', () => {
    expect(resolveStarterAgentId('content', ['main', 'rongying-content'], 'main')).toBe('rongying-content');
    expect(resolveStarterAgentId('content', ['main'], 'main')).toBe('main');
  });

  it('maps internal assistant ids to customer-facing translation keys', () => {
    expect(resolveAgentDisplayNameKey('main')).toBe('mainArea.compassAssistant');
    expect(resolveAgentDisplayNameKey('rongying-video')).toBe('presetAgents.roles.video');
    expect(resolveAgentDisplayNameKey('custom-agent')).toBeNull();
  });
});
