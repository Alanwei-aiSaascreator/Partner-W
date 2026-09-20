import { Bot, Boxes, CheckCircle2, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import logo from '@/assets/logo.png';
import { Button } from '@/components/ui/button';
import { PRESET_AGENT_DEFINITIONS, type PresetAgentId } from '@/lib/preset-agents';
import type { StartupReadiness } from '@/lib/startup-readiness';

interface StartupReadinessScreenProps {
  readiness: StartupReadiness;
  onRetry: () => void | Promise<void>;
}

function StateIcon({ phase }: { phase: 'active' | 'ready' | 'error' }) {
  if (phase === 'ready') return <CheckCircle2 size={18} aria-hidden="true" />;
  if (phase === 'error') return <TriangleAlert size={18} aria-hidden="true" />;
  return <LoaderCircle size={18} className="animate-spin" aria-hidden="true" />;
}

export default function StartupReadinessScreen({ readiness, onRetry }: StartupReadinessScreenProps) {
  const { t } = useTranslation();
  const assistant = readiness.assistants;
  const completed = Math.min(assistant.completed, assistant.total);
  const progressPercent = assistant.total > 0 ? (completed / assistant.total) * 100 : 0;
  const roleName = (id: PresetAgentId): string => {
    const definition = PRESET_AGENT_DEFINITIONS.find((item) => item.id === id);
    return definition ? t(definition.displayNameKey) : id;
  };
  // ⚠️ 这是一条**三元链**：认不出的相位不会报错，只会静默落到最后的 `aiReady`。
  //    所以每加一个相位都得在这里显式提到（`catalog-failed` 就是这么补上的）。
  const aiStatusKey =
    readiness.ai.phase === 'starting'
      ? 'startupReadiness.aiStarting'
      : readiness.ai.phase === 'loading-models'
        ? 'startupReadiness.aiLoadingModels'
        : readiness.ai.phase === 'catalog-failed'
          ? 'startupReadiness.aiCatalogFailed'
          : readiness.ai.phase === 'error'
            ? 'startupReadiness.aiError'
            : 'startupReadiness.aiReady';
  const assistantStatus =
    assistant.phase === 'waiting'
      ? t('startupReadiness.assistantsWaiting')
      : assistant.phase === 'verifying'
        ? t('startupReadiness.assistantsVerifying')
        : assistant.phase === 'installing'
          ? t('startupReadiness.assistantsInstalling', {
              name: assistant.currentId ? roleName(assistant.currentId) : '',
            })
          : assistant.phase === 'error'
            ? t('startupReadiness.assistantsError', {
                names: assistant.missingIds.map(roleName).join(', '),
              })
            : t('startupReadiness.assistantsReady');
  const aiIconPhase =
    readiness.ai.phase === 'ready'
      ? 'ready'
      : readiness.ai.phase === 'error' || readiness.ai.phase === 'catalog-failed'
        ? 'error'
        : 'active';
  const assistantIconPhase = assistant.phase === 'ready' ? 'ready' : assistant.phase === 'error' ? 'error' : 'active';

  return (
    <div className="relative flex h-screen overflow-hidden bg-[var(--bg-primary)]" aria-busy={!readiness.isReady}>
      <div className="titlebar-drag fixed inset-x-0 top-0 z-50 h-8" />
      <main className="flex w-full items-center justify-center px-6 py-12">
        <div className="w-full max-w-[var(--content-max-width)]">
          <header className="mb-8 flex flex-col items-center text-center">
            <div className="relative mb-4">
              <div className="absolute inset-0 scale-[2.2] rounded-full bg-[var(--accent)] opacity-[0.06] blur-2xl" />
              <img
                src={logo}
                alt={t('common.appName')}
                className="relative h-14 w-14 rounded-xl shadow-[var(--glow-accent)]"
              />
            </div>
            <p className="type-label mb-1 text-[var(--accent)]">{t('common.appName')}</p>
            <h1 className="type-page-title text-[var(--text-primary)]">{t('startupReadiness.title')}</h1>
            <p className="type-body mt-2 max-w-xl text-[var(--text-secondary)]">{t('startupReadiness.description')}</p>
            {/*
              ⭐ C（2026-09-19）：**必须说清"这不是安装"。**
              U 盘版首次启动会把运行环境解压到**本机缓存**（约 2–3 分钟，设计如此 ——
              为了拔盘后还能继续用），那个进度界面**看起来就是在装软件**。实测有同事
              因此反馈"双击 exe 装到电脑"。
              ⇒ 这句是**永远为真**的说法（程序确实不写系统、不建图标），
                所以不依赖"此刻是否在部署" —— 那个信号 readiness 里根本没有。
            */}
            <p className="type-support mt-2 max-w-xl text-[var(--text-muted)]" data-testid="not-an-install">
              {t('startupReadiness.notAnInstall')}
            </p>
          </header>

          <section
            aria-live="polite"
            className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)]"
          >
            <div className="grid md:grid-cols-5">
              <article className="min-h-40 border-b border-[var(--border-subtle)] p-6 md:col-span-2 md:border-b-0 md:border-r">
                <div className="mb-5 flex items-start justify-between gap-4">
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent-dim)] text-[var(--accent)]">
                    <Bot size={19} aria-hidden="true" />
                  </span>
                  <span className={aiIconPhase === 'error' ? 'text-[var(--danger)]' : 'text-[var(--accent)]'}>
                    <StateIcon phase={aiIconPhase} />
                  </span>
                </div>
                <h2 className="type-section-title text-[var(--text-primary)]">{t('startupReadiness.aiTitle')}</h2>
                <p className="type-body mt-2 text-[var(--text-secondary)]">{t(aiStatusKey)}</p>
              </article>

              <article className="min-h-40 p-6 md:col-span-3">
                <div className="mb-5 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--accent-dim)] text-[var(--accent)]">
                      <Boxes size={19} aria-hidden="true" />
                    </span>
                    <div>
                      <h2 className="type-section-title text-[var(--text-primary)]">
                        {t('startupReadiness.assistantsTitle')}
                      </h2>
                      <span className="type-mono-data text-[var(--text-muted)]">
                        {t('startupReadiness.progress', { completed, total: assistant.total })}
                      </span>
                    </div>
                  </div>
                  <span className={assistant.phase === 'error' ? 'text-[var(--danger)]' : 'text-[var(--accent)]'}>
                    <StateIcon phase={assistantIconPhase} />
                  </span>
                </div>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={assistant.total}
                  aria-valuenow={completed}
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
                >
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <p
                  className={`type-support mt-3 leading-relaxed ${
                    assistant.phase === 'error' ? 'text-[var(--danger)]' : 'text-[var(--text-secondary)]'
                  }`}
                >
                  {assistantStatus}
                </p>
                {/*
                  ⭐⭐ 2026-09-20（T-a28 U 盘交付实机）：**原因必须说出来。**
                  `preset-agent-bootstrap` 在**抛错**（refreshAgents 失败等）和**全部失败**两种情况下
                  填的 `missingIds` 都是"全部 6 个" ⇒ 上面那句「这些助手尚未完成：…」在两种原因下
                  **长得一模一样**；而原因一直在 `assistants.error` 里
                  （`Failed to create agent "X": <网关原文>`），此前**没有任何界面渲染它**。
                  ⚠️ 这段原文**不翻译**：它是网关/安装器给的**证据**（与 `InstallProgress` 里那些
                  逐助手告警同一类），译掉就没法拿去定位了。
                */}
                {assistant.phase === 'error' && assistant.error && (
                  <p className="type-support mt-2 break-words text-[var(--danger)]" data-testid="readiness-reason">
                    {assistant.error}
                  </p>
                )}
              </article>
            </div>

            <footer className="flex min-h-14 items-center justify-between gap-4 border-t border-[var(--border-subtle)] px-6 py-3">
              <p className="type-support text-[var(--text-muted)]">{t('startupReadiness.keepOpen')}</p>
              {readiness.hasError && (
                <Button type="button" variant="outline" className="titlebar-no-drag shrink-0" onClick={onRetry}>
                  <RefreshCw size={15} />
                  {t('startupReadiness.retry')}
                </Button>
              )}
            </footer>
          </section>
        </div>
      </main>
    </div>
  );
}
