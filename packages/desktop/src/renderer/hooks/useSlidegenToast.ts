import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { slidegenFailureToastBody, slidegenFailureToastTitle } from '@/lib/slidegen-copy';
export function useSlidegenToast(): void {
  const { t } = useTranslation();

  useEffect(() => {
    return window.clawwork.onSlidegenFailed((failures) => {
      const body = slidegenFailureToastBody(failures, t);
      if (!body) return;
      toast.error(slidegenFailureToastTitle(failures, t), { description: body });
    });
  }, [t]);
}
