import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { PORTRAIT_AXES, PORTRAIT_AXIS_I18N, type PortraitAxes } from '@/lib/user-portrait';

/**
 * 五维趣味雷达（手写 SVG，不引图表库）。
 *
 * 为什么手写：五个轴、五个数，输入固定；手写 SVG 每个维度的分数都直接挂成
 * `data-score`、形状就是多边形 `points`，jsdom 里能钉住"分数变了形状真的变"
 * （图表库在 jsdom 拿不到布局，只能测外壳）。配色全走主题 CSS 变量，深色模式自动跟随。
 */

const CENTER = 100;
const RADIUS = 70;
const LABEL_RADIUS = 82;
const GRID_SCALES = [0.2, 0.4, 0.6, 0.8, 1] as const;

function angleFor(index: number): number {
  return ((-90 + index * 72) * Math.PI) / 180;
}

function pointAt(index: number, scale: number): { x: number; y: number } {
  const angle = angleFor(index);
  return { x: CENTER + RADIUS * scale * Math.cos(angle), y: CENTER + RADIUS * scale * Math.sin(angle) };
}

function polygonPoints(scales: readonly number[]): string {
  return PORTRAIT_AXES.map((_, index) => {
    const { x, y } = pointAt(index, scales[index] ?? 0);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

interface PortraitRadarProps {
  axes: PortraitAxes;
  className?: string;
}

export default function PortraitRadar({ axes, className }: PortraitRadarProps) {
  const { t } = useTranslation();
  const scores = PORTRAIT_AXES.map((axis) => clampScore(axes[axis]));

  return (
    <svg
      viewBox="0 0 200 200"
      role="img"
      aria-label={t('onboarding.portrait.radarLabel')}
      data-testid="portrait-radar"
      data-scores={scores.join(',')}
      className={cn('h-auto w-full overflow-visible', className)}
    >
      {GRID_SCALES.map((scale) => (
        <polygon
          key={scale}
          points={polygonPoints(PORTRAIT_AXES.map(() => scale))}
          fill="none"
          stroke="var(--border)"
          strokeWidth={0.8}
        />
      ))}
      {PORTRAIT_AXES.map((axis, index) => {
        const end = pointAt(index, 1);
        return (
          <line
            key={axis}
            x1={CENTER}
            y1={CENTER}
            x2={end.x}
            y2={end.y}
            stroke="var(--border-subtle)"
            strokeWidth={0.8}
          />
        );
      })}
      <polygon
        data-radar-shape
        points={polygonPoints(scores.map((score) => score / 100))}
        fill="var(--accent-dim)"
        stroke="var(--accent)"
        strokeWidth={1.6}
      />
      {PORTRAIT_AXES.map((axis, index) => {
        const vertex = pointAt(index, scores[index] / 100);
        return (
          <circle
            key={axis}
            data-axis={axis}
            data-score={scores[index]}
            cx={vertex.x}
            cy={vertex.y}
            r={3}
            fill="var(--accent)"
          />
        );
      })}
      {PORTRAIT_AXES.map((axis, index) => {
        const angle = angleFor(index);
        return (
          <text
            key={axis}
            x={CENTER + LABEL_RADIUS * Math.cos(angle)}
            y={CENTER + LABEL_RADIUS * Math.sin(angle) + 4}
            textAnchor="middle"
            fontSize={11}
            fill="var(--text-muted)"
          >
            {t(`onboarding.portrait.dimensions.${PORTRAIT_AXIS_I18N[axis]}`)}
          </text>
        );
      })}
    </svg>
  );
}
