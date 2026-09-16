import { describe, expect, it } from 'vitest';
import type { OnboardingProfile } from '../src/renderer/lib/user-onboarding';
import {
  PRESET_AGENT_DEFINITIONS,
  STARTER_AGENT_BY_ID,
  resolveAgentDisplayNameKey,
  resolveStarterAgentId,
  resolveAssistantWorkspace,
  resolveProfileAssistantId,
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

  it('provides an independent workspace definition for every built-in assistant', () => {
    expect(resolveAssistantWorkspace('rongying-content')).toMatchObject({
      id: 'rongying-content',
      titleKey: 'presetAgents.roles.content',
      descriptionKey: 'assistantWorkspaces.content.description',
    });
    expect(resolveAssistantWorkspace('rongying-content')!.starters).toHaveLength(4);
    expect(resolveAssistantWorkspace('main')).toMatchObject({
      id: 'main',
      titleKey: 'mainArea.compassAssistant',
      descriptionKey: 'assistantWorkspaces.compass.description',
    });
    expect(resolveAssistantWorkspace('custom-agent')).toBeNull();
  });

  it('provides seven unique workspaces with four real starter prompts each', () => {
    const ids = ['main', ...PRESET_AGENT_DEFINITIONS.map((agent) => agent.id)];
    const definitions = ids.map((id) => resolveAssistantWorkspace(id)!);

    expect(new Set(definitions.map((definition) => definition.titleKey))).toHaveLength(7);
    for (const definition of definitions) {
      expect(definition.emoji.trim()).not.toBe('');
      expect(definition.descriptionKey).toMatch(/^assistantWorkspaces\.[^.]+\.description$/);
      expect(definition.starters).toHaveLength(4);
      expect(new Set(definition.starters.map((starter) => starter.titleKey))).toHaveLength(4);
      expect(new Set(definition.starters.map((starter) => starter.promptKey))).toHaveLength(4);
    }
  });

  it('recommends an available assistant from the profile without hiding the fallback', () => {
    const profile: OnboardingProfile = {
      version: 1 as const,
      userId: 'user-1',
      nickname: '',
      useCases: ['office', 'content'],
      customGoal: '',
      completedAt: '2026-09-16T00:00:00.000Z',
    };
    expect(resolveProfileAssistantId(profile, ['main', 'rongying-office', 'rongying-content'], 'main')).toBe(
      'rongying-office',
    );
    expect(resolveProfileAssistantId(profile, ['main', 'rongying-content'], 'main')).toBe('rongying-content');
    expect(resolveProfileAssistantId(profile, ['main'], 'main')).toBe('main');
    expect(resolveProfileAssistantId({ ...profile, useCases: ['office'] }, ['main', 'rongying-content'], 'main')).toBe(
      'main',
    );
  });

  it('bounds file exploration and prevents repeated directory scans', () => {
    for (const agent of PRESET_AGENT_DEFINITIONS) {
      expect(agent.soulMd).toContain('user-authorized target');
      expect(agent.soulMd).toContain('Do not repeat directory listings');
      expect(agent.soulMd).toContain('bounded batch operation');
      expect(agent.soulMd).toContain('Stop exploring');
    }
  });
});
