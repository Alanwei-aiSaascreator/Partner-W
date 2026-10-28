import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import AboutSection from '@/layouts/Settings/sections/AboutSection';
import { useUiStore } from '@/stores/uiStore';

/**
 * 应用级「更新与关于」弹窗（2026-10-19）。
 *
 * ## 为什么需要它
 *
 * 用户反馈：**登录页看不到更新、也没法下载**。上一版把更新提示的落点写死成
 * 「设置 → 关于」，而 `Settings` 只在工作区挂载（`App.tsx` 是
 * `settingsOpen ? <Settings/> : <MainArea/>`）—— 登录页点提示等于点了没反应，
 * 于是检查被临时限制在"进入工作区之后"。
 *
 * 这个弹窗挂在 **App 层**（登录页、准备页、工作区都能渲染），内容直接复用
 * `AboutSection`（版本、频道、下载并准备、立即重启更新、错误说明全都在里面），
 * 所以两条界面看到的是**同一套更新逻辑**，不会再漂移。
 *
 * ## 不需要登录
 *
 * 检查与下载走主进程的更新服务（feed + 便携更新包），与账号/卡密无关；
 * 弹窗在登录页可用是产品要求，不是漏了鉴权。
 */
export default function UpdateDialog(): ReactElement {
  const { t } = useTranslation();
  const open = useUiStore((state) => state.updateDialogOpen);
  const setOpen = useUiStore((state) => state.setUpdateDialogOpen);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent data-testid="update-dialog" className="max-w-2xl p-0">
        <DialogHeader className="border-b border-[var(--border-subtle)] px-6 py-4">
          <DialogTitle>{t('settings.about')}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-6">
          <AboutSection hideHeading />
        </div>
      </DialogContent>
    </Dialog>
  );
}
