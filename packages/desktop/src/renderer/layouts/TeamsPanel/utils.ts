import { cn } from '@/lib/utils';
import type { AgentDraft } from './types';

/**
 * 名字 → 稳定的短后缀（FNV-1a）。
 *
 * ⚠️ **必须由名字决定，不能用 `Date.now()`**。中文名的字符会被下面的
 * `[^a-z0-9]+` 整串替掉 ⇒ 得到空串 ⇒ 走兜底分支。而向导里几个名字是在
 * **同一毫秒**里算出来的，取时间戳的话**几个不同的助手会得到同一个 slug**，
 * 于是 `step2Valid` 的"slug 不重复"判成重名 ⇒ 「下一步」永远是灰的、
 * 向导走不下去（2026-09-20 实机踩到；而中文助手正是主场景）。
 *
 * 换成名字的哈希之后：不同名字给不同值，同一个名字给同一个值
 * —— 后者才能让真正的"重名"被判出来。
 */
function nameSuffix(name: string): string {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function toSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `agent-${nameSuffix(name)}`
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
