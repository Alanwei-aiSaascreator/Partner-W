import { cn } from '@/lib/utils';
import type { AgentDraft } from './types';

export function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `agent-${Date.now()}`
  );
}

export const EMOJI_OPTIONS = [
  '🤖',
  '🧪',
  '🎯',
  '🚀',
  '💡',
  '🔧',
  '📊',
  '🎨',
  '🛡️',
  '📦',
  '🌐',
  '⚡',
  '🔬',
  '📝',
  '🎲',
  '🧩',
  '🏗️',
  '💻',
  '🔍',
  '🤝',
  '📡',
  '🧠',
  '🌟',
  '🎵',
];

export const inputClass = cn(
  'w-full h-[var(--density-control-height)] px-3 rounded-md',
  'bg-[var(--bg-primary)] border border-[var(--border)]',
  'text-[var(--text-primary)] placeholder:text-[var(--text-muted)]',
  'glow-focus focus:border-transparent transition-all',
);

/**
 * 新建一个成员草稿。
 *
 * `position` 给个**默认值**（协调者=主持人、其余=领域专家）：圆桌要求按职位排顺序，
 * 一个都没填的话所有人都是领域专家，"主持人先定口径"这件事就没了。
 */
export function createAgentDraft(role: 'coordinator' | 'worker'): AgentDraft {
  return {
    uid: crypto.randomUUID(),
    name: '',
    description: '',
    role,
    position: role === 'coordinator' ? 'moderator' : 'expert',
    model: '',
    agentMd: '',
    soulMd: '',
    skills: [],
  };
}
