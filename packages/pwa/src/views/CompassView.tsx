import {
  ArrowLeft,
  ChevronRight,
  CircleDashed,
  Lightbulb,
  Plus,
  Sparkles,
  Target,
  Zap,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { composer } from '../stores';

interface Starter {
  title: string;
  description: string;
  materialHint: string;
  output: string;
  prompt: string;
}

/**
 * 罗盘助手（手机端）—— 对齐桌面端主页面：
 * 居中标题 + 副标题 + 状态徽标 + 四张起步卡片 + 自定义任务 + 当前助手。
 *
 * 点卡片 = 用桌面端同一套预设提示词直接开一个新任务（和电脑上点同一张卡片等价）。
 */
export function CompassView({
  onClose,
  onOpenAgentSelector,
}: {
  onClose: () => void;
  onOpenAgentSelector?: () => void;
}) {
  const { t } = useTranslation();
  const starters = t('compass.starters', { returnObjects: true }) as unknown as Starter[];
  const list = Array.isArray(starters) ? starters : [];

  const start = async (starter: Starter): Promise<void> => {
    try {
      await composer.send(undefined, { content: starter.prompt, titleHint: starter.title });
      onClose();
    } catch {
      /* 发送失败留在原地，错误由对话区显示 */
    }
  };

  return (
    <div className="module-sheet fixed inset-0 z-[60] flex flex-col" style={{ backgroundColor: 'var(--bg-primary)' }}>
      <header className="safe-area-top flex shrink-0 items-center gap-2 px-2 py-2">
        <button
          onClick={onClose}
          aria-label={t('common.close')}
          className="rounded-lg p-2"
          style={{ color: 'var(--text-secondary)', minHeight: 44, minWidth: 44 }}
        >
          <ArrowLeft size={20} />
        </button>
        <p className="flex-1 text-center type-label" style={{ color: 'var(--text-primary)' }}>
          {t('nav.assistant')}
        </p>
        <div style={{ width: 44 }} aria-hidden="true" />
      </header>

      <div className="flex-1 overflow-y-auto px-4 pb-10">
        <div className="pt-1 text-center">
          <h1 className="type-title" style={{ color: 'var(--text-primary)' }}>
            {t('nav.assistant')}
          </h1>
          <p className="type-support mt-1" style={{ color: 'var(--text-muted)' }}>
            {t('compass.subtitle')}
          </p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-1.5">
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 type-support"
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}
            >
              <Zap size={11} />
              {t('compass.badgeSmart')}
            </span>
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 type-support"
              style={{ backgroundColor: 'var(--bg-secondary)', color: 'var(--text-muted)' }}
            >
              <CircleDashed size={11} />
              {t('compass.badgeReady')}
            </span>
          </div>
        </div>

        <div className="mt-4 flex flex-col gap-2">
          {list.map((starter, index) => (
            <button
              key={starter.title ?? index}
              onClick={() => void start(starter)}
              className="w-full rounded-2xl px-3.5 py-3 text-left"
              style={{ backgroundColor: 'var(--bg-secondary)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="flex items-center gap-2">
                <Sparkles size={15} className="shrink-0" style={{ color: 'var(--accent)' }} />
                <p className="type-section-title flex-1" style={{ color: 'var(--text-primary)' }}>
                  {starter.title}
                </p>
                <ChevronRight size={15} style={{ color: 'var(--text-muted)' }} />
              </div>
              <p className="mt-0.5 type-support" style={{ color: 'var(--text-secondary)' }}>
                {starter.description}
              </p>
              <div className="mt-2 space-y-1">
                <div className="flex items-start gap-1.5">
                  <Lightbulb size={11} className="mt-0.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('compass.material')}</span>
                    {starter.materialHint}
                  </p>
                </div>
                <div className="flex items-start gap-1.5">
                  <Target size={11} className="mt-0.5 shrink-0" style={{ color: 'var(--text-muted)' }} />
                  <p className="type-support" style={{ color: 'var(--text-muted)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}>{t('compass.output')}</span>
                    {starter.output}
                  </p>
                </div>
              </div>
            </button>
          ))}
        </div>

        {list.length === 0 && (
          <p className="type-body py-8 text-center" style={{ color: 'var(--text-muted)' }}>
            {t('modules.empty')}
          </p>
        )}

        <button
          onClick={onClose}
          className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-2xl py-3 type-label"
          style={{
            backgroundColor: 'transparent',
            border: '1px dashed var(--border-subtle)',
            color: 'var(--text-secondary)',
            minHeight: 44,
          }}
        >
          <Plus size={15} />
          {t('compass.customTask')}
        </button>

        <div className="mt-6 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
          <p className="text-center type-support" style={{ color: 'var(--text-muted)' }}>
            {t('compass.currentAssistant')}
          </p>
          <button
            onClick={onOpenAgentSelector}
            className="mx-auto mt-2 flex items-center gap-2 rounded-xl px-3 py-2 type-label"
            style={{
              backgroundColor: 'var(--bg-secondary)',
              border: '1px solid var(--accent)',
              color: 'var(--text-primary)',
              minHeight: 44,
            }}
          >
            <Sparkles size={14} style={{ color: 'var(--accent)' }} />
            {t('nav.assistant')}
            <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />
          </button>
          <p className="mt-4 text-center type-support" style={{ color: 'var(--text-muted)', opacity: 0.8 }}>
            {t('compass.disclaimer')}
          </p>
        </div>
      </div>
    </div>
  );
}
