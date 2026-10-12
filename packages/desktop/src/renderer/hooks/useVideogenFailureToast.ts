import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { videogenFailureToastBody } from '@/lib/videogen-failure-copy';

/**
 * 视频没生成出来时说一句（与 `useHtmlgenFailureToast` 同形）。
 *
 * ⚠️ 与其它失败 toast 的**时序差别**：视频是远端异步任务，这条推送可能在助手消息
 *    完成后**几分钟**才到（`main/videogen/start.ts` 的后台作业）。所以挂载点在
 *    `App.tsx` 的全局层 —— 用户那时可能已经切去了别的任务，但视频是**为他的请求**
 *    花的钱，结果必须送达。
 */
export function useVideogenFailureToast(): void {
  const { t } = useTranslation();

  useEffect(() => {
    return window.clawwork.onVideogenFailed((failures) => {
      const body = videogenFailureToastBody(failures, t);
      if (!body) return;
      toast.error(t('videogen.failedTitle'), { description: body });
    });
  }, [t]);
}
