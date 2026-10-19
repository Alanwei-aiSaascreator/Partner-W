import { useCallback, useEffect, useState } from 'react';
import { MonitorUp, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import mascot from '@/assets/mascot/xiaoying-256.png';
import { isMascotHidden, setMascotHidden, subscribeMascotVisibility } from '@/lib/mascot-visibility';

/**
 * 「小盈」灵宠（2026-10-17 用户：把这张图作为吉祥物，内嵌一个类似 Codex 的灵宠）。
 *
 * 行为刻意做得**安静**：
 *   · 常驻在对话区右下（不挡输入框），轻轻上下浮动；
 *   · 点一下冒一句话（轮换三句），6 秒后自己收；
 *   · 关掉后记住（localStorage），不会再自动出来 —— 灵宠不能变成关不掉的广告。
 *
 * ⚠️ 它不持有任何业务状态：不读任务、不发请求、不插话。要接"干活时的反应"另开一版，
 *    先把静态版跑稳（这一版的目的就是把品牌形象立起来）。
 */
const LINES = ['mascot.line0', 'mascot.line1', 'mascot.line2'] as const;
/**
 * 气泡自动收起的时长（2026-10-18 用户现场：「宠物开局有然后不见了」）。
 *
 * 原来是 6s —— 一句话还没读完就没了，体感就是"宠物自己消失了"。
 * 这里只放宽常量的解释性修复（不是缺陷修复）：30s 足够读完，也不至于挡视线。
 */
const BUBBLE_AUTO_CLOSE_MS = 30_000;

export default function MascotPet() {
  const { t } = useTranslation();
  const [hidden, setHidden] = useState(isMascotHidden);
  // 设置里的开关（或跨窗口）改了这个值 ⇒ 当场跟着变，不用重挂载。
  useEffect(() => subscribeMascotVisibility(() => setHidden(isMascotHidden())), []);
  /** 气泡里正在显示的那一句（null = 不显示）。 */
  const [bubbleKey, setBubbleKey] = useState<string | null>(null);
  const [lineIndex, setLineIndex] = useState(0);

  const dismiss = useCallback(() => {
    setHidden(true);
    setBubbleKey(null);
    setMascotHidden(true);
  }, []);

  useEffect(() => {
    if (!bubbleKey) return;
    const timer = setTimeout(() => setBubbleKey(null), BUBBLE_AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [bubbleKey]);

  if (hidden) return null;

  return (
    <div className="pointer-events-none absolute bottom-36 right-5 z-10 flex flex-col items-end gap-2">
      {bubbleKey ? (
        <div className="pointer-events-auto relative max-w-56 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-elevated)] px-3 py-2 type-support leading-relaxed text-[var(--text-secondary)] shadow-[var(--shadow-elevated)]">
          {t(bubbleKey)}
        </div>
      ) : null}
      {/* ⚠️ 这里的 `group` 是**功能性的**，不是样式糖：两个角标按钮靠 `group-hover`
          显示（`opacity-0` 起步）。2026-10-18 现场发现这个 div 上原本**没有** `group`，
          于是"放到桌面"和"藏起来"两个按钮永远 `opacity-0` ——
          既是"找不到怎么放到桌面"，也是"不小心点到看不见的 X，宠物永久消失"的直接原因。
          回归测试：test/mascot-pet.test.tsx「角标按钮的显示依赖 group 祖先」。 */}
      <div data-testid="mascot-actions" className="group pointer-events-auto relative">
        <button
          type="button"
          data-testid="mascot-pet"
          aria-label={t('mascot.talk')}
          onClick={() => {
            // 先显示**当前**这一句，再推进下标 —— 第一次点击就应该是第一句。
            setBubbleKey(LINES[lineIndex % LINES.length] ?? LINES[0]);
            setLineIndex((index) => index + 1);
          }}
          className="mascot-pet glow-focus block rounded-full"
        >
          <img src={mascot} alt="" width={88} height={88} draggable={false} />
        </button>
        {/* 2026-10-17 用户：「可以拖到桌面」—— 把灵宠放到系统桌面（置顶透明小窗）。 */}
        <button
          type="button"
          data-testid="mascot-desktop"
          aria-label={t('mascot.desktop')}
          onClick={() => void window.clawwork.petOpen?.()}
          className="absolute -left-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <MonitorUp size={12} />
        </button>
        <button
          type="button"
          data-testid="mascot-dismiss"
          aria-label={t('mascot.hide')}
          onClick={dismiss}
          className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--bg-elevated)] text-[var(--text-muted)] opacity-0 transition-opacity hover:text-[var(--text-primary)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}
