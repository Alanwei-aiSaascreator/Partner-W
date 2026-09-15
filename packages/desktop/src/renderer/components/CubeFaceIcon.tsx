import { cn } from '@/lib/utils';

interface CubeFaceIconProps {
  agentId: string;
  size?: number;
  className?: string;
}

const TONES = [
  '[--cube-face:var(--accent)]',
  '[--cube-face:var(--info)]',
  '[--cube-face:var(--warning)]',
  '[--cube-face:var(--danger)]',
] as const;

function toneFor(agentId: string): (typeof TONES)[number] {
  const hash = [...agentId].reduce((total, character) => total + character.charCodeAt(0), 0);
  return TONES[hash % TONES.length];
}

export default function CubeFaceIcon({ agentId, size = 32, className }: CubeFaceIconProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'relative inline-grid flex-shrink-0 grid-cols-2 overflow-hidden rounded-lg bg-[var(--bg-tertiary)] ring-1 ring-inset ring-[var(--border-accent)]',
        toneFor(agentId),
        className,
      )}
      style={{ width: size, height: size }}
    >
      <span className="bg-[var(--cube-face)] opacity-90" />
      <span className="bg-[var(--cube-face)] opacity-50" />
      <span className="col-span-2 bg-[var(--cube-face)] opacity-70" />
      <span className="absolute left-1/2 top-1/2 h-[42%] w-[42%] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[2px] border border-[var(--accent-foreground)] opacity-75" />
    </span>
  );
}
