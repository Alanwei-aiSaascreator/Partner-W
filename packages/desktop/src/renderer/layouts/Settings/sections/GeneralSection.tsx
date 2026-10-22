import { useState, useEffect, useCallback, useMemo } from 'react';
import { Moon, Sun, Monitor, Bell, Smartphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { modKey } from '@/lib/utils';
import {
  useUiStore,
  type Theme,
  type DensityMode,
  type Language,
  type SendShortcut,
  type PanelShortcutLeft,
  type PanelShortcutRight,
} from '@/stores/uiStore';
import { SUPPORTED_LANGUAGES } from '@/i18n/languages';
import SettingRow from '@/components/semantic/SettingRow';
import { Button } from '@/components/ui/button';
import SegmentedControl from '../components/SegmentedControl';
import Toggle from '../components/Toggle';
import SettingGroup from '@/components/semantic/SettingGroup';
import PairMobileDialog from '../components/PairMobileDialog';
import RemoteDevicesPanel from '../components/RemoteDevicesPanel';
import { useSettingsStore } from '@/stores/settingsStore';
import { isMascotHidden, setMascotHidden, subscribeMascotVisibility } from '@/lib/mascot-visibility';

export default function GeneralSection() {
  const { t } = useTranslation();
  const [showPairDialog, setShowPairDialog] = useState(false);
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const language = useUiStore((s) => s.language);
  const setLanguage = useUiStore((s) => s.setLanguage);
  const sendShortcut = useUiStore((s) => s.sendShortcut);
  const setSendShortcut = useUiStore((s) => s.setSendShortcut);
  const leftNavShortcut = useUiStore((s) => s.leftNavShortcut);
  const setLeftNavShortcut = useUiStore((s) => s.setLeftNavShortcut);
  const rightPanelShortcut = useUiStore((s) => s.rightPanelShortcut);
  const setRightPanelShortcut = useUiStore((s) => s.setRightPanelShortcut);
  const notifications = useSettingsStore((s) => s.settings?.notifications);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  /**
   * ⚠️ 1.0.11 起设置里不再有 `settings.gateways`（网关身份改由 `useUiStore.defaultGatewayId` 表达）。
   *    沿用它会让条件恒为 false —— 真机现象就是「设置里根本没有『移动端』这一栏，检测不到配对入口」。
   *    配对入口是增强能力，缺网关时让面板自己报错，不该整块隐藏。
   */
  const settingsGatewayId = useSettingsStore(
    (s) => (s.settings as { defaultGatewayId?: string } | undefined)?.defaultGatewayId,
  );
  const uiGatewayId = useUiStore((s) => s.defaultGatewayId);
  const remoteGatewayId = settingsGatewayId ?? uiGatewayId ?? 'local';
  const mobilePairingAvailable = settingsLoaded || Boolean(uiGatewayId);
  const loadSettings = useSettingsStore((s) => s.load);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const handleThemeToggle = useCallback(
    (next: Theme) => {
      setTheme(next);
      toast.success(t('settings.themeUpdated'));
    },
    [setTheme, t],
  );

  const handleDensityChange = useCallback(
    (next: DensityMode) => {
      setDensity(next);
      toast.success(t('settings.densityUpdated'));
    },
    [setDensity, t],
  );

  const handleShortcutChange = useCallback(
    (next: SendShortcut) => {
      if (next === sendShortcut) return;
      setSendShortcut(next);
      toast.success(t('settings.shortcutUpdated'));
    },
    [sendShortcut, setSendShortcut, t],
  );

  const handleLeftNavShortcutChange = useCallback(
    (next: PanelShortcutLeft) => {
      if (next === leftNavShortcut) return;
      setLeftNavShortcut(next);
      toast.success(t('settings.shortcutUpdated'));
    },
    [leftNavShortcut, setLeftNavShortcut, t],
  );

  const handleRightPanelShortcutChange = useCallback(
    (next: PanelShortcutRight) => {
      if (next === rightPanelShortcut) return;
      setRightPanelShortcut(next);
      toast.success(t('settings.shortcutUpdated'));
    },
    [rightPanelShortcut, setRightPanelShortcut, t],
  );

  useEffect(() => {
    if (settingsLoaded) return;
    void loadSettings().catch((err: unknown) => {
      console.error('[GeneralSection] loadSettings failed:', err);
    });
  }, [settingsLoaded, loadSettings]);

  const notifyState = useMemo(
    () => ({
      taskComplete: notifications?.taskComplete ?? true,
      approvalRequest: notifications?.approvalRequest ?? true,
      gatewayDisconnect: notifications?.gatewayDisconnect ?? true,
    }),
    [notifications?.approvalRequest, notifications?.gatewayDisconnect, notifications?.taskComplete],
  );

  /**
   * ⭐ 联网搜索开关。
   *
   * ⚠️ 改完**要重新应用一次中转配置**：这个开关是写进**网关配置**里的
   *    （按模型注入 `params.extra_body.enable_search`），不是在客户端这边判断的，
   *    所以光存下来不生效。用现成的重启入口（它只排队，不会卡住界面）。
   */
  // 「小盈」显隐（2026-10-18）：关掉之后必须有回头路，否则一次误触等于永久消失。
  const [mascotVisible, setMascotVisible] = useState(() => !isMascotHidden());
  useEffect(() => subscribeMascotVisibility(() => setMascotVisible(!isMascotHidden())), []);
  const handleMascotToggle = useCallback((value: boolean) => {
    setMascotHidden(!value);
  }, []);
  /** 直接打开桌面小盈（2026-10-18：浮宠被藏起来后，桌面宠物的入口不能也跟着消失）。 */
  const handleOpenDesktopMascot = useCallback(() => {
    void window.clawwork.petOpen?.();
  }, []);

  const webSearchSetting = useSettingsStore((s) => s.settings?.webSearch);
  // ⚠️ 缺省按**开**：老盘升级上来没有这个字段，按关处理等于静默拿走一个功能
  const webSearch = webSearchSetting !== false;
  const handleWebSearchToggle = useCallback(
    (value: boolean) => {
      void updateSettings({ webSearch: value })
        .then(() => window.clawwork.commercialRelayBootstrapRetry())
        .catch((err: unknown) => {
          console.error('[GeneralSection] updateSettings failed:', err);
        });
    },
    [updateSettings],
  );

  const handleNotificationToggle = useCallback(
    (key: 'taskComplete' | 'approvalRequest' | 'gatewayDisconnect', value: boolean) => {
      const next = { ...notifyState, [key]: value };
      void updateSettings({ notifications: next }).catch((err: unknown) => {
        console.error('[GeneralSection] updateSettings failed:', err);
      });
    },
    [notifyState, updateSettings],
  );

  const notificationToggles = [
    { key: 'taskComplete' as const, i18nKey: 'settings.notifyTaskComplete' },
    { key: 'approvalRequest' as const, i18nKey: 'settings.notifyApproval' },
    { key: 'gatewayDisconnect' as const, i18nKey: 'settings.notifyDisconnect' },
  ];

  return (
    <div className="space-y-8">
      <div>
        <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.general')}</h3>
        <SettingGroup>
          <SettingRow label={t('settings.theme')}>
            <SegmentedControl
              layoutId="seg-theme"
              value={theme}
              onChange={handleThemeToggle}
              ariaLabel={t('settings.theme')}
              options={[
                {
                  value: 'auto' as const,
                  label: (
                    <>
                      <Monitor size={14} /> {t('settings.themeAuto')}
                    </>
                  ),
                },
                {
                  value: 'dark' as const,
                  label: (
                    <>
                      <Moon size={14} /> {t('common.dark')}
                    </>
                  ),
                },
                {
                  value: 'light' as const,
                  label: (
                    <>
                      <Sun size={14} /> {t('common.light')}
                    </>
                  ),
                },
              ]}
            />
          </SettingRow>
          <SettingRow label={t('settings.density')}>
            <SegmentedControl
              layoutId="seg-density"
              value={density}
              onChange={handleDensityChange}
              ariaLabel={t('settings.density')}
              options={[
                { value: 'compact' as const, label: t('settings.densityCompact') },
                { value: 'comfortable' as const, label: t('settings.densityComfortable') },
                { value: 'spacious' as const, label: t('settings.densitySpacious') },
              ]}
            />
          </SettingRow>
          <SettingRow label={t('settings.language')}>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value as Language)}
              aria-label={t('settings.language')}
              className="glow-focus type-body rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[var(--text-primary)]"
            >
              {SUPPORTED_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow label={t('settings.sendShortcut')}>
            <SegmentedControl
              layoutId="seg-send"
              value={sendShortcut}
              onChange={handleShortcutChange}
              ariaLabel={t('settings.sendShortcut')}
              options={[
                { value: 'enter' as const, label: t('settings.sendEnter') },
                { value: 'cmdEnter' as const, label: t('settings.sendCmdEnter', { mod: modKey }) },
              ]}
            />
          </SettingRow>
          <SettingRow label={t('settings.leftNavShortcut')}>
            <SegmentedControl
              layoutId="seg-left-nav"
              value={leftNavShortcut}
              onChange={handleLeftNavShortcutChange}
              ariaLabel={t('settings.leftNavShortcut')}
              options={[
                { value: 'Comma' as const, label: `${modKey} ,` },
                { value: 'BracketLeft' as const, label: `${modKey} [` },
              ]}
            />
          </SettingRow>
          <SettingRow label={t('settings.rightPanelShortcut')}>
            <SegmentedControl
              layoutId="seg-right-panel"
              value={rightPanelShortcut}
              onChange={handleRightPanelShortcutChange}
              ariaLabel={t('settings.rightPanelShortcut')}
              options={[
                { value: 'Period' as const, label: `${modKey} .` },
                { value: 'BracketRight' as const, label: `${modKey} ]` },
              ]}
            />
          </SettingRow>
        </SettingGroup>
      </div>

      <div>
        <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.webSearchSection')}</h3>
        <SettingGroup>
          <SettingRow label={t('settings.webSearch')} description={t('settings.webSearchHint')}>
            <Toggle checked={webSearch} onChange={handleWebSearchToggle} ariaLabel={t('settings.webSearch')} />
          </SettingRow>
          <SettingRow label={t('settings.showMascot')} description={t('settings.showMascotHint')}>
            <Toggle checked={mascotVisible} onChange={handleMascotToggle} ariaLabel={t('settings.showMascot')} />
          </SettingRow>
          <SettingRow
            label={t('settings.desktopMascot')}
            description={t('settings.desktopMascotHint')}
          >
            <Button variant="outline" size="sm" onClick={handleOpenDesktopMascot} data-testid="open-desktop-mascot">
              {t('settings.desktopMascotOpen')}
            </Button>
          </SettingRow>
        </SettingGroup>
      </div>

      <div>
        <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.notifications')}</h3>
        <SettingGroup>
          {notificationToggles.map(({ key, i18nKey }) => (
            <SettingRow
              key={key}
              label={
                <div className="flex items-center gap-3">
                  <Bell size={14} className="text-[var(--text-muted)] flex-shrink-0" />
                  <span className="type-label text-[var(--text-primary)]">{t(i18nKey)}</span>
                </div>
              }
            >
              <Toggle
                checked={notifyState[key]}
                onChange={(v) => handleNotificationToggle(key, v)}
                ariaLabel={t(i18nKey)}
              />
            </SettingRow>
          ))}
        </SettingGroup>
      </div>

      {mobilePairingAvailable && (
        <div>
          <h3 className="type-section-title mb-4 text-[var(--text-primary)]">{t('settings.mobile')}</h3>
          <SettingGroup>
            <SettingRow
              label={
                <div className="flex items-center gap-3">
                  <Smartphone size={14} className="flex-shrink-0 text-[var(--text-muted)]" />
                  <span className="type-label text-[var(--text-primary)]">{t('settings.pairMobile')}</span>
                </div>
              }
            >
              <button
                onClick={() => setShowPairDialog(true)}
                className="glow-focus type-label rounded-lg border border-[var(--border)] px-3 py-1.5 text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]"
              >
                {t('settings.pairMobileButton')}
              </button>
            </SettingRow>
            <RemoteDevicesPanel gatewayId={remoteGatewayId} />
          </SettingGroup>
        </div>
      )}

      {mobilePairingAvailable && <PairMobileDialog open={showPairDialog} onOpenChange={setShowPairDialog} />}
    </div>
  );
}
