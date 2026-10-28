import { useCallback, useEffect, useRef, useState } from 'react';
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
import SettingGroup from '@/components/semantic/SettingGroup';
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
 * ⚠️ 删除申请的 `note` 由 **main 戳固定机器码**（`DELETION_REQUEST_NOTE`），这里**不发
 *    界面文案**：文案当数据发上去，用户换个语言审计口径就跟着漂。这里也不收集用户理由。
 */

const DAY_MS = 86_400_000;

/** 撤回 / 驳回 / 失败 = 这张单子不再有效，等同于"没有在跑的删除工单"。 */
const ENDED_DELETION_STATUSES = ['cancelled', 'rejected', 'failed'];

/** 导出还在准备中（服务端同步出快照，正常看不到这两个状态，但状态机允许）。 */
const RUNNING_EXPORT_STATUSES = ['pending', 'processing'];

/** 只有这两个状态有可下载的产物（设计 §5.3：ready / completed 可下载）。 */
const DOWNLOADABLE_EXPORT_STATUSES = ['ready', 'completed'];

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
 *   · 0 ⇒ 本地时钟算下来已到期（**注意：这不等于"服务端也说到期了"**，见冷却期那一处注释）
 *   · **null ⇒ 读不出绝对时刻**（缺失或 `Date.parse` → NaN）
 * ⚠️ 这个数**只用来显示"还剩几天"**，绝不拿它判断能不能撤回 —— 判据只有服务端的
 *    `cancellable`。否则客户端时间一偏，就会出现"冷却期已结束"和撤回按钮同时挂着。
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
  const [loading, setLoading] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [typedWord, setTypedWord] = useState('');
  const [downloadResult, setDownloadResult] = useState<{ truncated: boolean; notes: string } | null>(null);
  /** 单飞闸：一次只发一条 `privacy:state`（连点重试 / 双击都只发一次）。 */
  const refreshInFlight = useRef(false);

  // ⚠️ 这个函数**不抛**：它被 `run` / `download` 的 finally 调用，抛了就会把 busy 卡住。
  const loadState = useCallback(async () => {
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

  /**
   * 读一次状态。**单飞**：飞着的时候再点不会再发一条（连点 3 次 = 1 次请求）。
   * 丢掉并发那几次不会吞掉新数据：所有触发点（挂载 / 重试 / 动作后的刷新）都排在
   * 同一条 busy/loading 闸门后面 ⇒ 飞着的那条一定是最近发出去的。
   * ⚠️ 重试按钮的 busy 只挡 `loading`，**不挡 `loadError`** —— 否则读不到状态时
   *    连重试都点不动（正是现在这条路上的死循环）。
   */
  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setLoading(true);
    try {
      await loadState();
    } finally {
      refreshInFlight.current = false;
      setLoading(false);
    }
  }, [loadState]);

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
    // 上一份导出的说明从这一刻起就失效了（它讲的是**上一份**文件）。
    setDownloadResult(null);
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
        // ⚠️ `notes` 来自 IPC，**不能假定是数组**：`join` 一抛就会被同一段 catch 兜住，
        //    用户先看到"已保存"再看到"操作失败"（两句还互相矛盾）。照 main 同款过滤：
        //    非数组 ⇒ 空、逐元素只留字符串。分隔符也进 i18n（中文的「；」不该喂给别的语言）。
        setDownloadResult({
          truncated,
          notes: Array.isArray(notes)
            ? notes.filter((note) => typeof note === 'string').join(t('privacy.notesSeparator'))
            : '',
        });
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
    // 不带任何界面文案：审计口径（固定机器码）由 main 戳上去，界面文案当数据发 = 语言一变口径就变。
    await run(() => window.clawwork.privacyRequestDeletion({}));
  }, [closeConfirm, run]);

  const exportStatus = state.export?.status ?? null;
  const deletion = state.deletion;
  // 说明只对"当前这份还能下载的导出"有效：换了单子（重新申请 / 失败 / 撤回）就不再适用。
  const exportDownloadable = exportStatus !== null && DOWNLOADABLE_EXPORT_STATUSES.includes(exportStatus);
  const cooldownDays =
    deletion === null || ENDED_DELETION_STATUSES.includes(deletion.status) || deletion.status === 'unknown'
      ? null
      : cooldownDaysLeft(deletion.scheduledFor);

  /**
   * 读不到状态（或正有一次读在飞）时，**一切依赖状态的入口都停掉**：手里那份 state 可能
   * 是上一次的陈旧快照，"申请导出/下载/申请删除/撤回"都可能对着错的前提点下去（删除还会
   * 开二次确认弹层，一路点到不可逆的提交）。理由写在错误卡里，用户知道为什么点不动。
   * ⚠️ 重试按钮**不受这条约束**（它是出口，不是入口）。
   */
  const actionsBlocked = loadError !== null || loading;

  /** 未知状态的显式分支：**不猜**，只说明读不出来 + 给一次刷新。 */
  function renderUnknown(scope: 'export' | 'deletion') {
    return (
      <div className="space-y-3">
        <p data-field={`${scope}-unknown`} className="type-body text-[var(--text-secondary)]">
          {t('privacy.statusUnknown')}
        </p>
        <Button
          variant="outline"
          data-action={`privacy-retry-${scope}`}
          disabled={busy || loading}
          onClick={() => void refresh()}
        >
          {loading ? t('privacy.retrying') : t('common.retry')}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {loadError ? (
        <SettingGroup>
          <div className="px-5 py-4">
            <p data-field="privacy-load-error" className="type-body text-[var(--danger)]" role="alert">
              {describePrivacyError(loadError)}
            </p>
            <p data-field="privacy-actions-blocked" className="mt-1 type-support text-[var(--text-muted)]">
              {t('privacy.actionsBlocked')}
            </p>
            <Button
              className="mt-3"
              variant="outline"
              data-action="privacy-retry-state"
              disabled={busy || loading}
              onClick={() => void refresh()}
            >
              {loading ? t('privacy.retrying') : t('common.retry')}
            </Button>
          </div>
        </SettingGroup>
      ) : null}

      <SettingGroup title={t('privacy.exportTitle')} subtitle={t('privacy.exportHint')}>
        <div className="space-y-3 px-5 py-4">
          {exportStatus === 'unknown' ? (
            renderUnknown('export')
          ) : exportDownloadable ? (
            <Button data-action="privacy-download" disabled={busy || actionsBlocked} onClick={() => void download()}>
              {t('privacy.downloadExport')}
            </Button>
          ) : (
            <>
              {exportStatus !== null && RUNNING_EXPORT_STATUSES.includes(exportStatus) ? (
                <p data-field="export-pending" className="type-body text-[var(--text-secondary)]">
                  {t('privacy.exportPending')}
                </p>
              ) : null}
              <Button
                data-action="privacy-export"
                disabled={busy || actionsBlocked}
                onClick={() => void run(() => window.clawwork.privacyRequestExport())}
              >
                {t('privacy.requestExport')}
              </Button>
            </>
          )}

          {downloadResult && exportDownloadable && (downloadResult.truncated || downloadResult.notes !== '') ? (
            <div className="space-y-1">
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
        </div>
      </SettingGroup>

      <SettingGroup title={t('privacy.deletionTitle')}>
        <div className="space-y-3 px-5 py-4">
          {deletion === null || ENDED_DELETION_STATUSES.includes(deletion.status) ? (
            <>
              <p className="type-body text-[var(--text-secondary)]">{t('privacy.deletionHint')}</p>
              <Button
                variant="danger"
                data-action="privacy-delete"
                disabled={busy || actionsBlocked}
                onClick={() => setConfirmOpen(true)}
              >
                {t('privacy.requestDeletion')}
              </Button>
            </>
          ) : deletion.status === 'unknown' ? (
            renderUnknown('deletion')
          ) : (
            <>
              {/* ⚠️ 文案与撤回按钮**同源**：唯一判据是服务端的 `cancellable`
                  （`privacy_my_state()` 的 `status = 'pending' and now() < scheduled_for`）。
                  本地时钟算出的天数只用来显示"还剩几天"：天数为 0 而服务端仍说可撤回 =
                  两边时钟不一致 ⇒ 说"读不出可信的剩余时间"，**绝不说成"冷却期已结束"**
                  —— 否则就会出现"已结束"和撤回按钮同时挂着这种自相矛盾的界面。 */}
              <p data-field="deletion-cooldown" className="type-body text-[var(--text-secondary)]">
                {!deletion.cancellable
                  ? t('privacy.deletionDue')
                  : cooldownDays !== null && cooldownDays > 0
                    ? t('privacy.cooldownLeft', { days: cooldownDays })
                    : t('privacy.cooldownUnknown')}
              </p>
              {deletion.cancellable ? (
                <Button
                  variant="outline"
                  data-action="privacy-cancel"
                  disabled={busy || actionsBlocked}
                  onClick={() => void run(() => window.clawwork.privacyCancelDeletion({ id: deletion.id }))}
                >
                  {t('privacy.cancelDeletion')}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </SettingGroup>

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
              // ⚠️ 大小写不敏感：en/de/es/fr/pt 的确认词是**大写**（DELETE / LÖSCHEN / …），
              //    用户照着提示敲小写也得算数 —— 否则按钮一直灰着，界面还不解释为什么。
              disabled={
                !acknowledged ||
                typedWord.trim().toLowerCase() !== t('privacy.deletionConfirmWord').toLowerCase() ||
                busy
              }
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
