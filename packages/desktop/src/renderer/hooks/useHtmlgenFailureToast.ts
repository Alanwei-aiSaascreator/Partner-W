import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { htmlgenFailureToastBody } from '@/lib/htmlgen-failure-copy';

/**
 * 网页没生成出来时说一句（与 `useDocgenFailureToast` 同形）。
 *
 * ⚠️ 没有这一句的表现是"助手说做好了，右边什么都没有" —— 那比报错还糟，
 *    因为它看起来像我们坏了。这条通道在"内容带了协议没写的字段"时会**整份拒**，
 *    不说一句的话，用户完全无从知道该让助手去掉那个字段。
 */
export function useHtmlgenFailureToast(): void {
  const { t } = useTranslation();

  useEffect(() => {
    return window.clawwork.onHtmlgenFailed((failures) => {
      const body = htmlgenFailureToastBody(failures, t);
      if (!body) return;
      toast.error(t('htmlgen.failedTitle'), { description: body });
    });
  }, [t]);
}
