import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, RefreshCw, Search, Trash2, Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { mobileFetch, gatewayToken } from '../lib/remote-api';
import { SkeletonList } from '../components/SkeletonList';
import {
  SKILL_CATEGORY_ORDER,
  groupSkillsByCategory,
  skillCategoryOf,
  type SkillCategory,
} from '../lib/skill-categories';

interface BundledSkill {
  slug: string;
  name?: string;
  description?: string;
  emoji?: string;
  installed?: boolean;
  version?: string;
}

/** 分类卡渐变（与桌面端 SkillMarket 同一套配色）。 */
const CATEGORY_GRADIENT: Record<SkillCategory, string> = {
  content: 'linear-gradient(135deg, #c026d3 0%, #db2777 100%)',
  commerce: 'linear-gradient(135deg, #dc2626 0%, #f97316 100%)',
  research: 'linear-gradient(135deg, #7c3aed 0%, #6366f1 100%)',
  office: 'linear-gradient(135deg, #ea580c 0%, #f59e0b 100%)',
  other: 'linear-gradient(135deg, #4b5563 0%, #6b7280 100%)',
};

/**
 * 技能市场（手机端）—— 对齐桌面端 SkillMarket：分类大卡 + 搜索 + 分类筛选 + 卡片列表，
 * 每张卡带「修复随包版本 / 卸载」（动作落在桌面端同一套实现上，两边装的是同一份）。
 */
