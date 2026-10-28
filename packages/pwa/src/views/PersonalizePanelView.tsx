import { useEffect, useState } from 'react';
import { ArrowLeft, Loader2, Moon, Sun, UserRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { THEME_STORAGE_KEY } from '../lib/constants.js';
import { gatewayToken, mobileFetch } from '../lib/remote-api';

interface Profile {
  nickname?: string;
  role?: string;
  customRole?: string;
  industry?: { code?: string; name?: string };
  introduction?: string;
  useCases?: string[];
  completedAt?: string;
}

const ROLE_LABELS: Record<string, string> = {
  owner: '老板 / 决策者',
  operations: '运营',
  sales: '销售',
  support: '客服',
  finance: '财务',
  custom: '自定义',
};

/**
 * 个性化中心（手机端）—— 展示电脑端那份身份画像（昵称 / 角色 / 行业 / 简介），
 * 再加上手机本地偏好（主题）。
 *
 * 画像通过 `/api/mobile/profile` 读取（桌面端把 localStorage 里的画像镜像到了
 * userData/profile.json），不再只有深浅色一个开关。
 */
export function PersonalizeView({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'light' ? 'light' : 'dark',
  );
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const token = await gatewayToken();
      if (!token) {
        setLoading(false);
        return;
      }
      try {
        const response = await mobileFetch('/api/mobile/profile', token);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as { profile?: Profile | null };
        setProfile(data.profile ?? null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'profile failed');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const apply = (next: 'light' | 'dark'): void => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage unavailable */
    }
    setMode(next);
  };

  const nickname = profile?.nickname?.trim();
  const roleLabel = profile
    ? (profile.customRole?.trim() || ROLE_LABELS[profile.role ?? 'custom'] || '')
    : '';
  const industry = profile?.industry?.name ?? profile?.industry?.code ?? '';

  return (
    <div className="module-sheet fixed inset-0 z-[60] flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <header className="safe-area-top flex shrink-0 items-center gap-2 px-3 py-2">
        <button
          onClick={onClose}
          aria-label={t('files.close')}
          className="rounded-lg p-2"
          style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
        >
          <ArrowLeft size={20} />
        </button>
        <p className="type-label flex-1 truncate" style={{ color: 'var(--text-primary)' }}>
          {t('modules.personalize')}
        </p>
      </header>

      <div className="flex-1 overflow-y-auto px-3 pb-8">
        <div
          className="ui-card rounded-2xl px-4 py-4"
        >
          {loading ? (
            <div className="flex justify-center py-6">
              <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div
                  className="flex h-12 w-12 items-center justify-center rounded-full"
                  style={{ backgroundColor: 'var(--accent-dim)', color: 'var(--accent)' }}
                >
                  <UserRound size={22} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="type-section-title truncate" style={{ color: 'var(--text-primary)' }}>
                    {nickname || '还没有填写画像'}
                  </p>
                  <p className="type-support truncate" style={{ color: 'var(--text-muted)' }}>
                    {[roleLabel, industry].filter(Boolean).join(' · ')}
                  </p>
                </div>
              </div>

              {profile?.introduction && (
                <p className="type-body mt-3" style={{ color: 'var(--text-secondary)' }}>
                  {profile.introduction}
                </p>
              )}

              {!profile && (
                <p className="type-support mt-3" style={{ color: 'var(--text-muted)' }}>
                  电脑端完成引导后，这里会显示同一份画像。
                </p>
              )}
              {error && (
                <p className="type-support mt-2" style={{ color: 'var(--danger)' }}>
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <p className="type-section-title mt-4 mb-2" style={{ color: 'var(--text-secondary)' }}>
          外观
        </p>
        <div className="space-y-2">
          {(['light', 'dark'] as const).map((option) => (
            <button
              key={option}
              onClick={() => apply(option)}
              className="flex w-full items-center gap-3 rounded-xl px-3 py-3"
              style={{
                backgroundColor: mode === option ? 'var(--accent-dim)' : 'var(--bg-secondary)',
                color: mode === option ? 'var(--accent)' : 'var(--text-secondary)',
                border: '1px solid var(--border-subtle)',
              }}
            >
              {option === 'light' ? <Sun size={18} /> : <Moon size={18} />}
              <span className="type-body flex-1 text-left">
                {option === 'light' ? t('modules.themeLight') : t('modules.themeDark')}
              </span>
              {mode === option && <span className="type-support">✓</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
