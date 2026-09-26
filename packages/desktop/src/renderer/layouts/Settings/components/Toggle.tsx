import { cn } from '@/lib/utils';

export default function Toggle({
  checked,
  onChange,
  ariaLabel,
  size = 'md',
  dataAction,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel?: string;
  size?: 'sm' | 'md';
  /** 给测试/自动化用的稳定选点（本仓库惯例：文案会随语言变，选点不能）。 */
  dataAction?: string;
  /** 忙的时候不许再点（切换是两次网络往返，连点会打架）。 */
  disabled?: boolean;
}) {
  const isSmall = size === 'sm';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      data-action={dataAction}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-flex flex-shrink-0 cursor-pointer rounded-full p-0.5 transition-colors duration-200',
        isSmall ? 'h-5 w-9' : 'h-6 w-11',
        'focus-visible:outline-none glow-focus',
        checked ? 'bg-[var(--accent)]' : 'bg-[var(--bg-tertiary)] border border-[var(--border)]',
      )}
    >
      <span
        className={cn(
          'pointer-events-none block rounded-full bg-[var(--bg-elevated)] shadow-[var(--shadow-card)]',
          'transition-transform duration-200',
          isSmall ? 'h-4 w-4' : 'h-5 w-5',
          checked ? (isSmall ? 'translate-x-4' : 'translate-x-5') : 'translate-x-0',
        )}
      />
    </button>
  );
}
