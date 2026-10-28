import { useCallback, useEffect, useState } from 'react';
import { describeGrowthError, normalizeBounties } from '@clawwork/core';
import type { Bounty } from '@clawwork/shared';
import { toast } from '@/lib/toast';

export type BountyAction = 'claim' | 'release' | 'submit' | 'accept' | 'reject' | 'cancel';

/**
 * 悬赏列表 + 六个动作。
 *
 * 「谁能做什么」**不由这里判断** —— `bounty_list` 回来的每一行都带了
 * `can_*` 标记（服务端按状态机与身份算好的），界面只照着渲染。
 * 前端再算一遍就等于有了第二份真相，迟早跟服务端漂开。
 */
export function useBounties() {
  const [bounties, setBounties] = useState<Bounty[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await window.clawwork.bountyList({ status: null });
    if (!res.ok) {
      setError(describeGrowthError(res.errorCode));
      return;
    }
    setError(null);
    setBounties(normalizeBounties(res.result));
  }, []);

  useEffect(() => {
    void load().finally(() => setLoading(false));
  }, [load]);

  const publish = useCallback(
    async (input: { title: string; description: string; reward: number }) => {
      setBusy(true);
      try {
        const res = await window.clawwork.bountyCreate(input);
        if (!res.ok) {
          toast.error(describeGrowthError(res.errorCode));
          return false;
        }
        await load();
        return true;
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const act = useCallback(
    async (action: BountyAction, id: string, note = '') => {
      setBusy(true);
      try {
        const api = window.clawwork;
        const res =
          action === 'claim'
            ? await api.bountyClaim(id)
            : action === 'release'
              ? await api.bountyRelease(id)
              : action === 'submit'
                ? await api.bountySubmit({ id, note })
                : action === 'accept'
                  ? await api.bountyAccept(id)
                  : action === 'reject'
                    ? await api.bountyReject({ id, note })
                    : await api.bountyCancel(id);

        if (!res.ok) {
          toast.error(describeGrowthError(res.errorCode));
          return;
        }
        await load();
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  return { bounties, loading, error, busy, publish, act, reload: load };
}
