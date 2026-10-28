import { useState, useCallback, useEffect, useRef } from 'react';
import { KeyRound, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { Button } from '@/components/ui/button';
import SettingGroup from '@/components/semantic/SettingGroup';
import InlineNotice from '@/components/semantic/InlineNotice';
import { useCommercialStore } from '@/stores/commercialStore';
import { createEntryLicenseGate, EntryLicenseError } from '@/lib/entry-license-gate';

import { activationErrorKey } from '@/lib/activation-errors';
export { activationErrorKey } from '@/lib/activation-errors';

export interface ActivationSectionProps {
  /** 激活/换卡成功后的回调（首启准备页用它重跑一轮准备；设置页不传）。 */
  onActivated?: () => void;
  /**
   * U2/R2（2026-10-10 集中终审 §4）：当前账号 scope（准备页传 `facts.accountUserId`，
   * 可为 null；设置页缺省取 store 里的登录身份）。它只作**作废判据**（scope 变化/卸载后
   * 不再落任何后续副作用），不做激活前置拦截 —— 表单在拿不到 scope 的宿主里也必须能工作。
   */
  accountScope?: string | null;
}

export default function ActivationSection({ onActivated, accountScope }: ActivationSectionProps = {}) {
  const { t } = useTranslation();
  const overview = useCommercialStore((s) => s.overview);
  const storeUserId = overview?.account?.userId ?? '';
  const load = useCommercialStore((s) => s.load);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorKey, setErrorKey] = useState('');
  /**
   * 已绑定状态下要不要摊开输入框。
   *
   * ⚠️ 「已绑定」**不是**死路：这是全 App 唯一的激活入口（登录页、引导页都没有），
   *    以前这里一 `return` 就把输入框整个删掉，于是"卡绑在别人组织上/想换一张"
   *    的用户**无处可输**。现在提示照留，但旁边永远有一条换卡的路。
   */
  const [showReplace, setShowReplace] = useState(false);
  /**
   * U2/R2（§4 合同 3/4）：显式换卡复用 entry-license-gate 的 pending / confirm /
   * 单飞纪律，走 `intent='replace'` —— 旧卡有效也**直接换新卡**（ensure 那条
   * "已有有效许可就早退"的语义会让换卡变成假动作，所以绝不能直接接 ensure）。
   * gate 实例随组件挂载存活：未知结果的 pending 在同一次表单会话内跨多次 Enter 保留。
   */
  const [gate] = useState(createEntryLicenseGate);
  const scope = accountScope ?? storeUserId;
  const scopeRef = useRef(scope);
  const aliveRef = useRef(true);
  const attemptRef = useRef(0);
  /**
   * R2（§4 合同 1）：单飞用 **ref**，不能只靠 busy state —— 同一帧内连按两次 Enter 时
   * state 还没生效，第二次会穿透并发起第二个激活 IPC。
   */
  const inFlightRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (scopeRef.current === scope) return;
    // 账号 scope 变化（切号/换准备上下文）⇒ 作废在途尝试的后续副作用，不留旧 scope 的 busy。
    scopeRef.current = scope;
    attemptRef.current += 1;
    inFlightRef.current = false;
    setBusy(false);
    setErrorKey('');
  }, [scope]);

  const licence = overview?.license ?? null;

  const submit = useCallback(async () => {
    const trimmed = key.trim();
    if (!trimmed || inFlightRef.current) return;
    inFlightRef.current = true;
    const attempt = ++attemptRef.current;
    const scopeAtStart = scopeRef.current;
    /**
     * R2（§4 合同 5）：每个 await 之后、任何 toast/清输入/load/report/回调之前，
     * 都核对 存活 + 账号 scope + attempt；任一不符 ⇒ 当场作废（不落任何副作用）。
     */
    const isCurrent = (): boolean =>
      aliveRef.current && attemptRef.current === attempt && scopeRef.current === scopeAtStart;
    setBusy(true);
    setErrorKey('');
    try {
      // §4 合同 2/3：未知结果的 pending 由 gate 记录 —— 下一次 Enter（同卡或换输入）
      // 先走 commercialLicenseRecoverActivation，**未确认前不再 redeem**。
      await gate.ensure({
        userId: scopeAtStart,
        activationKey: trimmed,
        api: window.clawwork,
        isCurrent,
        intent: 'replace',
      });
      if (!isCurrent()) return;
      // §4 合同 8：本地"激活已发生"的事实**先落定** —— 后续辅助刷新/统计的失败
      // 不得把它改写成"激活未发生"，更不得因此触发再一次 redeem。
      toast.success(t('activation.success'));
      setKey('');
      setShowReplace(false);
      try {
        await load(isCurrent);
      } catch {
        // store.load 内部已兜底（不抛）；这里防御未来改动 —— 辅助刷新失败 ≠ 激活失败。
      }
      if (!isCurrent()) return;
      try {
        await window.clawwork.commercialUsageReport();
      } catch {
        // 同上：辅助统计失败不改激活事实（它的提示走 store 的 offline 状态，不是激活错误）。
      }
      if (!isCurrent()) return;
      onActivated?.();
    } catch (failure) {
      // 卸载/切号后的迟到结果：静默作废，不落任何副作用。
      if (!isCurrent()) return;
      setErrorKey(failure instanceof EntryLicenseError ? activationErrorKey(failure.code) : 'activation.errorGeneric');
    } finally {
      inFlightRef.current = false;
      if (isCurrent()) setBusy(false);
    }
  }, [key, gate, load, onActivated, t]);

  const inputClass =
    'w-full rounded-lg border border-[var(--border)] bg-[var(--bg-input)] px-4 py-2.5 type-body text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none transition-colors focus:border-[var(--accent)] disabled:opacity-60';

  if (licence?.activated && !showReplace) {
    return (
      <div className="space-y-5">
        <h3 className="type-section-title text-[var(--text-primary)]">{t('settings.activation')}</h3>
        <SettingGroup title={t('activation.bound')}>
          <div className="space-y-3 px-5 py-4">
            <InlineNotice tone="info">{t('activation.boundDesc', { sku: licence.sku ?? '-' })}</InlineNotice>
            {/* ⚠️ 这条不能删：没有它，已绑定的用户就**没有任何地方**能再输一次卡。 */}
            <Button variant="outline" onClick={() => setShowReplace(true)} className="gap-1.5">
              <KeyRound size={14} />
              {t('activation.replaceCard')}
            </Button>
          </div>
        </SettingGroup>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h3 className="type-section-title text-[var(--text-primary)]">{t('settings.activation')}</h3>

      <SettingGroup title={t('activation.title')} subtitle={t('activation.subtitle')}>
        <div className="space-y-3 px-5 py-4">
          {/* 从「已绑定」摊开输入框时，别让当前绑的是哪张卡消失。 */}
          {licence?.activated ? (
            <InlineNotice tone="info">{t('activation.boundDesc', { sku: licence.sku ?? '-' })}</InlineNotice>
          ) : null}
          <input
            className={inputClass}
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
            placeholder={t('activation.placeholder')}
            disabled={busy}
            aria-label={t('activation.placeholder')}
          />
          {errorKey ? (
            <p className="type-support text-[var(--danger)]" role="alert">
              {t(errorKey)}
            </p>
          ) : null}
          <Button onClick={() => void submit()} disabled={busy || !key.trim()} className="gap-1.5">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}
            {t('activation.submit')}
          </Button>
        </div>
      </SettingGroup>
    </div>
  );
}
