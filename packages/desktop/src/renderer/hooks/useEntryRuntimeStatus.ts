import { useEffect, useRef, useState } from 'react';
import type { RuntimeBootstrapStatus } from '@clawwork/shared';
export function useEntryRuntimeStatus(scopeKey: string | null): RuntimeBootstrapStatus | null | undefined {
  const scope = useRef({ key: scopeKey, attempt: 0 });
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey, attempt: scope.current.attempt + 1 };
  const attempt = scope.current.attempt;
  const [snapshot, setSnapshot] = useState<{ attempt: number; value: RuntimeBootstrapStatus | null } | null>(null);
  useEffect(() => {
    if (!scopeKey) return;
    let active = true;
    let eventVersion = 0;
    const isCurrent = () => active && scope.current.key === scopeKey && scope.current.attempt === attempt;
    const api = window.clawwork;
    const unsubscribe = api.onRuntimeStatus((next) => {
      eventVersion += 1;
      if (isCurrent()) setSnapshot({ attempt, value: next });
    });
    const readVersion = eventVersion;
    void api
      .runtimeStatus()
      .then((value) => {
        if (isCurrent() && eventVersion === readVersion) setSnapshot({ attempt, value });
      })
      .catch(() => {
        if (isCurrent() && eventVersion === readVersion) setSnapshot({ attempt, value: null });
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [scopeKey, attempt]);
  return scopeKey && snapshot?.attempt === attempt ? snapshot.value : undefined;
}
