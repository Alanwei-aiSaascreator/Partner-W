import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { useUiStore } from '@/stores/uiStore';

/**
 * 启动后查一次更新（T-U3）。
 *
 * 「只亮一个红点」对远程/无人值守的用户等于没有：他们不会主动进设置翻。所以这里在
 * 发现新版本时给一条**可操作**的提示，直接把用户送到「设置 → 关于」那条已有的
 * 检查/下载/安装流程上（主进程侧 `autoDownload` 已默认打开，所以多数情况下
 * 点过去时已经在下载或已下载完）。
 *
 * ⚠️ 失败只记日志：更新检查失败不该打扰用户（离线、公司网络挡了更新源都很常见）。
 */
export function useUpdateCheck(): void {
  const { t } = useTranslation();
  const setHasUpdate = useUiStore((s) => s.setHasUpdate);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);

  useEffect(() => {
    const timer = setTimeout(async () => {
      try {
        const result = await window.clawwork.checkForUpdates();
        if (result.hasUpdate) {
          setHasUpdate(true);
          toast(t('leftNav.updateAvailable'), {
            action: {
              label: t('settings.checkForUpdates'),
              onClick: () => {
                setSettingsSection('about');
                setSettingsOpen(true);
              },
            },
          });
        }
      } catch (err) {
        console.error('[useUpdateCheck] check failed:', err);
      }
    }, 5000);

    return () => clearTimeout(timer);
  }, [setHasUpdate, setSettingsOpen, setSettingsSection, t]);
}
