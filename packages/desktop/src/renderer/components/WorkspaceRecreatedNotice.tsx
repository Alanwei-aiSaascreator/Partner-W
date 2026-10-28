import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import InlineNotice from '@/components/semantic/InlineNotice';
import ToolbarButton from '@/components/semantic/ToolbarButton';
import { useUiStore } from '@/stores/uiStore';

/**
 * 「原工作区目录不存在、已新建空工作区」的**非阻断告知**（2026-10-03 真机缺口：
 * 断盘模拟后 `kind:"recreated"` 静默重建，就绪页/工作台零告知）。
 *
 * ⚠️ 行为边界（教义，抄 `portable.ts` / `startup-notice.ts`）：只告知，**不阻断**、
 *    不弹框、绝不把"本机目录被删"改成"问用户选盘"——那是便携形态另一条分支的事。
 * ⚠️「知道了」是**会话级**（模块变量）：就绪页与工作台欢迎屏是两个挂点，
 *    用户在任一处关掉，另一处也不许再冒出来；条件本身只存活这一轮启动，
 *    所以不需要落盘。
 */
interface WorkspaceRecreatedNoticePayload {
  kind: 'recreated';
  path: string;
  at: number;
}

let dismissedThisSession = false;

/** 测试用：会话内关闭标记复位。 */
export function resetWorkspaceNoticeForTest(): void {
  dismissedThisSession = false;
}

function useWorkspaceRecreatedNotice(): {
  notice: WorkspaceRecreatedNoticePayload | null;
  dismiss: () => void;
} {
  const [notice, setNotice] = useState<WorkspaceRecreatedNoticePayload | null>(null);
  useEffect(() => {
    if (dismissedThisSession) return;
    let active = true;
    // ⚠️ 可选调用（`?.`）：这个方法比有些宿主新，缺了不许把整块告知带崩。
    void Promise.resolve(window.clawwork?.workspaceStartupNotice?.())
      .then((result) => {
        if (!active || dismissedThisSession) return;
        if (result?.ok && result.result?.kind === 'recreated') setNotice(result.result);
      })
      .catch(() => {
        // 问不出来 = 没有结论，什么都不说。
      });
    return () => {
      active = false;
    };
  }, []);
  const dismiss = useCallback(() => {
    dismissedThisSession = true;
    setNotice(null);
  }, []);
  return { notice, dismiss };
}

export default function WorkspaceRecreatedNotice() {
  const { t } = useTranslation();
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const { notice, dismiss } = useWorkspaceRecreatedNotice();
  if (!notice) return null;
  return (
    <div className="px-4 pt-2">
      <InlineNotice
        tone="warning"
        action={
          <div className="flex items-center gap-2">
            <ToolbarButton
              size="sm"
              variant="outline"
              onClick={() => {
                setSettingsSection('system');
                setSettingsOpen(true);
              }}
            >
              {t('workspaceNotice.openSettings')}
            </ToolbarButton>
            <ToolbarButton size="sm" variant="ghost" onClick={dismiss}>
              {t('workspaceNotice.dismiss')}
            </ToolbarButton>
          </div>
        }
      >
        <span className="inline-flex items-center gap-2">
          <AlertTriangle size={13} className="flex-shrink-0" />
          {t('workspaceNotice.recreated')}
        </span>
      </InlineNotice>
    </div>
  );
}
