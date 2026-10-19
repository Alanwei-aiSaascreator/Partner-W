import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Pencil, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { MemoryEntry } from '@clawwork/core';
import type { MemoryMutation, MemoryMutationAction, MemorySnapshot } from '@/lib/memory-client';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import SettingGroup from '@/components/semantic/SettingGroup';
import SettingRow from '@/components/semantic/SettingRow';
import { useUiStore } from '@/stores/uiStore';

/**
 * **记忆二期：长期记忆的确认轨道。**
 *
 * 这一页做的是记忆系统里"**整盘一套、用户点头才生效**"那一条链：
 *
 * ```
 * 用户显式写 / 助手提草案 → 库（真源，随盘） → 用户确认 → MEMORY.md 受管区块 → 助手每轮读到
 * ```
 *
 * ## 为什么"草案"与"已保存"必须分两栏、且草案不许显示成已记
 *
 * 产品口径是一期就定死的：**助手只提草案，用户点头才落盘**（`docs/superpowers/plans/
 * 2026-09-24-p3-plans-web-search-image-video-memory.md` §3）。如果草案和已保存混在一列，
 * 用户会以为"它已经记住了" —— 那正是"未确认不上屏"这条纪律要挡的假象。
 * 所以：草案永远只在**待确认**那一栏出现，且**只有点了确认**才会进 `MEMORY.md`。
 *
 * ## 为什么写进 MEMORY.md 才算数
 *
 * 库只是真源，助手真正读到的是运行时每轮全文注入的 `MEMORY.md`。`main` 每次改动后
 * 都会把**当前账号**的已确认集合投影过去并**回读**；这一页把回读失败如实报出来，
 * 不让"界面多了一条"冒充"助手读得到"。
 */
