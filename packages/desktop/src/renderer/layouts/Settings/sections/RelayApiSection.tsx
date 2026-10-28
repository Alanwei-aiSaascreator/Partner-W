import { useCallback, useEffect, useState } from 'react';
import { Loader2, PlugZap, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import SettingGroup from '@/components/semantic/SettingGroup';

const inputClass = cn(
  'w-full px-3 py-2 rounded-md type-mono-data text-[var(--text-primary)]',
  'bg-[var(--bg-tertiary)] border border-[var(--border)]',
  'focus:border-[var(--accent)]/40 outline-none transition-colors glow-focus',
);

/** 官方 API（relay 中继）配置 —— 与官网同价、不盈利的模型服务入口。 */
export default function RelayApiSection() {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState('');
  const [key, setKey] = useState('');
  const [hasConfiguredKey, setHasConfiguredKey] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.clawwork
      .relayApiGet()
      .then((res) => {
        if (res.ok && res.result) {
          setBaseUrl(res.result.baseUrl);
          setHasConfiguredKey(res.result.hasKey);
        }
      })
      .catch((err) => console.error('[RelayApiSection] relayApiGet failed:', err));
  }, []);

  const handleApply = useCallback(async () => {
    if (!key.trim() && !hasConfiguredKey) {
      toast.error(t('settings.relayApiInvalid'));
      return;
    }
    setBusy(true);
    try {
      const result = await window.clawwork.relayApiApply({ baseUrl: baseUrl.trim(), key: key.trim() });
      if (result.ok && result.configured !== false) {
        if (key.trim()) setHasConfiguredKey(true);
        setKey('');
        toast.success(t('settings.relayApiApplied'));
      } else {
        toast.error(t('settings.relayApiApplyFailed', { error: result.error ?? '' }));
      }
    } catch (err) {
      toast.error(t('settings.relayApiApplyFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  }, [baseUrl, key, hasConfiguredKey, t]);

  const handleRemove = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.clawwork.relayApiRemove();
      if (result.ok) {
        setBaseUrl('');
        setHasConfiguredKey(false);
        toast.success(t('settings.relayApiRemoved'));
      } else {
        toast.error(t('settings.relayApiApplyFailed', { error: result.error ?? '' }));
      }
    } catch (err) {
      toast.error(t('settings.relayApiApplyFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  }, [t]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <PlugZap size={18} className="text-[var(--text-muted)] flex-shrink-0" />
        <h3 className="type-section-title text-[var(--text-primary)]">{t('settings.relayApi')}</h3>
      </div>

      <SettingGroup>
        <div className="px-5 py-4 space-y-4">
          <div className="space-y-1.5">
            <label className="type-label text-[var(--text-primary)] block">{t('settings.relayApiBaseUrl')}</label>
            <input
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t('settings.relayApiBaseUrlPlaceholder')}
              spellCheck={false}
              className={inputClass}
            />
          </div>

          <div className="space-y-1.5">
            <label className="type-label text-[var(--text-primary)] block">{t('settings.relayApiKey')}</label>
            <input
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={hasConfiguredKey ? t('settings.relayApiKeyHint') : t('settings.relayApiKeyPlaceholder')}
              spellCheck={false}
              autoComplete="off"
              className={inputClass}
            />
          </div>

          <div className="flex items-center gap-2 pt-1">
            <Button onClick={handleApply} disabled={busy} className="titlebar-no-drag h-9 gap-1.5">
              {busy ? <Loader2 size={14} className="animate-spin" /> : null}
              {t('settings.relayApiApply')}
            </Button>
            <Button variant="outline" onClick={handleRemove} disabled={busy} className="titlebar-no-drag h-9 gap-1.5">
              <Trash2 size={14} />
              {t('settings.relayApiRemove')}
            </Button>
          </div>
        </div>
      </SettingGroup>
    </div>
  );
}
