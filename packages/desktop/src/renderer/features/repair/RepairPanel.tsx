import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, FolderOpen, Loader2, RefreshCw, ShieldAlert, Undo2, Wrench } from 'lucide-react';
import type {
  RepairAction,
  RepairApplyResult,
  RepairBootstrap,
  RepairItemReport,
  RepairMessage,
  RepairRestoreReason,
  RepairRestoreResult,
  RepairScanReport,
  RepairSeverity,
} from '@clawwork/shared';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import StatusTag from '@/components/semantic/StatusTag';
import InlineNotice from '@/components/semantic/InlineNotice';
import EmptyState from '@/components/semantic/EmptyState';
import LoadingBlock from '@/components/semantic/LoadingBlock';
import type { StatusKind } from '@/lib/ui-contract';

/**
 * 诊断与修复面板（FEAT-03）—— **两条入口共用同一个组件**：
 * `--repair` 独立窗口（`repair/main.tsx`）与「设置 → 诊断与修复」（`RepairSection`）。
 *
 * 三条界面纪律，与引擎那三条一一对应：
 * 1. **先看后点**：面板默认只是"全检"结果；所有写动作都在可勾选列表里，
 *    每一条都写着"要改哪个文件"，不勾就不执行。
 * 2. **不谎报**：修不了的进"需要你处理"（blocked），不适用的进"这里用不上"（skipped），
 *    两者都不算"没问题"。
 * 3. **主进程不上屏人话**：引擎回的是机器码，这一层按 `settings.repair.code.` 前缀
 *    用模板字符串拼出具体键，出九语言句子；参数只有路径/计数/版本号。
 *    ⚠️ 这里**不要**把带引号的完整键调用写进注释：`scripts/check-i18n.mjs` 的字面量
 *    扫描器认不出注释，会把注释里的键当成代码引用，于是把一个根本不存在的键
 *    （曾经就是 `<code>` 这个占位符本身）报成"代码引用了但词表没有"。
 */

const SEVERITY_TONE: Record<RepairSeverity, StatusKind> = {
  ok: 'success',
  attention: 'warning',
  broken: 'error',
  blocked: 'error',
};

const SEVERITY_KEY: Record<RepairSeverity, string> = {
  ok: 'ok',
  attention: 'attention',
  broken: 'broken',
  blocked: 'blocked',
};

function actionKey(action: RepairAction): string {
  return action.actionId;
}

/** 还原结果的机器码 → 界面句子（未知码一律按"没还原成"说，不谎报成功）。 */
const RESTORE_KEYS: Record<RepairRestoreReason, string> = {
  restored: 'restored',
  partial: 'partial',
  nothing: 'nothing',
  'no-index': 'nothing',
  'blocked-live-instance': 'blocked-live-instance',
};

