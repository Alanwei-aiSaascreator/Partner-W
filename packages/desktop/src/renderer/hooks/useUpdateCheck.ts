import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { useUiStore } from '@/stores/uiStore';

/**
 * 启动后查一次更新（T-U3）。
 *
 * 「只亮一个红点」对远程/无人值守的用户等于没有：他们不会主动进设置翻。所以这里在
 * 发现新版本时给一条**可操作**的提示，直接把用户送到「设置 → 关于」那条已有的
 * 检查/下载/安装流程上（非便携形态下检查完就会自动开始下载，所以多数情况下
 * 点过去时已经在下载或已下载完；U 盘形态不下载，那边会提示"换包"）。
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
        // ⚠️ 两个方向都要写：只写 true 的话，红点一旦点亮就再也不会灭
        //    （`setHasUpdate` 这里全仓库唯一的写入点），用户手动查完"已是最新"也还亮着。
        setHasUpdate(result.hasUpdate);
        if (result.hasUpdate) {
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
