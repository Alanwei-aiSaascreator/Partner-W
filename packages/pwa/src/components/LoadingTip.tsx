import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * 「正在干活」的俏皮话轮播。
 *
 * 等待模型时的空白是最难熬的一段：只显示「正在响应」四个字，用户会怀疑是不是卡了。
 * 这里每 2.8 秒换一句（文案走 i18n，随界面语言变），既能证明进程还活着，也不至于太快晃眼。
 */
export function LoadingTip({ className, style }: { className?: string; style?: React.CSSProperties }) {
  const { t } = useTranslation();
  const tips = t('chat.loadingTips', { returnObjects: true }) as unknown as string[];
  const list = Array.isArray(tips) && tips.length > 0 ? tips : [];
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (list.length <= 1) return;
    const timer = setInterval(() => setIndex((prev) => (prev + 1) % list.length), 2800);
    return () => clearInterval(timer);
  }, [list.length]);

  if (list.length === 0) return null;

  return (
    <span key={index} className={className} style={{ ...style, animation: 'fadeIn 0.35s ease-out' }}>
      {list[index]}
    </span>
  );
}
