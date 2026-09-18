import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import SectionCard from '@/components/semantic/SectionCard';
import { describePrivacyError, type PrivacyState } from '@clawwork/core';
import { toast } from '@/lib/toast';

/**
 * 设置页「隐私与数据」（P4，毕业自内测中心）。
 *
 * ⚠️ 渲染层**直接读 `window.clawwork`**（渲染层没有 supabase；样板见
 *    `renderer/lib/export-session.ts`）。
 * ⚠️ **不要在这里再跑 `normalizePrivacyState`**：main 的 `privacy:state` 已经归一化过
 *    （camelCase + 真布尔），而 core 的归一化只读 snake_case、**不幂等** —— 再跑一次
 *    会把 `scheduledFor` 抹成 null，冷却天数就被说成"冷却期已结束"。
 * ⚠️ 删除的两条后果（本地数据一并清除 / 名下组织的中转卡吊销且额度不退）必须写在
 *    确认弹层里，且要**勾选 + 输入确认词**两道门都过了才允许提交（设计 §5.3）。
 */

const DAY_MS = 86_400_000;

/** 撤回 / 驳回 / 失败 = 这张单子不再有效，等同于"没有在跑的删除工单"。 */
const ENDED_DELETION_STATUSES = ['cancelled', 'rejected', 'failed'];

/** 导出还在准备中（服务端同步出快照，正常看不到这两个状态，但状态机允许）。 */
const RUNNING_EXPORT_STATUSES = ['pending', 'processing'];

/** 一次隐私 IPC 的返回：`ok` + main 压缩过的机器码。 */
type PrivacyOutcome = { ok: boolean; errorCode?: string };

/**
 * ⚠️ 这里**故意多一层别名**：`check:renderer-copy` 靠「尖括号夹住英文」找写死的
 *    JSX 文案，而箭头返回位置上直接写 `Promise` + 泛型参数会被它当成一段文案
 *    （假阳性 ⇒ 校验红）。写成别名后箭头后面跟的是裸标识符，就不再匹配了。
 */
type PrivacyPending = Promise<PrivacyOutcome>;

/** `run` 收到的闭包：**调用它才发请求**（成功/失败都靠返回值，不靠抛）。 */
type PrivacyAction = () => PrivacyPending;

/**
 * 冷却期剩余天数。三态必须分开：
 *   · 数字 > 0 ⇒ 还剩几天
 *   · 0 ⇒ 已到期（可以执行了）
 *   · **null ⇒ 读不出绝对时刻**（缺失或 `Date.parse` → NaN）
 * ⚠️ null 绝不能被当成 0 说成"冷却期已结束"——那是把"不知道"讲成"已经到期"，
 *    用户会以为再也撤不回来。
 */
function cooldownDaysLeft(scheduledFor: string | null): number | null {
  if (!scheduledFor) return null;
  const due = Date.parse(scheduledFor);
  if (!Number.isFinite(due)) return null;
  return Math.max(0, Math.ceil((due - Date.now()) / DAY_MS));
}

