import { useCallback, useState } from 'react';
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
import Toggle from '../components/Toggle';
import { useTaskStore } from '@/platform';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  computerAccessApplied,
  normalizeComputerAccessTier,
  permissionModeForTier,
  rememberPermissionMode,
  sessionsToRevoke,
} from '@/lib/computer-access-runtime';
import { toast } from '@/lib/toast';
import type { ComputerAccessTier } from '@clawwork/core';

/**
 * 设置页「电脑操控权限」—— 用户点名要的那个**按钮**（2026-09-26）。
 *
 * 两档：
 *   · **默认安全**（默认）= 助手只在自己工作区里读写、跑命令要先问（= 0.0.35 的行为）；
 *   · **全权** = 助手能读写整台电脑上的文件、跑命令不再逐条询问。
 *
 * ⚠️ **打开必须过同意门**（用户原话就是"提示用户…表示同意我们 agent 操作电脑"）：
 *    勾选 + 确认两样都齐了才写。**关掉不设门** —— 收回权限再要一次同意是敌意设计。
 *
 * ⚠️ **顺序不能反**：先切会话（真权威）、成功了**才**落设置。反过来的话，切失败时
 *    设置里已经是 `'full'`、界面显示"已打开"，而实际没打开 —— 正是本项目反复栽的
 *    「界面在说谎」。有测试按名钉住（判据 6）。
 *
 * ⚠️ 这里写下去的只是**用户意愿**（`AppConfig.computerAccess`）+ 当前任务那一刀的
 *    会话模式；真正生效的是网关侧的会话权限模式，且切 `'full'` 在网关那边还要
 *    `operator.admin`。所以这个开关**没有**、也不该有"绕过网关照放"的能力。
 */
