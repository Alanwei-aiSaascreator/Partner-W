import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { slidegenFailureToastBody, slidegenWarningToastBody } from '@/lib/slidegen-copy';

/**
 * 幻灯片那条通道的两句话（与 `useDocgenFailureToast` / `useHtmlgenFailureToast` 同形）。
 *
 * ⭐ **两条通道分开、两档严重性分开**，这是本 hook 唯一的特别之处：
 *
 * - `slidegen:failed` ⇒ **红色**：真的没生成出来。不说的话表现是
 *   "助手说做好了，右边什么都没有"。
 * - `slidegen:warned` ⇒ **黄色**：文件**已经在产物里了**，只是某几页版式有毛病
 *   （元素冲出画布 / 文字被盖住）。这条通道**刻意不因为版式问题拒绝出文件** ——
 *   把警告做成失败，就回到了"内容多一点 = 零输出"那条老路。
 *
 * ⚠️ 两句话必须**用不同的语气开头**（失败"没能生成"、警告"已经生成"）。
 *    文案写岔了，用户会在一个其实存在的文件上找半天。
 */
export function useSlidegenToast(): void {
  const { t } = useTranslation();

  useEffect(() => {
    return window.clawwork.onSlidegenFailed((failures) => {
      const body = slidegenFailureToastBody(failures, t);
      if (!body) return;
      toast.error(t('slidegen.failedTitle'), { description: body });
    });
  }, [t]);

  useEffect(() => {
    return window.clawwork.onSlidegenWarned((warnings) => {
      const body = slidegenWarningToastBody(warnings, t);
      if (!body) return;
      toast.warning(t('slidegen.warnedTitle'), { description: body });
    });
  }, [t]);
}
