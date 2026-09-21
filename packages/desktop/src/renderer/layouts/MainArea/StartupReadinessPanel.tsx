import { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, KeyRound, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PRESET_AGENT_DEFINITIONS } from '@/lib/preset-agents';
import { relayFailureText, type StartupReadiness } from '@/lib/startup-readiness';
import { useUiStore } from '@/stores/uiStore';

type Translate = (key: string, values?: Record<string, unknown>) => string;

function currentStatus(readiness: StartupReadiness, t: Translate): string {
  // ⚠️ 已知的中转失败**排在最前面**：它比目录那条推断更具体，也是唯一带出口的一条。
  if (readiness.relayFailure) return relayFailureText(readiness.relayFailure, t);
  if (readiness.ai.phase === 'starting') return t('startupReadiness.aiStarting');
  if (readiness.ai.phase === 'loading-models') return t('startupReadiness.aiLoadingModels');
  // 取不到 ≠ 没有模型：这句得说"没能取到"，否则用户会以为自己的账号/网关真的没模型。
  if (readiness.ai.phase === 'catalog-failed') return t('startupReadiness.aiCatalogFailed');
  if (readiness.ai.phase === 'error') return t('startupReadiness.aiError');

  const assistants = readiness.assistants;
  if (assistants.phase === 'waiting') return t('startupReadiness.assistantsWaiting');
  if (assistants.phase === 'verifying') return t('startupReadiness.assistantsVerifying');
  if (assistants.phase === 'installing') {
    const definition = PRESET_AGENT_DEFINITIONS.find((item) => item.id === assistants.currentId);
    return t('startupReadiness.assistantsInstalling', {
      name: definition ? t(definition.displayNameKey) : '',
    });
  }
  if (assistants.phase === 'error') {
    const names = assistants.missingIds
      .map((id) => PRESET_AGENT_DEFINITIONS.find((item) => item.id === id))
      .filter((definition): definition is (typeof PRESET_AGENT_DEFINITIONS)[number] => Boolean(definition))
      .map((definition) => t(definition.displayNameKey))
      .join(', ');
    return t('startupReadiness.assistantsError', { names });
  }
  return t('startupReadiness.aiReady');
}