export default function PrivacySection() {
  const { t } = useTranslation();
  const [state, setState] = useState<PrivacyState>({ export: null, deletion: null });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typedWord, setTypedWord] = useState('');
  const [downloadResult, setDownloadResult] = useState<{ truncated: boolean; notes: string } | null>(null);

  // ⚠️ 这个函数**不抛**：它被 `run` / `download` 的 finally 调用，抛了就会把 busy 卡住。
  const refresh = useCallback(async () => {
    try {
      const res = await window.clawwork.privacyState();
      if (res.ok && res.result) {
        setState(res.result);
        setLoadError(null);
        return;
      }
      // 读不到就说读不到：把失败画成"没有工单"会让人以为没有在跑的申请（暂时 ≠ 没有）。
      if (!res.ok) setLoadError(res.errorCode ?? 'unknown');
    } catch (error) {
      console.error('[privacy] privacyState failed:', error);
      setLoadError('unknown');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = useCallback(
    async (action: PrivacyAction) => {
      setBusy(true);
      try {
        const res = await action();
        // `cancelled` = 用户在保存对话框点了取消（handler 如实回这个码）⇒ 安静收场，不当错误。
        if (!res.ok && res.errorCode !== 'cancelled') toast.error(describePrivacyError(res.errorCode));
      } catch (error) {
        console.error('[privacy] action failed:', error);
        toast.error(describePrivacyError('unknown'));
      } finally {
        await refresh();
        setBusy(false);
      }
    },
    [refresh],
  );

  const download = useCallback(async () => {
    setBusy(true);
    try {
      const res = await window.clawwork.privacyDownloadExport();
      if (!res.ok) {
        if (res.errorCode !== 'cancelled') toast.error(describePrivacyError(res.errorCode));
      } else if (!res.result) {
        // `ok` 却没有结果：主进程的 handler 一定会填 result ⇒ 这是"读不出结果"，
        // 不能画成"下载成功"（暂时 ≠ 确定）。
        toast.error(describePrivacyError('unknown'));
      } else {
        const { path, truncated, notes } = res.result;
        // ⚠️ 截断必须让用户看见：只弹一句"成功"等于把"这份不是完整历史"藏起来。
        if (truncated) toast.warning(t('privacy.downloadSavedTruncated', { path }));
        else toast.success(t('privacy.downloadSaved', { path }));
        setDownloadResult({ truncated, notes: notes.join('；') });
      }
    } catch (error) {
      console.error('[privacy] download failed:', error);
      toast.error(describePrivacyError('unknown'));
    } finally {
      await refresh();
      setBusy(false);
    }
  }, [refresh, t]);

  const closeConfirm = useCallback(() => {
    setConfirmOpen(false);
    setAcknowledged(false);
    setTypedWord('');
  }, []);

  const submitDeletion = useCallback(async () => {
    closeConfirm();
    await run(() => window.clawwork.privacyRequestDeletion({ reason: t('privacy.deletionReason') }));
  }, [closeConfirm, run, t]);

  const exportStatus = state.export?.status ?? null;
  const deletion = state.deletion;
  const cooldownDays =
    deletion === null || ENDED_DELETION_STATUSES.includes(deletion.status) || deletion.status === 'unknown'
      ? null
      : cooldownDaysLeft(deletion.scheduledFor);

  /** 未知状态的显式分支：**不猜**，只说明读不出来 + 给一次刷新。 */
  function renderUnknown(scope: 'export' | 'deletion') {
    return (
      <div className="space-y-3">
        <p data-field={`${scope}-unknown`} className="type-body text-[var(--text-secondary)]">
          {t('privacy.statusUnknown')}
        </p>
        <Button variant="outline" data-action={`privacy-retry-${scope}`} disabled={busy} onClick={() => void refresh()}>
          {t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {loadError ? (
        <SectionCard>
          <p data-field="privacy-load-error" className="type-body text-[var(--danger)]" role="alert">
            {describePrivacyError(loadError)}
          </p>
          <Button
            className="mt-3"
            variant="outline"
            data-action="privacy-retry-state"
            disabled={busy}
            onClick={() => void refresh()}
          >
            {t('common.retry')}
          </Button>
        </SectionCard>
      ) : null}

      <SectionCard title={t('privacy.exportTitle')} subtitle={t('privacy.exportHint')}>
        {exportStatus === 'unknown' ? (
          renderUnknown('export')
        ) : exportStatus === 'ready' || exportStatus === 'completed' ? (
          <Button data-action="privacy-download" disabled={busy} onClick={() => void download()}>
            {t('privacy.downloadExport')}
          </Button>
        ) : (
          <div className="space-y-3">
            {exportStatus !== null && RUNNING_EXPORT_STATUSES.includes(exportStatus) ? (
              <p data-field="export-pending" className="type-body text-[var(--text-secondary)]">
                {t('privacy.exportPending')}
              </p>
            ) : null}
            <Button
              data-action="privacy-export"
              disabled={busy}
              onClick={() => void run(() => window.clawwork.privacyRequestExport())}
            >
              {t('privacy.requestExport')}
            </Button>
          </div>
        )}

        {downloadResult && (downloadResult.truncated || downloadResult.notes !== '') ? (
          <div className="mt-3 space-y-1">
            {downloadResult.truncated ? (
              <p data-field="export-truncated" className="type-support text-[var(--danger)]" role="alert">
                {t('privacy.downloadTruncatedHint')}
              </p>
            ) : null}
            {downloadResult.notes !== '' ? (
              <p data-field="export-notes" className="type-support text-[var(--text-muted)]">
                {t('privacy.downloadNotes', { notes: downloadResult.notes })}
              </p>
            ) : null}
          </div>
        ) : null}
      </SectionCard>

      <SectionCard title={t('privacy.deletionTitle')}>
        {deletion === null || ENDED_DELETION_STATUSES.includes(deletion.status) ? (
          <div className="space-y-3">
            <p className="type-body text-[var(--text-secondary)]">{t('privacy.deletionHint')}</p>
            <Button variant="danger" data-action="privacy-delete" disabled={busy} onClick={() => setConfirmOpen(true)}>
              {t('privacy.requestDeletion')}
            </Button>
          </div>
        ) : deletion.status === 'unknown' ? (
          renderUnknown('deletion')
        ) : (
          <div className="space-y-3">
            <p data-field="deletion-cooldown" className="type-body text-[var(--text-secondary)]">
              {cooldownDays === null
                ? t('privacy.cooldownUnknown')
                : cooldownDays > 0
                  ? t('privacy.cooldownLeft', { days: cooldownDays })
                  : t('privacy.deletionDue')}
            </p>
            {deletion.cancellable ? (
              <Button
                variant="outline"
                data-action="privacy-cancel"
                disabled={busy}
                onClick={() => void run(() => window.clawwork.privacyCancelDeletion({ id: deletion.id }))}
              >
                {t('privacy.cancelDeletion')}
              </Button>
            ) : null}
          </div>
        )}
      </SectionCard>

      <Dialog open={confirmOpen} onOpenChange={(next) => (next ? setConfirmOpen(true) : closeConfirm())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('privacy.deletionTitle')}</DialogTitle>
            <DialogDescription>{t('privacy.deletionConsequences')}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            <label className="flex cursor-pointer items-start gap-2 type-support text-[var(--text-secondary)]">
              <input
                type="checkbox"
                data-field="privacy-ack"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              {t('privacy.deletionAcknowledge')}
            </label>

            <div className="space-y-1">
              <label htmlFor="privacy-confirm-word" className="type-label block text-[var(--text-primary)]">
                {t('privacy.deletionTypeLabel', { word: t('privacy.deletionConfirmWord') })}
              </label>
              <input
                id="privacy-confirm-word"
                type="text"
                data-field="privacy-word"
                value={typedWord}
                onChange={(event) => setTypedWord(event.target.value)}
                placeholder={t('privacy.deletionConfirmWord')}
                aria-label={t('privacy.deletionTypeLabel', { word: t('privacy.deletionConfirmWord') })}
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-3.5 py-2 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)]"
              />
            </div>
          </div>

          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={closeConfirm} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              data-action="privacy-confirm-delete"
              disabled={!acknowledged || typedWord.trim() !== t('privacy.deletionConfirmWord') || busy}
              onClick={() => void submitDeletion()}
            >
              {t('privacy.confirmDeletion')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
