import { Bot, CheckCircle2, FileInput, FileOutput, LoaderCircle, Plus, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AssistantTaskPreset } from '@/lib/assistant-task-presets';
import type { AssistantWorkspaceDefinition } from '@/lib/preset-agents';
import brandLogo from '@/assets/logo.png';

export interface AssistantTaskWorkbenchProps {
  definition: AssistantWorkspaceDefinition;
  modelLabel: string;
  ready: boolean;
  /**
   * **已知失败**的本地化结论（`null` / 缺省 = 没有已知失败，照旧是"还在准备"）。
   * ⚠️ 判据来自启动就绪度已算出的结论（见 `startupFailureText`），这里不重新推断目录。
   */
  failureText?: string | null;
  recentPresetIds: readonly string[];
  onSelectPreset: (preset: AssistantTaskPreset) => void;
  onCustomTask: () => void;
}

export default function AssistantTaskWorkbench({
  definition,
  modelLabel,
  ready,
  failureText = null,
  recentPresetIds,
  onSelectPreset,
  onCustomTask,
}: AssistantTaskWorkbenchProps) {
  const { t } = useTranslation();
  const presetsById = new Map(definition.starters.map((preset) => [preset.id, preset]));
  const recentPresets = Array.from(new Set(recentPresetIds)).flatMap((id) => {
    const preset = presetsById.get(id);
    return preset ? [preset] : [];
  });

  return (
    <section
      aria-labelledby="assistant-task-workbench-title"
      className="relative mx-auto flex w-full max-w-[var(--content-max-width)] flex-col px-2 py-5"
    >
      {/* 顶部氛围光晕（纯装饰，不接事件）。 */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-10 -top-8 h-44 rounded-full bg-[var(--brand-glow)] opacity-70 blur-3xl"
      />
      <header className="flex flex-col items-center text-center">
        {/* 2026-10-28 用户：徽标换成荧光态的 Partner-W logo（原为「渐变底 + 助手 emoji」方块）。
            emoji 转为 sr-only —— 既有测试按 textContent 断言它在，读屏也还需要这个语义。 */}
        <img
          src={brandLogo}
          alt=""
          aria-hidden="true"
          className="h-12 w-12 rounded-xl [filter:drop-shadow(0_0_8px_var(--accent))_drop-shadow(0_0_18px_var(--brand-glow))]"
        />
        <span className="sr-only">{definition.emoji}</span>
        <h1
          id="assistant-task-workbench-title"
          className="type-page-title mt-3 bg-clip-text text-transparent [background-image:var(--brand-gradient)]"
        >
          {t(definition.titleKey)}
        </h1>
        <p className="type-body mt-1 max-w-2xl text-[var(--text-secondary)]">{t(definition.descriptionKey)}</p>

        <div className="mt-3 flex flex-wrap items-center justify-center gap-2 type-support text-[var(--text-secondary)]">
          <span className="inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5">
            <Bot size={13} aria-hidden="true" />
            {modelLabel}
          </span>
          {/*
            ⚠️ 三态，不是两态：**已知失败**时既不许转圈、也不许说"正在启动 AI 服务" ——
            否则上面那条真话（面板里的「去激活」）与正下方一个转圈同屏，用户看到的
            仍然是"它还在准备"（2026-09-21 第二台机器实机的形状）。
          */}
          <span
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className={
              ready || !failureText
                ? 'inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5'
                : 'inline-flex items-center gap-1.5 rounded-md bg-[var(--danger-bg)] px-2.5 py-1.5 text-[var(--danger)]'
            }
          >
            {ready ? (
              <CheckCircle2 size={13} aria-hidden="true" className="text-[var(--accent)]" />
            ) : failureText ? (
              // 与面板同一套静态警示（`TriangleAlert` + danger token）：不动 = 没有进度可承诺。
              <TriangleAlert size={13} aria-hidden="true" />
            ) : (
              <LoaderCircle
                size={13}
                aria-hidden="true"
                className="animate-spin text-[var(--accent)] motion-reduce:animate-none"
              />
            )}
            {ready ? t('startupReadiness.aiReady') : (failureText ?? t('startupReadiness.aiStarting'))}
          </span>
        </div>
      </header>

      {recentPresets.length > 0 && (
        <div
          className="mt-5 flex flex-wrap items-center justify-center gap-2"
          aria-label={t('taskWorkbench.recentTasks')}
        >
          <span className="type-support text-[var(--text-muted)]">{t('taskWorkbench.recentTasks')}</span>
          {recentPresets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-testid="assistant-task-recent-preset"
              data-preset-id={preset.id}
              onClick={() => onSelectPreset(preset)}
              className="glow-focus rounded-md bg-[var(--bg-tertiary)] px-2.5 py-1.5 text-left type-support text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] focus-visible:outline-none motion-reduce:transition-none"
            >
              {t(preset.titleKey)}
            </button>
          ))}
        </div>
      )}

      {/*
        预设任务清单（2026-10-28 用户：**不要卡片**——边框+底色的四张大卡太占地方，
        欢迎屏一滚就把输入框顶出视口）。改成无边框的紧凑行式：hover 才有浅底，
        「建议资料 / 预期成果」压成两小段同排小字。⚠️ data-testid / data-preset-id /
        网格类（grid-cols-1 / sm:grid-cols-2）是既有测试契约，别动。
      */}
      <div className="mt-4 grid grid-cols-1 gap-x-8 sm:grid-cols-2">
        {definition.starters.map((preset) => (
          <button
            key={preset.id}
            type="button"
            data-testid="assistant-task-preset"
            data-preset-id={preset.id}
            onClick={() => onSelectPreset(preset)}
            className="glow-focus group flex flex-col rounded-xl px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none motion-reduce:transition-none"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="type-label shrink-0 font-semibold text-[var(--text-primary)] group-hover:text-[var(--accent)]">
                {t(preset.titleKey)}
              </span>
              <span className="type-support min-w-0 truncate text-[var(--text-secondary)]">
                {t(preset.descriptionKey)}
              </span>
            </span>
            <span className="type-support mt-1 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-0.5 text-[var(--text-muted)]">
              <span className="inline-flex min-w-0 items-center gap-1">
                <FileInput size={12} aria-hidden="true" className="shrink-0" />
                <span className="truncate">
                  {t('taskWorkbench.materialHint')}：{t(preset.materialHintKey)}
                </span>
              </span>
              <span className="inline-flex min-w-0 items-center gap-1">
                <FileOutput size={12} aria-hidden="true" className="shrink-0" />
                <span className="truncate">
                  {t('taskWorkbench.output')}：{t(preset.outputKey)}
                </span>
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="mt-4 flex justify-center">
        <button
          type="button"
          data-testid="assistant-task-custom"
          onClick={onCustomTask}
          className="glow-focus inline-flex items-center gap-2 rounded-lg px-4 py-2 type-label text-white [background:var(--brand-gradient)] shadow-[var(--shadow-card)] transition-opacity hover:opacity-90 focus-visible:outline-none motion-reduce:transition-none"
        >
          <Plus size={15} aria-hidden="true" />
          {t('taskWorkbench.customTask')}
        </button>
      </div>
    </section>
  );
}
