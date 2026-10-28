import { ArrowRight, MessageSquarePlus, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * 手机端首屏（空状态）——「深色发光星球」那一版。
 *
 * 参考稿给的是暗色 + 紫色行星 + 大字标题 + 双按钮的质感；直接铺满整屏会和
 * App 的浅色框架打架（底部导航、输入框都是浅色），所以这里的做法是：
 * **一块深色沉浸卡片**装下"星球 + 标题 + 主/次按钮"，卡片之外仍是原页面。
 *
 * 全部用 CSS/SVG 画（径向渐变 + 点阵 pattern + 模糊光晕），不引入任何图片资源：
 * 换主题不会糊、包体不涨、也没有版权素材问题。
 */
export function WelcomeHero({
  onNewTask,
  onOpenTasks,
}: {
  onNewTask: () => void;
  onOpenTasks: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="px-3 pb-2 pt-1">
      <div
        className="relative overflow-hidden rounded-3xl"
        style={{
          background: 'radial-gradient(120% 90% at 50% 18%, #2a1250 0%, #150a2c 42%, #08040f 100%)',
          border: '1px solid rgba(150,110,230,0.25)',
          boxShadow: '0 18px 48px -20px rgba(90,40,180,0.55)',
        }}
      >
        {/* 星点 */}
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div
            className="hero-stars absolute inset-0 opacity-70"
            style={{
              backgroundImage:
                'radial-gradient(1px 1px at 12% 22%, rgba(255,255,255,.85) 50%, transparent 51%),' +
                'radial-gradient(1px 1px at 78% 14%, rgba(255,255,255,.6) 50%, transparent 51%),' +
                'radial-gradient(1.5px 1.5px at 88% 42%, rgba(210,190,255,.7) 50%, transparent 51%),' +
                'radial-gradient(1px 1px at 22% 68%, rgba(255,255,255,.5) 50%, transparent 51%),' +
                'radial-gradient(1px 1px at 62% 82%, rgba(255,255,255,.45) 50%, transparent 51%),' +
                'radial-gradient(1px 1px at 40% 10%, rgba(255,255,255,.55) 50%, transparent 51%)',
            }}
          />
        </div>

        {/* 星球 + 光晕 */}
        <div className="relative mx-auto flex justify-center pt-7" aria-hidden="true">
          <div
            className="hero-glow absolute top-2 h-[220px] w-[220px] rounded-full"
            style={{
              background: 'radial-gradient(circle, rgba(150,95,255,0.6) 0%, rgba(90,40,180,0.2) 55%, transparent 72%)',
              filter: 'blur(18px)',
            }}
          />
          <div className="hero-scan" aria-hidden="true" />
          <svg width="180" height="180" viewBox="0 0 200 200" className="hero-planet relative">
            <defs>
              <radialGradient id="planetFill" cx="42%" cy="34%" r="72%">
                <stop offset="0%" stopColor="#7c4dff" stopOpacity="0.55" />
                <stop offset="55%" stopColor="#4b1e9e" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#150a2c" stopOpacity="0.95" />
              </radialGradient>
              <pattern id="planetDots" width="7" height="7" patternUnits="userSpaceOnUse">
                <circle cx="1.4" cy="1.4" r="0.9" fill="rgba(214,190,255,0.55)" />
              </pattern>
              <radialGradient id="planetEdge" cx="50%" cy="50%" r="50%">
                <stop offset="86%" stopColor="rgba(180,140,255,0)" />
                <stop offset="97%" stopColor="rgba(190,150,255,0.75)" />
                <stop offset="100%" stopColor="rgba(190,150,255,0)" />
              </radialGradient>
            </defs>
            <circle cx="100" cy="100" r="92" fill="url(#planetFill)" />
            <circle cx="100" cy="100" r="92" fill="url(#planetDots)" opacity="0.5" />
            <circle cx="100" cy="100" r="92" fill="url(#planetEdge)" />
            <ellipse cx="100" cy="100" rx="92" ry="30" fill="none" stroke="rgba(170,130,255,0.22)" strokeWidth="0.8" />
            <ellipse cx="100" cy="100" rx="60" ry="92" fill="none" stroke="rgba(170,130,255,0.14)" strokeWidth="0.8" />
          </svg>
        </div>

        {/* 文案 */}
        <div className="relative px-5 pb-5 pt-3 text-center">
          <h1 style={{ color: '#fff', fontSize: 27, lineHeight: 1.2, fontWeight: 700, letterSpacing: '-0.01em' }}>
            {t('hero.titleLine1')}
          </h1>
          <p
            style={{
              color: 'rgba(226,214,255,0.86)',
              fontSize: 21,
              lineHeight: 1.3,
              marginTop: 4,
              fontStyle: 'italic',
              fontFamily: 'Georgia, "Times New Roman", serif',
            }}
          >
            {t('hero.titleLine2')}
          </p>
          <p style={{ color: 'rgba(206,196,230,0.72)', fontSize: 13.5, lineHeight: 1.55, marginTop: 10 }}>
            {t('hero.subtitle')}
          </p>

          <div className="mt-4 flex flex-col gap-2">
            <button
              onClick={onNewTask}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl py-3 type-label"
              style={{
                background: 'linear-gradient(180deg, #8b5cf6 0%, #6d28d9 100%)',
                color: '#fff',
                minHeight: 46,
                boxShadow: '0 10px 24px -10px rgba(124,58,237,0.85)',
              }}
            >
              <MessageSquarePlus size={16} />
              {t('hero.primaryCta')}
              <ArrowRight size={15} />
            </button>
            <button
              onClick={onOpenTasks}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 type-support"
              style={{
                backgroundColor: 'rgba(255,255,255,0.07)',
                color: 'rgba(238,232,255,0.92)',
                border: '1px solid rgba(255,255,255,0.16)',
                minHeight: 42,
                backdropFilter: 'blur(6px)',
              }}
            >
              <Sparkles size={13} />
              {t('hero.secondaryCta')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
