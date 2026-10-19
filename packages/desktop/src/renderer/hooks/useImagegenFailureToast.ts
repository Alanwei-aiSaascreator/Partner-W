import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { imagegenFailureToastBody } from '@/lib/imagegen-failure-copy';
export function useImagegenFailureToast(): void {
  const { t } = useTranslation();
  useEffect(() => {
    if (!window.clawwork?.onImagegenFailed) return;
    return window.clawwork.onImagegenFailed((failures) => {
      const body = imagegenFailureToastBody(failures, t);
      if (body) toast.error(t('imagegen.failedTitle'), { description: body });
    });
  }, [t]);
}
