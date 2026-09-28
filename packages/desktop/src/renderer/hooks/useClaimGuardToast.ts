import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';

export function useClaimGuardToast(): void {
  const { t } = useTranslation();

  useEffect(() => {
    return window.clawwork.onClaimViolation((violation) => {
      if (!violation.missing.length) return;
      toast.error(t('claimGuard.missingTitle'), {
        description: t('claimGuard.missingBody', { names: violation.missing.join('、') }),
      });
    });
  }, [t]);
}
