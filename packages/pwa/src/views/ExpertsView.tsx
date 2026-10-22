import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, RefreshCw, Rocket } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { composer } from '../stores';
import { gatewayToken, mobileFetch } from '../lib/remote-api';
import { SkeletonList } from '../components/SkeletonList';
import {
  EXPERT_CATALOG,
  EXPERT_DOMAINS,
  buildExpertLaunchPrompt,
  expertsByDomain,
  type ExpertDomain,
} from '../lib/expert-catalog';

/**
 * 专家库（手机端）—— 对齐桌面端 ExpertsPanel：
 * 顶部说明 + 领域筛选（工程/设计/知识/资讯）+ 每位专家一张卡 + 「开个任务」。
 *
 * 「开个任务」只把一句话交给 composer，走的仍是既有的任务通道（不新造执行路径）；
 * 「已装」状态实读桌面端的随包技能安装情况（`/api/mobile/skills`），不是猜的。
 */
export function ExpertsView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [domain, setDomain] = useState<ExpertDomain | 'all'>('all');
  const [installedSlugs, setInstalledSlugs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);

  const loadInstalled = useCallback(async () => {
    setLoading(true);
    try {
      const token = await gatewayToken();
      if (!token) return;
      const response = await mobileFetch('/api/mobile/skills', token);
      if (!response.ok) return;
      const data = (await response.json()) as { skills?: Array<{ slug: string; installed?: boolean }> };
      setInstalledSlugs(new Set((data.skills ?? []).filter((s) => s.installed).map((s) => s.slug)));
    } catch {
      /* 安装态读不到就都按「未装」显示，不阻塞开任务 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadInstalled();
  }, [loadInstalled]);

  const domainCounts = useMemo(
    () =>
      Object.fromEntries(
        EXPERT_DOMAINS.map((key) => [key, expertsByDomain(key).length]),
      ) as Record<ExpertDomain, number>,
    [],
  );
  const list = useMemo(
    () => (domain === 'all' ? EXPERT_CATALOG : expertsByDomain(domain)),
    [domain],
  );

  const start = async (prompt: string, titleHint: string): Promise<void> => {
    try {
      await composer.send(undefined, { content: prompt, titleHint });
      onClose();
    } catch {
      /* 失败留在原地 */
    }
  };

  return (
    <div className="module-sheet fixed inset-0 z-[60] flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <header className="safe-area-top flex shrink-0 items-center gap-2 px-2 py-2">
        <button
          onClick={onClose}
          aria-label={t('files.close')}
          className="rounded-lg p-2"
          style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
        >
          <ArrowLeft size={20} />
        </button>
        <p className="min-w-0 flex-1 truncate text-center type-label" style={{ color: 'var(--text-primary)' }}>
          {t('experts.title')}
        </p>
        <button
          onClick={() => void loadInstalled()}
          aria-label={t('skills.refresh')}
          className="rounded-lg p-2"
          style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
        >
          <RefreshCw size={18} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pb-10">
        <p className="mt-1 type-support" style={{ color: 'var(--text-secondary)' }}>
          {t('experts.subtitle')}
        </p>
        <p className="mt-1 type-support" style={{ color: 'var(--text-muted)' }}>
          {t('experts.installHint')}
        </p>

        <div className="mt-3 flex items-center gap-1.5 overflow-x-auto pb-1">
          <button
            onClick={() => setDomain('all')}
            className="shrink-0 rounded-full px-3 py-1.5 type-support"
            style={{
              backgroundColor: domain === 'all' ? 'var(--accent)' : 'var(--bg-secondary)',
              color: domain === 'all' ? 'var(--accent-foreground)' : 'var(--text-secondary)',
              minHeight: 34,
            }}
          >
            {t('experts.domain.all')} {EXPERT_CATALOG.length}
          </button>
          {EXPERT_DOMAINS.map((key) => {
            const active = domain === key;
            const count = domainCounts[key];
            return (
              <button
                key={key}
                onClick={() => setDomain(key)}
                className="shrink-0 rounded-full px-3 py-1.5 type-support"
                style={{
                  backgroundColor: active ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: active ? 'var(--accent-foreground)' : 'var(--text-secondary)',
                  minHeight: 34,
                }}
              >
                {t(`experts.domain.${key}`)} {count}
              </button>
            );
          })}
          <span className="ml-auto shrink-0 type-support" style={{ color: 'var(--text-muted)' }}>
            {t('experts.countLabel', { n: EXPERT_CATALOG.length })}
          </span>
        </div>

        {loading && <SkeletonList rows={4} withBadge />}

        <div className="mt-2 flex flex-col gap-2">
          {list.map((expert) => {
            const installed = installedSlugs.has(expert.skillSlug);
            return (
              <div
                key={expert.id}
                className="ui-card rounded-2xl px-3.5 py-3"
              >
                <div className="flex items-start gap-2.5">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-[18px]"
                    style={{ backgroundColor: 'var(--bg-tertiary)' }}
                    aria-hidden="true"
                  >
                    {expert.glyph}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate type-body" style={{ color: 'var(--text-primary)' }}>
                      {expert.name}
                    </p>
                    <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                      {t(`experts.domain.${expert.domain}`)}
                    </p>
                    <p className="mt-1 type-support" style={{ color: 'var(--text-secondary)' }}>
                      {expert.capability}
                    </p>
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-end gap-2">
                  <span
                    className="rounded px-1.5 py-0.5 type-support"
                    style={{
                      backgroundColor: installed ? 'var(--accent-dim)' : 'var(--bg-tertiary)',
                      color: installed ? 'var(--accent)' : 'var(--text-muted)',
                    }}
                  >
                    {installed ? t('experts.installed') : t('experts.notInstalled')}
                  </span>
                  <button
                    onClick={() => void start(buildExpertLaunchPrompt(expert, t), expert.name)}
                    className="flex items-center gap-1 rounded-lg px-3 py-1.5 type-support"
                    style={{
                      backgroundColor: 'var(--bg-tertiary)',
                      color: 'var(--text-primary)',
                      minHeight: 34,
                    }}
                  >
                    <Rocket size={12} />
                    {t('experts.launch')}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
