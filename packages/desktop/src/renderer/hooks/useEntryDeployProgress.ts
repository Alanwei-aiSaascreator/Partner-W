import { useEffect, useRef, useState } from 'react';
import type { RuntimeDeployProgress } from '@clawwork/shared';

/**
 * 本机运行时**部署**的实时进度（准备页用）。
 *
 * 与 `useEntryRuntimeStatus` 同一个形状的同一个理由：
 *   - **先订阅、再补读**：部署在窗口建好之前就跑，那之前的事件没人收 ⇒ 必须补读一次快照；
 *     而补读是异步的，反过来写的话"订阅前那一瞬"发生的事件会丢；
 *   - **补读不许盖掉事件**：用版本号（`eventVersion`）比对，晚到的初始读若比手头的事件旧，
 *     一律丢弃 —— 否则界面会把"已经在解压 60%"重新显示成几百毫秒前的百分比；
 *   - **按 scope 代次隔离**：`scopeKey` 换了（换账号 / 换工作区 / 点过重试）⇒ 旧快照作废。
 *
 * 返回值语义（三态，**别混**）：
 *   - `undefined` = 还没有结论（挂载中 / 这个 scope 还没读回来）→ 界面什么都不说；
 *   - `null` = 读到了：**现在没有部署在进行**（不是"部署完成"，也不是"没问题"）；
 *   - 对象 = 正在部署，`phase/done/total/startedAt` 都是主进程报来的真值。
 *
 * ⚠️ 宿主没有这条通道（pwa / 更老的 preload）时一律 `undefined`：少一条进度，
 *    不该把整块准备页带崩（同 `StartupReadinessPanel` 对 `isPortableWorkspace` 的处理）。
 */
export function useEntryDeployProgress(scopeKey: string | null): RuntimeDeployProgress | null | undefined {
  const scope = useRef({ key: scopeKey, attempt: 0 });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, attempt: scope.current.attempt + 1 };
  const attempt = scope.current.attempt;
  const [snapshot, setSnapshot] = useState<{ attempt: number; value: RuntimeDeployProgress | null } | null>(null);
  useEffect(() => {
    if (!scopeKey) return;
    const api = window.clawwork as
      | {
          onRuntimeDeployProgress?: (callback: (progress: RuntimeDeployProgress | null) => void) => () => void;
          runtimeDeployProgress?: () => Promise<RuntimeDeployProgress | null>;
        }
      | undefined;
    if (typeof api?.onRuntimeDeployProgress !== 'function' || typeof api.runtimeDeployProgress !== 'function') return;
    let active = true;
    let eventVersion = 0;
    const isCurrent = () => active && scope.current.key === scopeKey && scope.current.attempt === attempt;
    const unsubscribe = api.onRuntimeDeployProgress((next) => {
      eventVersion += 1;
      if (isCurrent()) setSnapshot({ attempt, value: next });
    });
    const readVersion = eventVersion;
    void api
      .runtimeDeployProgress()
      .then((value) => {
        if (isCurrent() && eventVersion === readVersion) setSnapshot({ attempt, value });
      })
      .catch(() => {
        // 读不到 = **没有结论**（不编一个"没有部署"出来）：什么都不改。
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [scopeKey, attempt]);
  return scopeKey && snapshot?.attempt === attempt ? snapshot.value : undefined;
}
