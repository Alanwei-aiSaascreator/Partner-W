import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { docgenFailureToastBody } from '@/lib/docgen-failure-copy';

export function useDocgenFailureToast(): void {
  const { t } = useTranslation();

  useEffect(() => {
    return window.clawwork.onDocgenFailed((failures) => {
      const body = docgenFailureToastBody(failures, t);
      if (!body) return;
      toast.error(t('docgen.failedTitle'), { description: body });
    });
  }, [t]);
}
