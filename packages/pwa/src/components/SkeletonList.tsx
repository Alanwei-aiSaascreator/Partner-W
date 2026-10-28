/**
 * 列表骨架屏 —— 加载中不要只显示一个转圈：
 * 转圈只告诉用户"在等"，骨架告诉他"马上会出现什么形状的东西"（体感快很多）。
 */
export function SkeletonList({ rows = 4, withBadge = false }: { rows?: number; withBadge?: boolean }) {
  return (
    <div className="mt-2 flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="ui-card px-3.5 py-3"
          style={{ opacity: 1 - index * 0.12 }}
        >
          <div className="flex items-start gap-2.5">
            <div className="skeleton-line h-9 w-9 shrink-0 rounded-xl" style={{ height: 36, width: 36 }} />
            <div className="min-w-0 flex-1">
              <div className="skeleton-line" style={{ width: `${70 - index * 6}%` }} />
              <div className="skeleton-line mt-2" style={{ width: `${92 - index * 8}%`, height: 10 }} />
            </div>
          </div>
          {withBadge && (
            <div className="mt-3 flex justify-end">
              <div className="skeleton-line" style={{ width: 64, height: 20 }} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