export default function StartupReadinessPanel({
  readiness,
  onRetry,
}: {
  readiness: StartupReadiness;
  onRetry: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [takingLonger, setTakingLonger] = useState(false);
  const relayFailure = readiness.relayFailure;
  const completed = Math.min(readiness.assistants.completed, readiness.assistants.total);
  const hasAssistantProgress = readiness.ai.phase === 'ready' && readiness.assistants.total > 0;
  // ⭐ 2026-09-20（T-a28 实机）：助手没就绪时，**原因**一直躺在 `assistants.error` 里
  // （`preset-agent-bootstrap` 在"抛错"和"全部失败"两种情况下填的 missingIds 都是全部 6 个
  // ⇒ 光看「0 / 6」分不出是哪种），而这个面板从没渲染过它。原文不翻译：它是证据。
  const assistantError = readiness.assistants.phase === 'error' ? readiness.assistants.error : undefined;
  const progressPercent = hasAssistantProgress ? (completed / readiness.assistants.total) * 100 : 0;
  const status = readiness.hasError ? 'error' : readiness.isReady ? 'ready' : 'active';
  /**
   * ⚠️ 顺序：**已知的结论优先于"等太久了"**（原来是反的）。
   *    原来的三元链把 `takingLonger` 放在最前面 ⇒ 90 秒之后连"这张卡绑在别的组织"
   *    都会被替换成"准备时间比平时更久"，而那个结论**再等也不会变**：
   *    用户被劝着继续等一件永远不会发生的事（2026-09-21 第二台机器实机）。
   */
  const statusText = readiness.hasError
    ? currentStatus(readiness, t)
    : takingLonger
      ? t('startupReadiness.takingLonger')
      : currentStatus(readiness, t);
  /**
   * ⚠️ 不确定的**脉冲**进度条只许在"确实还在准备"时出现 —— 它承诺的是"还在动"。
   *    已经出结论（失败）时没有进度可承诺：静态那条也不画，什么都不说比画一个假装在走的条诚实。
   *    （有真实助手进度时照旧画真实百分比：那是事实，不是承诺。）
   */
  const showProgress = hasAssistantProgress || !readiness.hasError;
  // 出口只有两种，而且互斥：确定性失败去激活，不确定的失败才给"重新准备"。
  // ⚠️ 名额已满（`activation-limit-reached`）**例外：不给按钮**。复核实测激活页今天既没有
  //    设备列表也没有解绑入口 ⇒ "去激活"对它是近似死路，留一个按了没用的按钮比没有按钮更坏。
  //    它的出路（换一张卡 / 找客服）由那句文案说清楚。
  const action = relayFailure
    ? relayFailure.kind === 'retryable'
      ? 'retry'
      : relayFailure.kind === 'activation-limit-reached'
        ? null
        : 'activation'
    : readiness.hasError || takingLonger
      ? 'retry'
      : null;
  const openActivationSettings = useCallback(() => {
    setSettingsSection('activation');
    setSettingsOpen(true);
  }, [setSettingsSection, setSettingsOpen]);

  useEffect(() => {
    if (readiness.conversationReady) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 90_000);
    return () => window.clearTimeout(timer);
  }, [readiness.conversationReady]);

  return (
    <section
      aria-live="polite"
      aria-busy={!readiness.isReady && !readiness.hasError}
      className="mx-auto mt-3 w-full max-w-[var(--content-max-width)] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <span
          className={
            status === 'error'
              ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--danger-bg)] text-[var(--danger)]'
              : 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-dim)] text-[var(--accent)]'
          }
        >
          {status === 'error' ? (
            <TriangleAlert size={16} aria-hidden="true" />
          ) : status === 'ready' ? (
            <CheckCircle2 size={16} aria-hidden="true" />
          ) : (
            <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="type-label truncate text-[var(--text-primary)]">{statusText}</h2>
            {hasAssistantProgress && (
              <span className="type-mono-data shrink-0 text-[var(--text-muted)]">
                {t('startupReadiness.progress', { completed, total: readiness.assistants.total })}
              </span>
            )}
          </div>
          {showProgress && (
            <div
              role="progressbar"
              aria-label={t('startupReadiness.overallProgress')}
              aria-valuemin={hasAssistantProgress ? 0 : undefined}
              aria-valuemax={hasAssistantProgress ? readiness.assistants.total : undefined}
              aria-valuenow={hasAssistantProgress ? completed : undefined}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
            >
              <div
                className={
                  hasAssistantProgress
                    ? 'h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 motion-reduce:transition-none'
                    : 'h-full w-1/3 rounded-full bg-[var(--accent)] animate-pulse motion-reduce:animate-none'
                }
                style={hasAssistantProgress ? { width: `${progressPercent}%` } : undefined}
              />
            </div>
          )}
          {assistantError && (
            <p className="type-meta mt-1.5 break-words text-[var(--text-danger)]" data-testid="readiness-reason">
              {assistantError}
            </p>
          )}
        </div>
        {action === 'retry' ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry} className="shrink-0">
            <RefreshCw size={14} />
            {t('startupReadiness.retry')}
          </Button>
        ) : action === 'activation' ? (
          // ⚠️ 确定性失败**不给重试按钮**：那个按钮按下去只会让用户再做一次无用功。
          //    给的是"去哪儿能解决"——设置里那一页（`setSettingsSection('activation')`）。
          <Button type="button" variant="outline" size="sm" onClick={openActivationSettings} className="shrink-0">
            <KeyRound size={14} />
            {t('startupReadiness.openActivation')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