export default function RepairPanel() {
  const { t } = useTranslation();
  const [bootstrap, setBootstrap] = useState<RepairBootstrap | null>(null);
  const [report, setReport] = useState<RepairScanReport | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [result, setResult] = useState<RepairApplyResult | null>(null);
  const [scanning, setScanning] = useState(false);
  const [applying, setApplying] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [restored, setRestored] = useState<RepairRestoreResult | { ok: false } | null>(null);
  const [restoring, setRestoring] = useState(false);

  const message = useCallback(
    (item: RepairMessage): string => t(`settings.repair.code.${item.code}`, item.params ?? {}),
    [t],
  );

  const runScan = useCallback(async () => {
    setScanning(true);
    setFailure(null);
    try {
      const next = await window.clawwork.repairScan();
      setReport(next);
      setResult(null);
      setRestored(null);
      // 默认**不勾**：SPEC 三·4 要求"默认不勾"，而所有动作都要人先看一眼
      setSelected(new Set<string>());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setScanning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const info = await window.clawwork.repairBootstrap();
        if (cancelled) return;
        setBootstrap(info);
        if (info.language)
          await import('@/i18n').then((module) => module.default.changeLanguage(info.language as string));
        await runScan();
      } catch (error) {
        if (!cancelled) setFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runScan]);

  const toggle = useCallback((id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const applySelected = useCallback(async () => {
    if (selected.size === 0) return;
    setApplying(true);
    setFailure(null);
    try {
      const applied = await window.clawwork.repairApply({ actionIds: [...selected] });
      setResult(applied);
      setRestored(null);
      await runScan();
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setApplying(false);
    }
  }, [selected, runScan]);

  /** 还原刚刚那一轮（`apply` 回的备份目录）—— "点了才发现改错了"的后悔药。 */
  const restoreRound = useCallback(async (backupDir: string) => {
    setRestoring(true);
    setFailure(null);
    try {
      setRestored(await window.clawwork.repairRestore(backupDir));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setRestoring(false);
    }
  }, []);

  if (!report) {
    return (
      <div className="space-y-3">
        {failure ? (
          <InlineNotice tone="error">{t('settings.repair.scanFailed', { error: failure })}</InlineNotice>
        ) : null}
        <LoadingBlock label={t('settings.repair.scanning')} />
      </div>
    );
  }

  const actions = report.items.flatMap((item) => item.actions);
  const durableActions = actions.filter((action) => action.backup);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          onClick={() => void runScan()}
          disabled={scanning || applying}
          className="titlebar-no-drag gap-1.5"
        >
          {scanning ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {t('settings.repair.rescan')}
        </Button>
        <Button
          onClick={() => void applySelected()}
          disabled={applying || selected.size === 0 || report.liveInstance !== null}
          className="titlebar-no-drag gap-1.5"
        >
          {applying ? <Loader2 size={14} className="animate-spin" /> : <Wrench size={14} />}
          {t('settings.repair.applySelected', { count: selected.size })}
        </Button>
        {bootstrap ? (
          <span className="type-support text-[var(--text-muted)]">
            {t('settings.repair.scannedRoots', { count: bootstrap.scannedRoots.length })}
          </span>
        ) : null}
      </div>

      {report.liveInstance ? <InlineNotice tone="warning">{message(report.liveInstance)}</InlineNotice> : null}
      {failure ? <InlineNotice tone="error">{t('settings.repair.scanFailed', { error: failure })}</InlineNotice> : null}

      {result ? (
        <div className="space-y-1.5 rounded-lg border border-[var(--border-subtle)] px-4 py-3">
          <div className="type-label text-[var(--text-primary)]">{t('settings.repair.resultTitle')}</div>
          {result.outcomes.map((outcome) => (
            <div key={outcome.actionId} className="type-support text-[var(--text-secondary)]">
              {message(outcome.message)}
            </div>
          ))}
          {result.backupDir ? (
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                className="glow-focus type-support inline-flex items-center gap-1.5 text-[var(--accent)]"
                onClick={() => void window.clawwork.repairReveal(result.backupDir as string)}
              >
                <FolderOpen size={14} />
                {t('settings.repair.openBackup', { path: result.backupDir })}
              </button>
              <button
                type="button"
                className="glow-focus type-support inline-flex items-center gap-1.5 text-[var(--accent)]"
                disabled={restoring || report.liveInstance !== null}
                onClick={() => void restoreRound(result.backupDir as string)}
              >
                {restoring ? <Loader2 size={14} className="animate-spin" /> : <Undo2 size={14} />}
                {t('settings.repair.restoreBackup')}
              </button>
            </div>
          ) : (
            <div className="type-support text-[var(--text-muted)]">{t('settings.repair.noChanges')}</div>
          )}
          {restored ? (
            <div className="type-support text-[var(--text-secondary)]">
              {t(`settings.repair.restore.${'reason' in restored ? RESTORE_KEYS[restored.reason] : 'nothing'}`, {
                count: 'restored' in restored ? restored.restored : 0,
                total: 'total' in restored ? restored.total : 0,
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      {durableActions.length > 0 ? null : (
        <EmptyState
          icon={<CheckCircle2 size={22} className="text-[var(--accent)]" />}
          title={t('settings.repair.nothingTitle')}
          description={t('settings.repair.nothingDesc')}
        />
      )}

      <div className="space-y-3">
        {report.items.map((item) => (
          <ItemBlock
            key={item.id}
            item={item}
            selected={selected}
            onToggle={toggle}
            message={message}
            disabled={report.liveInstance !== null}
          />
        ))}
      </div>

      <div className="type-support flex items-start gap-2 text-[var(--text-muted)]">
        <ShieldAlert size={14} className="mt-0.5 shrink-0" />
        {t('settings.repair.offlineNote')}
      </div>
    </div>
  );
}

function ItemBlock({
  item,
  selected,
  onToggle,
  message,
  disabled,
}: {
  item: RepairItemReport;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  message: (item: RepairMessage) => string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`repair-item-${item.id}`}
      data-severity={item.severity}
      className="space-y-2 rounded-xl border border-[var(--border-subtle)] px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="type-label text-[var(--text-primary)]">{t(`settings.repair.item.${item.id}`)}</span>
        <StatusTag tone={SEVERITY_TONE[item.severity]}>
          {t(`settings.repair.severity.${SEVERITY_KEY[item.severity]}`)}
        </StatusTag>
      </div>

      <ul className="space-y-1">
        {item.findings.map((finding, index) => (
          <li key={`${finding.code}-${index}`} className="type-support text-[var(--text-secondary)]">
            {message(finding)}
          </li>
        ))}
      </ul>

      {item.actions.length > 0 ? (
        <div className="space-y-1.5">
          {item.actions.map((action) => (
            <label
              key={actionKey(action)}
              className={cn(
                'glow-focus flex cursor-pointer items-start gap-2 rounded-lg px-2.5 py-1.5',
                'bg-[var(--bg-tertiary)]',
                disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
              )}
            >
              <input
                type="checkbox"
                className="mt-0.5"
                checked={selected.has(action.actionId)}
                disabled={disabled}
                onChange={() => onToggle(action.actionId)}
              />
              <span className="min-w-0 flex-1">
                <span className="type-support block text-[var(--text-primary)]">{message(action)}</span>
                {action.targets.length > 0 ? (
                  <span className="type-mono-data mt-0.5 block text-[var(--text-muted)]">
                    {action.targets.join('\n')}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      {item.blocked.length > 0 ? (
        <div className="space-y-1">
          <div className="type-badge text-[var(--warning)]">{t('settings.repair.needsYou')}</div>
          {item.blocked.map((entry, index) => (
            <div key={`${entry.code}-${index}`} className="type-support text-[var(--text-secondary)]">
              {message(entry)}
            </div>
          ))}
        </div>
      ) : null}

      {item.skipped.length > 0 ? (
        <div className="space-y-1">
          <div className="type-badge text-[var(--text-muted)]">{t('settings.repair.notApplicable')}</div>
          {item.skipped.map((entry, index) => (
            <div key={`${entry.code}-${index}`} className="type-support text-[var(--text-muted)]">
              {message(entry)}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