export default function ComputerAccessSection() {
  const { t } = useTranslation();
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [consentOpen, setConsentOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);

  // ⚠️ 读的是**设置**（用户意愿）。当前任务**实际**的档位在任务界面上的徽章里，
  //    读的是 `sessions.list` 回来的真值 —— 两者刻意分开，别在这里混。
  const tier = normalizeComputerAccessTier(settings?.computerAccess);

  const closeConsent = useCallback(() => {
    setConsentOpen(false);
    setAcknowledged(false);
  }, []);

  /**
   * 真正落地一次切换。回 `true` = 生效（调用方据此决定要不要收尾）。
   * ⚠️ 不抛：失败靠 toast 如实说，且**设置一个字节都不落**。
   */
  const applyTier = useCallback(
    async (next: ComputerAccessTier): Promise<boolean> => {
      const mode = permissionModeForTier(next);
      const { activeTaskId, tasks } = useTaskStore.getState();
      const active = tasks.find((task) => task.id === activeTaskId);

      if (active) {
        const res = await window.clawwork.patchSession(active.gatewayId, active.sessionKey, {
          permissionMode: mode,
        });
        if (!res?.ok) {
          toast.error(t('computerAccess.applyFailed', { reason: res?.error ?? '' }));
          return false;
        }
        // ⚠️ **成功了才记账**（与发送链同一条规矩：失败记账 = 下次不补 = 永久哑掉）。
        rememberPermissionMode(computerAccessApplied, active.sessionKey, mode, active.gatewayId);
      }

      /**
       * ⭐ 关掉全权时**收干净**（不只当前任务）。
       *
       * 补的缺口：在任务 A 开了全权、切到 B 关掉开关 —— A 还是全权。徽章会如实显示，
       * 但用户的理解是"我把这个功能关了"。
       *
       * ⚠️ 只收**我们设过的那些**（记账里有 `'full'` 的）：别的路径开的全权不归这个开关管。
       * ⚠️ **尽力而为**：某一个收不回来不该拦住其余和"落设置" —— 但那一条会**如实报错**，
       *    否则界面会显示"已关闭"而某个任务其实还开着。
       */
      if (next === 'safe') {
        // ⚠️ 网关从**记账里**取，不从任务列表反查 —— 任务可能已经被删/切走了，
        //    反查会在最需要收回的时候查不到。
        for (const sessionKey of sessionsToRevoke(computerAccessApplied, active?.sessionKey)) {
          const gatewayId = computerAccessApplied.get(sessionKey)?.gatewayId;
          if (!gatewayId) continue;
          const res = await window.clawwork.patchSession(gatewayId, sessionKey, { permissionMode: 'guarded' });
          if (res?.ok) {
            rememberPermissionMode(computerAccessApplied, sessionKey, 'guarded', gatewayId);
          } else {
            console.warn('[computerAccess] revoke failed:', sessionKey, res?.error);
          }
        }
      }

      const result = await updateSettings({ computerAccess: next });
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        toast.error(t('computerAccess.applyFailed', { reason: '' }));
        return false;
      }

      toast.success(
        active
          ? t(next === 'full' ? 'computerAccess.enabled' : 'computerAccess.disabled')
          : t(next === 'full' ? 'computerAccess.enabledNewOnly' : 'computerAccess.disabledNewOnly'),
      );
      return true;
    },
    [t, updateSettings],
  );

  const handleToggle = useCallback(
    async (nextOn: boolean) => {
      if (nextOn) {
        // 打开 ⇒ 先弹同意框，**一个字都不写**（有测试钉住）。
        setConsentOpen(true);
        return;
      }
      setBusy(true);
      try {
        await applyTier('safe');
      } finally {
        setBusy(false);
      }
    },
    [applyTier],
  );

  const confirmEnable = useCallback(async () => {
    setBusy(true);
    try {
      const ok = await applyTier('full');
      if (ok) closeConsent();
    } finally {
      setBusy(false);
    }
  }, [applyTier, closeConsent]);

  return (
    <div className="space-y-4">
      <SettingGroup title={t('computerAccess.title')} subtitle={t('computerAccess.subtitle')}>
        <div className="space-y-3 px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <p data-field="computer-access-state" className="type-label text-[var(--text-primary)]">
                {t(tier === 'full' ? 'computerAccess.stateOn' : 'computerAccess.stateOff')}
              </p>
              <p className="type-support text-[var(--text-secondary)]">
                {t(tier === 'full' ? 'computerAccess.fullHint' : 'computerAccess.safeHint')}
              </p>
            </div>
            <Toggle
              checked={tier === 'full'}
              disabled={busy}
              dataAction="computer-access-toggle"
              ariaLabel={t('computerAccess.toggleLabel')}
              onChange={(next) => void handleToggle(next)}
            />
          </div>
          <p data-field="computer-access-scope" className="type-support text-[var(--text-muted)]">
            {t('computerAccess.scopeNote')}
          </p>
        </div>
      </SettingGroup>

      <Dialog open={consentOpen} onOpenChange={(next) => (next ? setConsentOpen(true) : closeConsent())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('computerAccess.consentTitle')}</DialogTitle>
            <DialogDescription>{t('computerAccess.consentIntro')}</DialogDescription>
          </DialogHeader>

          <div className="mt-4 space-y-3">
            <ul className="list-disc space-y-1 pl-5 type-support text-[var(--text-secondary)]">
              <li data-field="computer-access-consent-1">{t('computerAccess.consentBullet1')}</li>
              <li data-field="computer-access-consent-2">{t('computerAccess.consentBullet2')}</li>
              <li data-field="computer-access-consent-3">{t('computerAccess.consentBullet3')}</li>
            </ul>

            <label className="flex cursor-pointer items-start gap-2 type-support text-[var(--text-secondary)]">
              <input
                type="checkbox"
                data-field="computer-access-ack"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--accent)]"
              />
              {t('computerAccess.consentAcknowledge')}
            </label>
          </div>

          <DialogFooter className="mt-6">
            <Button variant="outline" onClick={closeConsent} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button
              data-action="computer-access-confirm"
              disabled={!acknowledged || busy}
              onClick={() => void confirmEnable()}
            >
              {t('computerAccess.consentConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
