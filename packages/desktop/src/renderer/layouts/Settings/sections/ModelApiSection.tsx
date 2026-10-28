import { useCallback, useEffect, useState } from 'react';
import { Cpu, Loader2, Plus, RefreshCw, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import SettingGroup from '@/components/semantic/SettingGroup';
import { refreshByokEndpoints } from '@/stores/byokStore';

const inputClass = cn(
  'w-full px-3 py-2 rounded-md type-mono-data text-[var(--text-primary)]',
  'bg-[var(--bg-tertiary)] border border-[var(--border)]',
  'focus:border-[var(--accent)]/40 outline-none transition-colors glow-focus',
);

/** BYOK 模型可选的 4 档推理功率（与内核/`byok.ts` 同源：low/medium/high/max）。 */
const LEVELS = [
  { value: 'low', labelKey: 'chatInput.thinkingLow' },
  { value: 'medium', labelKey: 'chatInput.thinkingMedium' },
  { value: 'high', labelKey: 'chatInput.thinkingHigh' },
  { value: 'max', labelKey: 'chatInput.thinkingMax' },
] as const;

type ModelRow = { id: string; level: string };

interface EndpointDraft {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  hasApiKey: boolean;
  models: ModelRow[];
  listing: boolean;
}

function newEndpointId(): string {
  return `byok-${crypto.randomUUID().slice(0, 8)}`;
}

function emptyEndpoint(): EndpointDraft {
  return {
    id: newEndpointId(),
    name: '',
    baseUrl: '',
    apiKey: '',
    hasApiKey: false,
    models: [{ id: '', level: 'high' }],
    listing: false,
  };
}

/**
 * BYOK 模型服务配置 —— 私有化 / 开源版的核心模型路径。
 *
 * 2026-10-28 升级为**多端点**：一个配置 = 一组端点（每个端点一个 url + key +
 * 一组选中的模型）。支持手动填模型 id，也支持调端点 `/models` 一键拉取列表。
 */
export default function ModelApiSection() {
  const { t } = useTranslation();
  const [endpoints, setEndpoints] = useState<EndpointDraft[]>([emptyEndpoint()]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.clawwork
      .modelApiGet()
      .then((res) => {
        const result = res.result;
        if (res.ok && result && result.endpoints.length > 0) {
          setEndpoints(
            result.endpoints.map((e) => ({
              id: e.id,
              name: e.name,
              baseUrl: e.baseUrl,
              apiKey: '',
              hasApiKey: e.hasApiKey,
              models: e.modelIds.map((id) => ({ id, level: e.modelLevels?.[id] ?? 'high' })),
              listing: false,
            })),
          );
        }
      })
      .catch((err) => console.error('[ModelApiSection] modelApiGet failed:', err));
  }, []);

  const updateEndpoint = useCallback((index: number, patch: Partial<EndpointDraft>) => {
    setEndpoints((prev) => prev.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  }, []);

  const addEndpoint = useCallback(() => {
    setEndpoints((prev) => [...prev, emptyEndpoint()]);
  }, []);

  const removeEndpoint = useCallback((index: number) => {
    setEndpoints((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== index) : [emptyEndpoint()]));
  }, []);

  const updateModel = useCallback((ei: number, mi: number, patch: Partial<ModelRow>) => {
    setEndpoints((prev) =>
      prev.map((e, i) =>
        i === ei ? { ...e, models: e.models.map((m, j) => (j === mi ? { ...m, ...patch } : m)) } : e,
      ),
    );
  }, []);

  const addModel = useCallback((ei: number) => {
    setEndpoints((prev) =>
      prev.map((e, i) => (i === ei ? { ...e, models: [...e.models, { id: '', level: 'high' }] } : e)),
    );
  }, []);

  const removeModel = useCallback((ei: number, mi: number) => {
    setEndpoints((prev) =>
      prev.map((e, i) =>
        i === ei
          ? { ...e, models: e.models.length > 1 ? e.models.filter((_, j) => j !== mi) : [{ id: '', level: 'high' }] }
          : e,
      ),
    );
  }, []);

  const listModels = useCallback(
    async (ei: number) => {
      const endpoint = endpoints[ei];
      updateEndpoint(ei, { listing: true });
      try {
        const res = await window.clawwork.modelApiList({
          baseUrl: endpoint.baseUrl.trim(),
          apiKey: endpoint.apiKey.trim(),
        });
        if (res.ok && res.result) {
          const ids = res.result.modelIds;
          if (ids.length === 0) {
            toast.error(t('settings.modelApiListEmpty'));
          } else {
            // 拉取结果合并进现有模型（已存在的保留其功率档，新模型默认 high）。
            const merged = new Map<string, string>(endpoint.models.map((m) => [m.id.trim(), m.level]));
            for (const id of ids) if (id && !merged.has(id)) merged.set(id, 'high');
            const models: ModelRow[] = [...merged.entries()].map(([id, level]) => ({ id, level }));
            updateEndpoint(ei, { models, hasApiKey: endpoint.hasApiKey || Boolean(endpoint.apiKey.trim()) });
          }
        } else {
          toast.error(t('settings.modelApiListFailed', { error: res.error ?? '' }));
        }
      } catch (err) {
        toast.error(t('settings.modelApiListFailed', { error: String(err) }));
      } finally {
        updateEndpoint(ei, { listing: false });
      }
    },
    [endpoints, t, updateEndpoint],
  );

  const handleApply = useCallback(async () => {
    const payloadEndpoints = endpoints
      .map((e) => {
        const modelIds = e.models.map((m) => m.id.trim()).filter(Boolean);
        const modelLevels: Record<string, string> = {};
        for (const m of e.models) {
          const id = m.id.trim();
          if (id) modelLevels[id] = m.level;
        }
        return {
          id: e.id,
          name: e.name.trim(),
          baseUrl: e.baseUrl.trim(),
          apiKey: e.apiKey.trim(),
          modelIds,
          modelLevels,
        };
      })
      .filter((e) => e.baseUrl && e.modelIds.length > 0);

    if (payloadEndpoints.length === 0) {
      toast.error(t('settings.modelApiInvalid'));
      return;
    }

    setBusy(true);
    try {
      const result = await window.clawwork.modelApiApply({ endpoints: payloadEndpoints });
      if (result.ok) {
        setEndpoints((prev) =>
          prev.map((e) => {
            const applied = payloadEndpoints.find((p) => p.id === e.id);
            return applied ? { ...e, hasApiKey: e.hasApiKey || Boolean(e.apiKey.trim()), apiKey: '' } : e;
          }),
        );
        // 端点名变了 ⇒ 刷新运行时选择器用的 provider → 友好名映射。
        void refreshByokEndpoints();
        toast.success(t('settings.modelApiApplied'));
      } else {
        toast.error(t('settings.modelApiApplyFailed', { error: result.error ?? '' }));
      }
    } catch (err) {
      toast.error(t('settings.modelApiApplyFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  }, [endpoints, t]);

  const handleRemove = useCallback(async () => {
    setBusy(true);
    try {
      const result = await window.clawwork.modelApiRemove();
      if (result.ok) {
        setEndpoints([emptyEndpoint()]);
        void refreshByokEndpoints();
        toast.success(t('settings.modelApiRemoved'));
      } else {
        toast.error(t('settings.modelApiApplyFailed', { error: result.error ?? '' }));
      }
    } catch (err) {
      toast.error(t('settings.modelApiApplyFailed', { error: String(err) }));
    } finally {
      setBusy(false);
    }
  }, [t]);

  return (
    <div>
      <div className="flex items-center gap-3 mb-4">
        <Cpu size={18} className="text-[var(--text-muted)] flex-shrink-0" />
        <h3 className="type-section-title text-[var(--text-primary)]">{t('settings.modelApi')}</h3>
      </div>

      <div className="space-y-3">
        {endpoints.map((endpoint, ei) => (
          <SettingGroup key={endpoint.id}>
            <div className="px-5 py-4 space-y-3.5">
              <div className="flex items-center justify-between">
                <input
                  value={endpoint.name}
                  onChange={(e) => updateEndpoint(ei, { name: e.target.value })}
                  placeholder={t('settings.modelApiEndpointNamePlaceholder')}
                  aria-label={t('settings.modelApiEndpointName')}
                  spellCheck={false}
                  className={cn(inputClass, 'max-w-xs type-label')}
                />
                <button
                  type="button"
                  onClick={() => removeEndpoint(ei)}
                  disabled={endpoints.length <= 1}
                  aria-label={t('settings.modelApiRemoveEndpoint')}
                  className="glow-focus flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:text-[var(--danger)] disabled:opacity-40 disabled:hover:text-[var(--text-muted)]"
                >
                  <X size={15} />
                </button>
              </div>

              <div className="space-y-1.5">
                <label className="type-label text-[var(--text-primary)] block">{t('settings.modelApiBaseUrl')}</label>
                <input
                  value={endpoint.baseUrl}
                  onChange={(e) => updateEndpoint(ei, { baseUrl: e.target.value })}
                  placeholder={t('settings.modelApiBaseUrlPlaceholder')}
                  spellCheck={false}
                  className={inputClass}
                />
              </div>

              <div className="space-y-1.5">
                <label className="type-label text-[var(--text-primary)] block">{t('settings.modelApiKey')}</label>
                <input
                  type="password"
                  value={endpoint.apiKey}
                  onChange={(e) => updateEndpoint(ei, { apiKey: e.target.value })}
                  placeholder={
                    endpoint.hasApiKey ? t('settings.modelApiKeyHint') : t('settings.modelApiKeyPlaceholder')
                  }
                  spellCheck={false}
                  autoComplete="off"
                  className={inputClass}
                />
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="type-label text-[var(--text-primary)]">{t('settings.modelApiModels')}</label>
                  <button
                    type="button"
                    onClick={() => listModels(ei)}
                    disabled={endpoint.listing || !endpoint.baseUrl.trim()}
                    className="glow-focus inline-flex items-center gap-1.5 rounded-md px-2 py-1 type-label text-[var(--accent)] transition-colors hover:bg-[var(--accent-dim)] disabled:opacity-40"
                  >
                    <RefreshCw size={13} className={endpoint.listing ? 'animate-spin' : ''} />
                    {endpoint.listing ? t('settings.modelApiListing') : t('settings.modelApiListModels')}
                  </button>
                </div>
                <div className="space-y-2">
                  {endpoint.models.map((row, mi) => (
                    <div key={mi} className="flex items-center gap-2">
                      <input
                        value={row.id}
                        onChange={(e) => updateModel(ei, mi, { id: e.target.value })}
                        placeholder={t('settings.modelApiModelPlaceholder')}
                        spellCheck={false}
                        className={cn(inputClass, 'flex-1')}
                        aria-label={`${t('settings.modelApiModels')} ${mi + 1}`}
                      />
                      <select
                        value={row.level}
                        onChange={(e) => updateModel(ei, mi, { level: e.target.value })}
                        className={cn(inputClass, 'w-24 flex-shrink-0 cursor-pointer')}
                        aria-label={t('settings.modelApiModelLevel')}
                      >
                        {LEVELS.map((level) => (
                          <option key={level.value} value={level.value}>
                            {t(level.labelKey)}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => removeModel(ei, mi)}
                        disabled={endpoint.models.length <= 1}
                        aria-label={t('settings.modelApiRemoveModel')}
                        className="glow-focus flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md border border-[var(--border)] text-[var(--text-muted)] transition-colors hover:text-[var(--danger)] disabled:opacity-40 disabled:hover:text-[var(--text-muted)]"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => addModel(ei)}
                  className="glow-focus inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 type-label text-[var(--accent)] transition-colors hover:bg-[var(--accent-dim)]"
                >
                  <Plus size={14} />
                  {t('settings.modelApiAddModel')}
                </button>
                <p className="type-support text-[var(--text-muted)]">{t('settings.modelApiModelsHint')}</p>
              </div>
            </div>
          </SettingGroup>
        ))}

        <button
          type="button"
          onClick={addEndpoint}
          className="glow-focus inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 type-label text-[var(--accent)] transition-colors hover:bg-[var(--accent-dim)]"
        >
          <Plus size={14} />
          {t('settings.modelApiAddEndpoint')}
        </button>
      </div>

      <div className="flex items-center gap-2 mt-4">
        <Button onClick={handleApply} disabled={busy} className="titlebar-no-drag h-9 gap-1.5">
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          {t('settings.modelApiApply')}
        </Button>
        <Button variant="outline" onClick={handleRemove} disabled={busy} className="titlebar-no-drag h-9 gap-1.5">
          <Trash2 size={14} />
          {t('settings.modelApiRemove')}
        </Button>
      </div>
    </div>
  );
}
