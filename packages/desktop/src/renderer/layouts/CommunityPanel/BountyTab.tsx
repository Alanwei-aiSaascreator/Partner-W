import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Gift } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import EmptyState from '@/components/semantic/EmptyState';
import SectionCard from '@/components/semantic/SectionCard';
import StatusTag from '@/components/semantic/StatusTag';
import type { StatusKind } from '@/lib/ui-contract';
import { useBounties, type BountyAction } from './useBounties';

/** 状态 → 语义色（键与迁移 47 的 check 约束一字不差）。 */
const STATUS_TONE: Record<string, StatusKind> = {
  open: 'accent',
  claimed: 'warning',
  submitted: 'warning',
  accepted: 'success',
  cancelled: 'neutral',
};

const STATUS_KEY: Record<string, string> = {
  open: 'bounty.status_open',
  claimed: 'bounty.status_claimed',
  submitted: 'bounty.status_submitted',
  accepted: 'bounty.status_accepted',
  cancelled: 'bounty.status_cancelled',
};

/** 动作 → 文案键。顺序即渲染顺序。 */
const ACTIONS: Array<{ action: BountyAction; key: string; flag: keyof BountyFlags }> = [
  { action: 'claim', key: 'bounty.claim', flag: 'canClaim' },
  { action: 'release', key: 'bounty.release', flag: 'canRelease' },
  { action: 'submit', key: 'bounty.submit', flag: 'canSubmit' },
  { action: 'accept', key: 'bounty.accept', flag: 'canAccept' },
  { action: 'reject', key: 'bounty.reject', flag: 'canReject' },
  { action: 'cancel', key: 'bounty.cancel', flag: 'canCancel' },
];

interface BountyFlags {
  canClaim: boolean;
  canRelease: boolean;
  canSubmit: boolean;
  canAccept: boolean;
  canReject: boolean;
  canCancel: boolean;
}

/**
 * 悬赏（团队协作的第三个 tab）。
 *
 * 权限一律看服务端给的 `can_*` 标记 —— 界面不自己推断"我现在能不能验收"。
 */
export default function BountyTab() {
  const { t } = useTranslation();
  const { bounties, loading, error, busy, publish, act } = useBounties();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [reward, setReward] = useState('100');

  const rewardValue = Number(reward);
  const canPublish =
    title.trim().length > 0 && Number.isFinite(rewardValue) && rewardValue >= 10 && rewardValue <= 1000;

  const submitPublish = async () => {
    const ok = await publish({ title: title.trim(), description: description.trim(), reward: rewardValue });
    if (ok) {
      setTitle('');
      setDescription('');
    }
  };

  return (
    <div data-testid="bounty-tab" className="flex h-full flex-col gap-4 overflow-hidden p-4">
      <SectionCard title={t('bounty.publish')}>
        <div className="flex flex-col gap-2">
          <input
            data-field="new-bounty-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('bounty.titlePlaceholder')}
            className="type-body rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <textarea
            data-field="new-bounty-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('bounty.descriptionPlaceholder')}
            rows={2}
            className="type-body rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
          />
          <div className="flex items-center gap-2">
            <input
              data-field="new-bounty-reward"
              value={reward}
              onChange={(e) => setReward(e.target.value)}
              inputMode="numeric"
              className="type-body w-24 rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-[var(--text-primary)] outline-none"
            />
            <Button data-action="publish" disabled={!canPublish || busy} onClick={() => void submitPublish()}>
              <Gift />
              {t('bounty.publish')}
            </Button>
          </div>
        </div>
      </SectionCard>

      {error ? (
        <p className="type-body text-[var(--danger)]" data-field="error">
          {error}
        </p>
      ) : null}

      <ScrollArea className="min-h-0 flex-1">
        {bounties.length === 0 && !loading ? (
          <EmptyState title={t('bounty.empty')} />
        ) : (
          bounties.map((bounty) => (
            // SectionCard 的 props 是写死的（不接受任意属性）⇒ 测试钩子挂在外层
            <div key={bounty.id} data-bounty={bounty.id} className="mb-3">
              <SectionCard
                title={bounty.title}
                subtitle={
                  <span className="flex items-center gap-2">
                    {t('bounty.meta', {
                      reward: bounty.reward,
                      status: t(STATUS_KEY[bounty.status] ?? 'bounty.status_cancelled'),
                    })}
                    <StatusTag tone={STATUS_TONE[bounty.status] ?? 'neutral'}>
                      {t(STATUS_KEY[bounty.status] ?? 'bounty.status_cancelled')}
                    </StatusTag>
                  </span>
                }
              >
                {bounty.description ? (
                  <p className="type-body mb-2 text-[var(--text-secondary)]">{bounty.description}</p>
                ) : null}
                <p className="type-support text-[var(--text-muted)]">
                  {t('bounty.author', { name: bounty.authorName })}
                  {bounty.claimantName ? ` · ${t('bounty.claimant', { name: bounty.claimantName })}` : ''}
                </p>
                {bounty.submittedNote ? (
                  <p className="type-support mt-1 text-[var(--text-muted)]">{bounty.submittedNote}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  {ACTIONS.filter((item) => bounty[item.flag]).map((item) => (
                    <Button
                      key={item.action}
                      variant="secondary"
                      data-action={item.action}
                      disabled={busy}
                      onClick={() =>
                        void act(
                          item.action,
                          bounty.id,
                          item.action === 'submit'
                            ? t('bounty.defaultSubmitNote')
                            : item.action === 'reject'
                              ? t('bounty.defaultRejectNote')
                              : '',
                        )
                      }
                    >
                      {t(item.key)}
                    </Button>
                  ))}
                </div>
              </SectionCard>
            </div>
          ))
        )}
      </ScrollArea>
    </div>
  );
}
