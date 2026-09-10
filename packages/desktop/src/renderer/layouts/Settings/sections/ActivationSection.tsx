import { useState, useCallback } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import SettingGroup from '@/components/semantic/SettingGroup';
import InlineNotice from '@/components/semantic/InlineNotice';
import { useCommercialStore } from '@/stores/commercialStore';

const ERROR_KEYS: Record<string, string> = {
  empty_key: 'activation.errorEmpty',
  license_not_found: 'activation.errorNotFound',
  license_inactive: 'activation.errorInactive',
  license_expired: 'activation.errorExpired',
  license_bound_elsewhere: 'activation.errorBoundElsewhere',
  activation_limit_reached: 'activation.errorLimit',
  not_configured: 'activation.errorNotConfigured',
};

export default function ActivationSection() {
  const { t } = useTranslation();
  const overview = useCommercialStore((s) => s.overview);
  const load = useCommercialStore((s) => s.load);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState('');

  const licence = overview?.license ?? null;

  const submit = useCallback(async () => {
    const trimmed = key.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setErrorKey('');
    try {
      const res = await window.clawwork.commercialLicenseActivate(trimmed);
      if (!res.ok) {
        setErrorKey(ERROR_KEYS[res.errorCode ?? ''] ?? 'activation.errorGeneric');
        return;
      }
      toast.success(t('activation.success'));
      setKey('');
      await load();
      await window.clawwork.commercialUsageReport();
    } catch {
      setErrorKey('activation.errorGeneric');
    } finally {
      setBusy(false);
    }
  }, [busy, key, load, t]);

  const inputClass =
    'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-4 py-2.5 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-60';

  if (licence?.activated) {
    return (
      <div className="space-y-5">
        <h3 className="type-section-title text-[var(--text-primary)]">{t('settings.activation')}</h3>
        <SettingGroup title={t('activation.bound')}>
          <div className="px-5 py-4">
            <InlineNotice tone="info">{t('activation.boundDesc', { sku: licence.sku ?? '-' })}</InlineNotice>
          </div>
        </SettingGroup>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h3 className="type-section-title text-[var(--text-primary)]">{t('settings.activation')}</h3>

      <SettingGroup title={t('activation.title')} subtitle={t('activation.subtitle')}>
        <div className="space-y-3 px-5 py-4">
          <input
            className={inputClass}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder={t('activation.placeholder')}
            disabled={busy}
            aria-label={t('activation.placeholder')}
          />
          {errorKey ? (
            <p className="type-support text-[var(--danger)]" role="alert">
              {t(errorKey)}
            </p>
          ) : null}
          <Button onClick={() => void submit()} disabled={busy || !key.trim()} className="gap-1.5">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {t('activation.submit')}
          </Button>
        </div>
      </SettingGroup>
    </div>
  );
}