export function SkillsMarketView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [token, setToken] = useState<string | null>(null);
  const [skills, setSkills] = useState<BundledSkill[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<SkillCategory | 'all'>('all');

  useEffect(() => {
    void (async () => setToken(await gatewayToken()))();
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    setError(null);
    try {
      const response = await mobileFetch('/api/mobile/skills', token);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { skills?: BundledSkill[] };
      setSkills(data.skills ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'load failed');
      setSkills([]);
    }
  }, [token]);

  useEffect(() => {
    if (token) void load();
  }, [token, load]);

  const act = useCallback(
    async (slug: string, action: 'install' | 'remove') => {
      if (!token) return;
      setBusy(slug);
      setError(null);
      setNotice(null);
      try {
        const response = await mobileFetch(`/api/mobile/skills/${action}`, token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug }),
        });
        const data = (await response.json()) as { ok?: boolean; error?: string };
        if (!response.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${response.status}`);
        setNotice(action === 'install' ? t('skills.repaired') : t('skills.removed'));
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'action failed');
      } finally {
        setBusy(null);
      }
    },
    [token, load, t],
  );

  const groups = useMemo(() => groupSkillsByCategory(skills ?? []), [skills]);
  const installedCount = (skills ?? []).filter((skill) => skill.installed).length;
  const total = (skills ?? []).length;

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return (skills ?? []).filter((skill) => {
      if (category !== 'all' && skillCategoryOf(skill.slug) !== category) return false;
      if (!keyword) return true;
      return (
        (skill.name ?? '').toLowerCase().includes(keyword) ||
        skill.slug.toLowerCase().includes(keyword) ||
        (skill.description ?? '').toLowerCase().includes(keyword)
      );
    });
  }, [skills, query, category]);

  const tabs = useMemo(
    () => ['all', ...SKILL_CATEGORY_ORDER.filter((key) => groups.some((group) => group.category === key))] as const,
    [groups],
  );

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
          {t('modules.skills')}
        </p>
        <button
          onClick={() => void load()}
          aria-label={t('skills.refresh')}
          className="rounded-lg p-2"
          style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
        >
          <RefreshCw size={18} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pb-10">
        {/* 分类大卡：一眼看到「有哪些类、各多少个」 */}
        <div className="mt-1 grid grid-cols-2 gap-2">
          {groups.map((group) => (
            <button
              key={group.category}
              onClick={() => setCategory(category === group.category ? 'all' : group.category)}
              className="rounded-xl px-3 py-2.5 text-left"
              style={{
                background: CATEGORY_GRADIENT[group.category],
                minHeight: 74,
                boxShadow: category === group.category ? '0 0 0 2px var(--accent)' : 'none',
              }}
            >
              <p className="type-label" style={{ color: '#fff' }}>
                {t(`skillMarket.category.${group.category}`)}
              </p>
              <p className="type-support" style={{ color: 'rgba(255,255,255,0.85)' }}>
                {t('skillMarket.skillCount', { count: group.items.length })}
              </p>
              <p className="mt-0.5 truncate type-support" style={{ color: 'rgba(255,255,255,0.7)' }}>
                {group.items
                  .slice(0, 3)
                  .map((item) => item.name ?? item.slug)
                  .join(' · ')}
              </p>
            </button>
          ))}
        </div>

        {/* 搜索 */}
        <div
          className="mt-3 flex items-center gap-2 rounded-xl px-3"
          style={{ backgroundColor: 'var(--bg-secondary)', minHeight: 44 }}
        >
          <Search size={15} style={{ color: 'var(--text-muted)' }} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('skillMarket.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent type-support outline-none"
            style={{ color: 'var(--text-primary)' }}
          />
          <span className="shrink-0 type-support" style={{ color: 'var(--text-muted)' }}>
            {t('skillMarket.installedSummary', { total, installed: installedCount })}
          </span>
        </div>

        {/* 分类筛选 */}
        <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
          {tabs.map((key) => {
            const active = category === key;
            const count = key === 'all' ? total : groups.find((group) => group.category === key)?.items.length ?? 0;
            return (
              <button
                key={key}
                onClick={() => setCategory(key)}
                className="shrink-0 rounded-full px-3 py-1.5 type-support"
                style={{
                  backgroundColor: active ? 'var(--accent)' : 'var(--bg-secondary)',
                  color: active ? 'var(--accent-foreground)' : 'var(--text-secondary)',
                  minHeight: 34,
                }}
              >
                {key === 'all' ? t('skillMarket.category.all') : t(`skillMarket.category.${key}`)} {count}
              </button>
            );
          })}
        </div>

        {skills === null && <SkeletonList rows={5} withBadge />}

        {error && (
          <p
            className="type-support my-3 rounded-lg px-3 py-2"
            style={{ backgroundColor: 'var(--danger-bg)', color: 'var(--danger)' }}
          >
            {error}
          </p>
        )}
        {notice && (
          <p className="type-support my-2 px-1" style={{ color: 'var(--accent)' }}>
            {notice}
          </p>
        )}

        <div className="mt-2 flex flex-col gap-2">
          {filtered.map((skill) => {
            const cat = skillCategoryOf(skill.slug);
            return (
              <div
                key={skill.slug}
                className="ui-card rounded-2xl px-3.5 py-3"
              >
                <div className="flex items-start gap-2.5">
                  <span className="text-[20px] leading-none" aria-hidden="true">
                    {skill.emoji ?? '🧩'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <p className="min-w-0 flex-1 truncate type-body" style={{ color: 'var(--text-primary)' }}>
                        {skill.name || skill.slug}
                      </p>
                      {skill.installed && (
                        <span
                          className="shrink-0 rounded px-1.5 py-0.5 type-support"
                          style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
                        >
                          {t('skillMarket.installedBadge')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 type-support" style={{ color: 'var(--text-muted)' }}>
                      {skill.description ?? skill.slug}
                    </p>
                  </div>
                </div>

                <div className="mt-2 flex items-center justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="type-support" style={{ color: 'var(--text-muted)' }}>
                      {t(`skillMarket.category.${cat}`)}
                    </span>
                    {skill.installed && (
                      <span className="truncate type-support" style={{ color: 'var(--accent)' }}>
                        ✓ {t('skillMarket.canHelp')}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => void act(skill.slug, 'install')}
                      disabled={busy === skill.slug}
                      className="flex items-center gap-1 rounded-lg px-2 py-1.5 type-support"
                      style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--text-secondary)', minHeight: 34 }}
                      aria-label={skill.installed ? t('skills.repairBundled') : t('skills.install')}
                    >
                      {busy === skill.slug ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
                    </button>
                    {skill.installed && (
                      <button
                        onClick={() => void act(skill.slug, 'remove')}
                        disabled={busy === skill.slug}
                        className="flex items-center gap-1 rounded-lg px-2 py-1.5"
                        style={{ backgroundColor: 'var(--bg-tertiary)', color: 'var(--danger)', minHeight: 34 }}
                        aria-label={t('skills.uninstall')}
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {skills !== null && filtered.length === 0 && !error && (
          <p className="type-body py-8 text-center" style={{ color: 'var(--text-muted)' }}>
            {t('modules.empty')}
          </p>
        )}
      </div>
    </div>
  );
}
