/**
 * 对比模式的选择条：挑 2–4 个模型，然后**照常按发送**。
 *
 * 为什么把「选模型」放在 composer 上方而不是塞进 composer 的模型下拉里：
 * 单模型那条路的模型下拉语义是「这次发给谁」，改成多选会让不对比的用户也踩到
 * （勾了两个模型却只想发一条消息）。对比是一段**显式的模式**，所以给它一条独立的条：
 * 关掉它，一切回到原来的单模型行为。
 *
 * ⚠️ 产品红线：这里**不显示** token / 官方参考价 / 倍率 / 人民币，只说明
 *    「每个模型各自计费（积分）」—— 具体金额在账单里按次结算。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { ModelCatalogEntry } from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { modelFamilyLabel } from '@/components/ChatInput/model-families';
import { useCompareStore } from './compare-store-instance';
import { MAX_COMPARE_MODELS, MIN_COMPARE_MODELS, validateCompareModels } from './compare-plan';

interface CompareSetupBarProps {
  /** 中转目录（已经过 `relayModelsFrom`）。空目录时只显示提示，不显示可选模型。 */
  modelCatalog: readonly ModelCatalogEntry[];
  onClose: () => void;
}

export default function CompareSetupBar({ modelCatalog, onClose }: CompareSetupBarProps) {
  const { t } = useTranslation();
  const draftModels = useCompareStore((s) => s.draftModels);
  const setDraftModels = useCompareStore((s) => s.setDraftModels);
  const error = useCompareStore((s) => s.error);

  const byFamily = useMemo(() => {
    const groups: Record<string, ModelCatalogEntry[]> = {};
    for (const m of modelCatalog) {
      const family = modelFamilyLabel(m.id);
      (groups[family] ??= []).push(m);
    }
    return groups;
  }, [modelCatalog]);

  const nameOf = (id: string): string => modelCatalog.find((m) => m.id === id)?.name ?? id;
  const invalid = error ?? validateCompareModels(draftModels);

  return (
    <div
      className="flex flex-col gap-2 border-t border-[var(--border)] bg-[var(--bg-secondary)] px-4 py-2"
      data-testid="compare-setup-bar"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-label text-[var(--text-secondary)]">{t('compare.setupTitle')}</span>

        {draftModels.map((model, index) => (
          <span
            key={model}
            className="type-meta inline-flex items-center gap-1 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-0.5 text-[var(--text-primary)]"
            data-testid="compare-model-chip"
          >
            <span className="text-[var(--text-muted)]">{index + 1}</span>
            {nameOf(model)}
            <button
              type="button"
              className="glow-focus rounded-full p-0.5 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)] motion-reduce:transition-none"
              aria-label={t('compare.removeModel', { model: nameOf(model) })}
              onClick={() => setDraftModels(draftModels.filter((m) => m !== model))}
            >
              <X size={12} />
            </button>
          </span>
        ))}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={modelCatalog.length === 0}
              data-testid="compare-add-model"
            >
              {t('compare.addModel')}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
            {Object.entries(byFamily).map(([family, models]) => (
              <DropdownMenuSub key={family}>
                <DropdownMenuSubTrigger>
                  <span>{family}</span>
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="max-h-96 overflow-y-auto">
                  {models.map((m) => {
                    const picked = draftModels.includes(m.id);
                    return (
                      <DropdownMenuItem
                        key={m.id}
                        // 已在列里就不可再点（去重是 plan 的职责，但按钮也不该看起来能做无用功）
                        disabled={picked || draftModels.length >= MAX_COMPARE_MODELS}
                        onClick={() => setDraftModels([...draftModels, m.id])}
                      >
                        <span className="truncate">{m.name ?? m.id}</span>
                      </DropdownMenuItem>
                    );
                  })}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
            {modelCatalog.length === 0 && <DropdownMenuItem disabled>{t('compare.noModels')}</DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>

        <span className="type-meta ml-auto text-[var(--text-muted)]">{t('compare.setupHint')}</span>
        <Button type="button" variant="ghost" size="sm" onClick={onClose} data-testid="compare-setup-close">
          {t('compare.exitMode')}
        </Button>
      </div>

      <div className="type-meta text-[var(--text-muted)]">
        {invalid === 'too-few-models'
          ? t('compare.needAtLeast', { count: MIN_COMPARE_MODELS })
          : invalid === 'too-many-models'
            ? t('compare.atMost', { count: MAX_COMPARE_MODELS })
            : t('compare.sendHint', { count: draftModels.length })}
      </div>
    </div>
  );
}