export default function MemoryEntriesSection() {
  const { t } = useTranslation();
  const gatewayId = useUiStore((s) => s.defaultGatewayId);

  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [newText, setNewText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  /** 上一次投影里**没写成**的助手数（0 = 全部写成；null = 没发生过投影）。 */
  const [syncFailures, setSyncFailures] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = (await window.clawwork.memoryList()) as MemorySnapshot;
      setSnapshot(result);
    } catch {
      setSnapshot({ ok: false, reason: 'unavailable' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // 本页打开时补一次投影：换账号 / 换盘之后，`MEMORY.md` 里可能是上一账号那批。
    void window.clawwork.memorySync({ gatewayId: gatewayId ?? undefined }).catch(() => {});
    const unsubscribe = window.clawwork.onMemoryChanged(() => {
      void refresh();
    });
    return unsubscribe;
  }, [refresh, gatewayId]);

  const entries = useMemo(() => snapshot?.entries ?? [], [snapshot]);
  const pending = useMemo(() => snapshot?.pending ?? [], [snapshot]);

  const failureCopy = useCallback(
    (reason: string | undefined, limit?: number): string => {
      switch (reason) {
        case 'empty':
          return t('settings.memoryErrorEmpty');
        case 'over-limit':
          return t('settings.memoryErrorOverLimit', { max: limit ?? 0 });
        case 'control-characters':
          return t('settings.memoryErrorControlCharacters');
        case 'block-over-limit':
          return t('settings.memoryErrorBlockFull');
        case 'entry-count-limit':
          return t('settings.memoryErrorCountFull');
        case 'duplicate':
          return t('settings.memoryErrorDuplicate');
        case 'not-found':
          return t('settings.memoryErrorNotFound');
        default:
          return t('settings.memoryErrorUnavailable');
      }
    },
    [t],
  );

  /**
   * 一次改动之后统一处理回执：失败如实报；**部分助手没写成**也要说清（不报"全部成功"）；
   * **没投影**（网关没连 / 没有 gatewayId）更**不许**报成功。
   *
   * ⚠️ 为什么"没投影"不能算成功（2026-10-16 修）：库是真源，但助手真正读到的是
   *    `MEMORY.md`。删除时若网关没连，`syncAfterMutation` 返回 `skipped`，而从前这里
   *    只在 `status === 'synced'` 时读失败数 ⇒ `skipped` 落进 `else` 分支
   *    **弹"已删除"** —— 可磁盘上那份 `MEMORY.md` 里还留着正文，助手下一轮照样读到它。
   *    那正是本项目禁止的"表面成功"（完成语义红线：不伪造成功）。现在 skipped 走
   *    **警告**并按产品话说清"改动已记下、但还没同步"，不再冒充成功。
   */
  const settle = useCallback(
    (result: MemoryMutation, successKey: string) => {
      if (!result.ok) {
        toast.error(failureCopy(result.reason, result.limit));
        return false;
      }
      const sync = result.sync;
      const failed = sync?.status === 'synced' ? (sync.failed?.length ?? 0) : null;
      setSyncFailures(failed);
      if (failed && failed > 0) {
        toast.error(t('settings.memorySyncPartial', { failed }));
      } else if (sync?.status === 'skipped') {
        // 改动进了库，但**没有**到达助手当前读的那份文件 —— 如实说成"还没同步"。
        toast.warning(t('settings.memorySyncPending'));
      } else {
        toast.success(t(successKey));
      }
      return true;
    },
    [failureCopy, t],
  );

  /**
   * 执行一次改动，返回"**真的成功了**吗"。
   *
   * ⚠️ 返回值是给调用方清输入框/退出编辑态用的：**失败时不许清** ——
   *    清了就等于把用户刚打的字据丢掉（他会以为"没保存上，也找不回内容"）。
   */
  const run = useCallback(
    async (action: MemoryMutationAction, successKey: string): Promise<boolean> => {
      setBusy(true);
      try {
        const result = await action();
        if (!settle(result, successKey)) return false;
        await refresh();
        return true;
      } catch {
        toast.error(t('settings.memoryErrorUnavailable'));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [refresh, settle, t],
  );

  const handleAdd = useCallback(() => {
    const text = newText.trim();
    if (text.length === 0) return;
    void run(
      () => window.clawwork.memoryCreate({ text, gatewayId: gatewayId ?? undefined }),
      'settings.memoryAdded',
    ).then((saved) => {
      // ⚠️ 只有真存下才清输入框 —— 失败时把用户打的字原样留着
      if (saved) setNewText('');
    });
  }, [gatewayId, newText, run]);

  const handleDelete = useCallback(
    (entry: MemoryEntry) => {
      void run(
        () => window.clawwork.memoryDelete({ id: entry.id, gatewayId: gatewayId ?? undefined }),
        'settings.memoryDeleted',
      );
    },
    [gatewayId, run],
  );

  const handleConfirm = useCallback(
    (entry: MemoryEntry, edited?: string) => {
      void run(
        () =>
          window.clawwork.memoryConfirmDraft({
            id: entry.id,
            text: edited,
            gatewayId: gatewayId ?? undefined,
          }),
        'settings.memoryConfirmed',
      ).then((confirmed) => {
        // 改的正文没存上就别退出编辑态（否则用户改的那版**看不见也找不回**）
        if (!confirmed) return;
        setEditingId(null);
        setEditingText('');
      });
    },
    [gatewayId, run],
  );

  const handleReject = useCallback(
    (entry: MemoryEntry) => {
      void run(
        () => window.clawwork.memoryRejectDraft({ id: entry.id, gatewayId: gatewayId ?? undefined }),
        'settings.memoryRejected',
      );
    },
    [gatewayId, run],
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 size={18} className="animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  if (!snapshot?.ok) {
    return (
      <SettingGroup>
        <SettingRow label={t('settings.memoryEntries')} description={t('settings.memoryEntriesHint')}>
          <span className="type-support text-[var(--danger)]" data-testid="memory-entries-error">
            {failureCopy(snapshot?.reason)}
          </span>
        </SettingRow>
      </SettingGroup>
    );
  }

  return (
    <div className="space-y-6">
      {/* ── 待确认草案（助手提的那条轨道） ───────────────────────────── */}
      <div>
        <SettingGroup>
          <SettingRow label={t('settings.memoryDrafts')} description={t('settings.memoryDraftsHint')}>
            <span className="type-mono-data text-[var(--text-muted)]" data-testid="memory-draft-count">
              {t('settings.memoryDraftCount', { count: pending.length })}
            </span>
          </SettingRow>
        </SettingGroup>
        {pending.length === 0 ? (
          <p className="type-meta mt-2 text-[var(--text-muted)]" data-testid="memory-drafts-empty">
            {t('settings.memoryDraftsEmpty')}
          </p>
        ) : (
          <ul className="mt-2 space-y-3" data-testid="memory-draft-list">
            {pending.map((draft) => (
              <li
                key={draft.id}
                className="rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3"
                data-testid="memory-draft-item"
              >
                {editingId === draft.id ? (
                  <textarea
                    value={editingText}
                    onChange={(e) => setEditingText(e.target.value)}
                    rows={3}
                    aria-label={t('settings.memoryDraftEdit')}
                    className="glow-focus type-body w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-[var(--text-primary)]"
                  />
                ) : (
                  <p className="type-body text-[var(--text-primary)]" data-testid="memory-draft-text">
                    {draft.text}
                  </p>
                )}
                <p className="type-meta mt-1 text-[var(--text-muted)]">{t('settings.memoryDraftSourceAssistant')}</p>
                <div className="mt-2 flex items-center gap-2">
                  {editingId === draft.id ? (
                    <>
                      <Button
                        variant="default"
                        size="sm"
                        disabled={busy}
                        onClick={() => handleConfirm(draft, editingText)}
                        data-testid="memory-draft-save-edit"
                      >
                        {t('settings.memoryDraftSaveEdit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          setEditingId(null);
                          setEditingText('');
                        }}
                        data-testid="memory-draft-cancel-edit"
                      >
                        {t('settings.memoryDraftCancelEdit')}
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        variant="default"
                        size="sm"
                        disabled={busy}
                        onClick={() => handleConfirm(draft)}
                        data-testid="memory-draft-confirm"
                      >
                        <Check size={14} />
                        {t('settings.memoryDraftConfirm')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          setEditingId(draft.id);
                          setEditingText(draft.text);
                        }}
                        aria-label={t('settings.memoryDraftEdit')}
                        data-testid="memory-draft-edit"
                      >
                        <Pencil size={14} />
                        {t('settings.memoryDraftEdit')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={busy}
                        onClick={() => handleReject(draft)}
                        data-testid="memory-draft-reject"
                      >
                        <X size={14} />
                        {t('settings.memoryDraftReject')}
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="type-meta mt-2 text-[var(--text-muted)]" data-testid="memory-reject-note">
          {t('settings.memoryRejectNote')}
        </p>
      </div>

      {/* ── 已保存（只有它们会被助手读到） ───────────────────────────── */}
      <div>
        <SettingGroup>
          <SettingRow label={t('settings.memoryEntries')} description={t('settings.memoryEntriesHint')}>
            <span className="type-mono-data text-[var(--text-muted)]" data-testid="memory-entry-count">
              {t('settings.memoryEntryCount', { count: entries.length })}
            </span>
          </SettingRow>
        </SettingGroup>

        {syncFailures !== null && syncFailures > 0 && (
          <p className="type-support mt-2 text-[var(--danger)]" data-testid="memory-sync-partial">
            {t('settings.memorySyncPartial', { failed: syncFailures })}
          </p>
        )}

        {entries.length === 0 ? (
          <p className="type-meta mt-2 text-[var(--text-muted)]" data-testid="memory-entries-empty">
            {t('settings.memoryEntriesEmpty')}
          </p>
        ) : (
          <ul className="mt-2 space-y-2" data-testid="memory-entry-list">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-3"
                data-testid="memory-entry-item"
              >
                <span className="type-body text-[var(--text-primary)]">{entry.text}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => handleDelete(entry)}
                  aria-label={t('settings.memoryDelete')}
                  data-testid="memory-entry-delete"
                >
                  <Trash2 size={14} />
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex items-start gap-2">
          <textarea
            value={newText}
            onChange={(e) => setNewText(e.target.value)}
            rows={2}
            aria-label={t('settings.memoryAdd')}
            placeholder={t('settings.memoryAddPlaceholder')}
            className="glow-focus type-body w-full resize-y rounded-lg border border-[var(--border)] bg-[var(--bg-primary)] p-2 text-[var(--text-primary)]"
            data-testid="memory-add-input"
          />
          <Button
            variant="default"
            size="sm"
            disabled={busy || newText.trim().length === 0}
            onClick={handleAdd}
            data-testid="memory-add"
          >
            {t('settings.memoryAdd')}
          </Button>
        </div>
        {/* 如实说明记忆存在**这块盘**上、按账号分开 —— 用户要知道换台电脑插同一块盘还在。 */}
        <p className="type-meta mt-2 text-[var(--text-muted)]">{t('settings.memoryStoredOnDisk')}</p>
      </div>
    </div>
  );
}
