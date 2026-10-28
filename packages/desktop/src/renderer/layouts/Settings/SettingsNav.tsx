import { motion } from 'framer-motion';
import {
  Settings2,
  MonitorDot,
  Server,
  Bot,
  Blocks,
  Info,
  ShieldCheck,
  Brain,
  Laptop,
  Stethoscope,
  Plug,
  Cpu,
  PlugZap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { motionSpring } from '@/styles/design-tokens';

export type SettingsSection =
  | 'general'
  | 'system'
  | 'gateways'
  | 'agents'
  | 'skills'
  | 'memory'
  | 'computerAccess'
  | 'privacy'
  | 'connectors'
  | 'modelApi'
  | 'relayApi'
  | 'repair'
  | 'about';

const NAV_ITEMS: { key: SettingsSection; icon: typeof Settings2; labelKey: string }[] = [
  { key: 'general', icon: Settings2, labelKey: 'settings.general' },
  { key: 'system', icon: MonitorDot, labelKey: 'settings.system' },
  { key: 'gateways', icon: Server, labelKey: 'settings.gateways' },
  { key: 'agents', icon: Bot, labelKey: 'settings.agents' },
  { key: 'skills', icon: Blocks, labelKey: 'settings.skills' },
  { key: 'memory', icon: Brain, labelKey: 'settings.memory' },
  // 放在「隐私与数据」**上面**：它管的是助手能碰什么，比数据导出更该被看见。
  { key: 'computerAccess', icon: Laptop, labelKey: 'settings.computerAccess' },
  { key: 'privacy', icon: ShieldCheck, labelKey: 'settings.privacy' },
  // 连接器（飞书等外部通道）：它是「把能力接出去」，与「数据留在本机」同一层级的用户可见设置。
  { key: 'connectors', icon: Plug, labelKey: 'settings.connectors.nav' },
  // 模型 API（BYOK）：私有化/开源版里用户自配模型服务的入口，放在连接器之后、修复之前。
  { key: 'modelApi', icon: Cpu, labelKey: 'settings.modelApi' },
  // 官方 API（relay 中继）：与官网同价、不盈利的模型服务，紧跟 BYOK。
  { key: 'relayApi', icon: PlugZap, labelKey: 'settings.relayApi' },
  // 放在「关于」**上面**：它是"出事了先来这里"，比版本号更需要被看见。
  { key: 'repair', icon: Stethoscope, labelKey: 'settings.repair.nav' },
  { key: 'about', icon: Info, labelKey: 'settings.about' },
];

export default function SettingsNav({
  active,
  onChange,
}: {
  active: SettingsSection;
  onChange: (section: SettingsSection) => void;
}) {
  const { t } = useTranslation();

  return (
    <nav className="w-44 flex-shrink-0 border-r border-[var(--border-subtle)] py-4 px-3 space-y-1">
      {NAV_ITEMS.map((item) => {
        const Icon = item.icon;
        const isActive = active === item.key;
        return (
          <button
            key={item.key}
            type="button"
            onClick={() => onChange(item.key)}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'glow-focus type-label relative flex items-center gap-2.5 w-full h-9 px-3 rounded-lg transition-colors cursor-pointer',
              isActive ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
            )}
          >
            {isActive && (
              <motion.div
                layoutId="settings-nav-active"
                className="absolute inset-0 rounded-lg bg-[var(--accent-dim)] border border-[var(--border-accent)]"
                transition={motionSpring.snappy}
              />
            )}
            <Icon size={16} className={cn('relative z-10 flex-shrink-0', isActive && 'text-[var(--accent)]')} />
            <span className="relative z-10">{t(item.labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}
