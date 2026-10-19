import { useEffect, useState, type ComponentType } from 'react';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { motion as motionPresets, motionDuration } from '@/styles/design-tokens';
import WindowTitlebar from '@/components/semantic/WindowTitlebar';
import SettingsNav, { type SettingsSection } from './SettingsNav';
import { useUiStore } from '@/stores/uiStore';
import ActivationSection from './sections/ActivationSection';
import AccountSection from './sections/AccountSection';
import GeneralSection from './sections/GeneralSection';
import SystemSection from './sections/SystemSection';
import GatewaysSection from './sections/GatewaysSection';
import AgentsSection from './sections/AgentsSection';
import SkillsSection from './sections/SkillsSection';
import ComputerAccessSection from './sections/ComputerAccessSection';
import PrivacySection from './sections/PrivacySection';
import MemorySection from './sections/MemorySection';
import RepairSection from './sections/RepairSection';
import ConnectorsSection from './sections/ConnectorsSection';
import AboutSection from './sections/AboutSection';
import type { OnboardingProfile } from '@/lib/user-onboarding';

const SECTION_COMPONENTS: Record<SettingsSection, ComponentType> = {
  activation: ActivationSection,
  account: AccountSection,
  general: GeneralSection,
  system: SystemSection,
  gateways: GatewaysSection,
  agents: AgentsSection,
  skills: SkillsSection,
  memory: MemorySection,
  computerAccess: ComputerAccessSection,
  privacy: PrivacySection,
  connectors: ConnectorsSection,
  repair: RepairSection,
  about: AboutSection,
};

interface SettingsProps {
  initialSection?: SettingsSection;
  onboardingProfile?: OnboardingProfile | null;
  onEditOnboardingProfile?: () => void;
}

export default function Settings({
  initialSection = 'general',
  onboardingProfile = null,
  onEditOnboardingProfile,
}: SettingsProps) {
  const { t } = useTranslation();
  const requestedSection = useUiStore((s) => s.settingsSection);
  const setRequestedSection = useUiStore((s) => s.setSettingsSection);
  const [activeSection, setActiveSection] = useState<SettingsSection>(initialSection);

  useEffect(() => {
    setActiveSection(initialSection);
  }, [initialSection]);

  // 外部请求落在某一页时（例如「有新版本可用」的提示点进来）用它。
  // ⚠️ 认不出的值必须**忽略** —— SECTION_COMPONENTS 取不到会渲染出空白页。
  // 读完即清，否则下次打开设置还会跳到这一页。
  useEffect(() => {
    if (!requestedSection) return;
    if (requestedSection in SECTION_COMPONENTS) {
      setActiveSection(requestedSection as SettingsSection);
    }
    setRequestedSection(null);
  }, [requestedSection, setRequestedSection]);

  const SectionComponent = SECTION_COMPONENTS[activeSection];

  return (
    <motion.div {...motionPresets.fadeIn} className="flex flex-col h-full">
      <WindowTitlebar
        left={<h2 className="type-section-title text-[var(--text-primary)]">{t('common.settings')}</h2>}
      />

      <div className="flex flex-1 min-h-0">
        <SettingsNav active={activeSection} onChange={setActiveSection} />

        <div className="flex-1 overflow-y-auto px-8 py-6">
          {/* Do NOT re-wrap this in <AnimatePresence>: with mode="wait" the new
              section never mounts (switching silently stops working), and with
              mode="popLayout" it deadlocks after a few switches. The key alone
              remounts the section and replays the fade-in. */}
          <motion.div
            key={activeSection}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: motionDuration.normal }}
          >
            {activeSection === 'account' ? (
              <AccountSection onboardingProfile={onboardingProfile} onEditProfile={onEditOnboardingProfile} />
            ) : (
              <SectionComponent />
            )}
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}
