import { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { AlertCircle, ArrowRight, CheckCircle2, KeyRound, Loader2 } from 'lucide-react';
import logo from '@/assets/logo.png';
import OpeningMedia from '@/components/OpeningMedia';
import WorkspaceRecreatedNotice from '@/components/WorkspaceRecreatedNotice';
import ActivationSection from '@/layouts/Settings/sections/ActivationSection';
import { Button } from '@/components/ui/button';
import { useEntryDeployProgress } from '@/hooks/useEntryDeployProgress';
import {
  deriveEntryPreparation,
  type EntryPreparationFacts,
  type EntryPreparationStage,
} from '@/lib/entry-preparation';
import { gatewayFailureText, startupFailureText } from '@/lib/startup-readiness';
import { formatElapsed } from '@/lib/waiting-copy';
import { motionDuration, motionEase } from '@/styles/design-tokens';

/**
 * 部署阶段那句话（`RuntimeDeployProgress.phase` → 文案键）。
 *
 * ⚠️ 用**显式映射表**而不是拼字符串（`` `entryPreparation.deploy${x}` ``）：
 *    拼接出来的键在 i18n 的两个门禁里都看不见（"用了没写"/"写了没用"两个方向都瞎）。
 */
const DEPLOY_PHASE_KEYS = {
  verify: 'entryPreparation.deployVerify',
  extract: 'entryPreparation.deployExtract',
  node: 'entryPreparation.deployNode',
  finalize: 'entryPreparation.deployFinalize',
  stalled: 'entryPreparation.deployStalled',
} as const;
export interface EntryPreparationProps {
  facts: EntryPreparationFacts;
  onContinue: () => Promise<void>;
  onRetry: () => Promise<void>;
  onChangeAccount: () => Promise<void>;
  onChooseWorkspace: () => void;
}
const stages: EntryPreparationStage[] = ['account', 'runtime', 'relay', 'models', 'workspace', 'assistants'];
export default function EntryPreparation({
  facts,
  onContinue,
  onRetry,
  onChangeAccount,
  onChooseWorkspace,
}: EntryPreparationProps) {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const state = deriveEntryPreparation(facts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  /**
   * ⭐ U2（2026-10 基线审查）：确定性 relay 拒绝（去激活 / 组织不符 / 资格被拒）的出口是
   *    **去激活/换卡** —— 与工作台 `StartupReadinessPanel` 同一套策略。那个「重新准备」
   *    按钮对确定性失败按下去只是让用户再做一次无用功（hook 对非 retryable 直接不发请求）。
   *    `activation-limit-reached`（名额已满）也不给按钮：出路是换卡/找客服，由文案说清。
   */
  const relayFailure = facts.startup.relayFailure;
  const needsActivation = Boolean(
    relayFailure && relayFailure.kind !== 'retryable' && relayFailure.kind !== 'activation-limit-reached',
  );
  const [showActivation, setShowActivation] = useState(false);
  /**
   * 本机运行时**部署**的真实进度（主进程报来）。
   *
   * ⭐ 为什么值得上屏（2026-10-07 体检）：首跑那 1–20 分钟里主进程其实一直知道
   *    自己在干什么（校验两份文件 → 解压四万条 → 装 Node → 原子换入），但那条信号
   *    到不了界面 —— 用户看到的是"17% 不动"的一格。这里把它接出来。
   */
  const progress = useEntryDeployProgress(facts.currentScopeKey);
  /**
   * 盘上运行才说的那句"这不是安装"。问不出来一律当**不是**（宁可少说一句，
   * 也不许对装机版说假话）—— 同 `StartupReadinessPanel` 的判据。
   */
  const [portable, setPortable] = useState(false);
  useEffect(() => {
    // ⚠️ **可选调用**（`?.`）：这个方法比有些宿主新，缺了不许把整块屏带崩。
    void Promise.resolve(window.clawwork?.isPortableWorkspace?.())
      .then((value) => setPortable(value === true))
      .catch(() => setPortable(false));
  }, []);
  /** 部署那条线的 1 秒心跳（只喂"已等多久"那一格；没有进度就不跳）。 */
  const [progressNow, setProgressNow] = useState<number | null>(null);
  // 开场片：用户点击"继续"后暂停+淡出（随 key={preparationScope} 重挂自动复位）。
  const [stopRequested, setStopRequested] = useState(false);
  // 就绪瞬间的一次性高亮（约 1.2s 回落）；只做视觉，不参与任何放行判定。
  const [highlightReady, setHighlightReady] = useState(false);
  const wasReady = useRef(false);
  useEffect(() => {
    if (state.canContinue && !wasReady.current) {
      wasReady.current = true;
      if (reduceMotion) return;
      setHighlightReady(true);
      const timer = window.setTimeout(() => setHighlightReady(false), 1200);
      return () => window.clearTimeout(timer);
    }
    if (!state.canContinue) wasReady.current = false;
    return undefined;
  }, [state.canContinue, reduceMotion]);
  const locked = useRef(false);
  const actionAttempt = useRef(0);
  const active = useRef(true);
  const currentScope = useRef(facts.currentScopeKey);
  currentScope.current = facts.currentScopeKey;
  useEffect(() => {
    actionAttempt.current += 1;
    locked.current = false;
    setBusy(false);
    setError(false);
  }, [facts.currentScopeKey]);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const run = async (action: () => Promise<void>) => {
    if (locked.current) return;
    /**
     * R2（2026-10-10 集中终审 §4 合同 6）：入口先核存活 —— 卸载后的迟到回调
     * （如旧实例的"激活成功→重跑准备"）不许再发起任何新操作。
     * 只在 catch/finally 里检查已经太晚：action 本身已经被调用了。
     */
    if (!active.current) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    const scope = facts.currentScopeKey;
    const attempt = ++actionAttempt.current;
    try {
      await action();
    } catch {
      if (active.current && currentScope.current === scope && actionAttempt.current === attempt) setError(true);
    } finally {
      if (actionAttempt.current === attempt) locked.current = false;
      if (active.current && currentScope.current === scope && actionAttempt.current === attempt) setBusy(false);
    }
  };
  const runtimeBlocked = state.stage === 'runtime' && facts.runtime?.ok === false;
  const runtimeFailure =
    runtimeBlocked && facts.runtime?.ok === false
      ? facts.runtime.reason === 'process-exited'
        ? t('entryPreparation.runtimeProcessExited')
        : facts.runtime.reason === 'ready-timeout'
          ? t('entryPreparation.runtimeReadyTimeout')
          : gatewayFailureText(
              { ...facts.startup, ai: { ...facts.startup.ai, failureReason: facts.runtime.reason } },
              t,
            )
      : null;
  const failure = runtimeBlocked
    ? (runtimeFailure ?? t('entryPreparation.checkFailed'))
    : error
      ? t('entryPreparation.recheckFailed')
      : state.hasError
        ? (startupFailureText(facts.startup, t) ?? t('entryPreparation.checkFailed'))
        : null;
  const currentIndex = stages.indexOf(state.stage);
  // 真实进度 = 已通过的检查项数（只按事实走，绝不"预估假进度"——与老板参照系一致）。
  const completedCount = state.canContinue ? stages.length : Math.max(0, currentIndex);
  /**
   * 部署那条线什么时候可见：**还卡在 runtime 这一格、且没有失败结论**。
   *
   * ⚠️ 出结论（成功/失败）之后它必须消失：留着一条不再变化的百分比 = 又造了一个
   *    "看不出是否还在动"的东西（那正是这一整轮要消灭的形状）。
   */
  const deployActive = state.stage === 'runtime' && !failure && !state.canContinue;
  // 依赖用 `startedAt`（而不是整个快照）：每条部署事件都会换一个对象，
  // 挂整个对象等于每 250ms 重建一次定时器。抽出原始值进 effect 与依赖表，
  // 既满足 exhaustive-deps、又不改变这个"按原始值依赖"的意图。
  const deployStartedAt = progress?.startedAt;
  useEffect(() => {
    if (!deployActive || deployStartedAt === undefined) return;
    setProgressNow(Date.now());
    const timer = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [deployActive, deployStartedAt]);
  // 只有解压那一段量得出来（done/total 是条目数）；校验/装 Node/换入都是定性阶段。
  const deployPercent =
    progress && progress.phase === 'extract' && progress.total > 0
      ? Math.floor((progress.done / progress.total) * 100)
      : null;
  const deployElapsedMs = progress && progressNow !== null ? Math.max(0, progressNow - progress.startedAt) : null;
  return (
    <div className="relative min-h-screen overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
      {/* 全屏媒体层（王者荣耀登录页式：视频铺满，内容压底）。
          ⚠️ U4（2026-10 基线审查）：这一层**不能**整体 aria-hidden —— 它里面住着
          OpeningMedia 的**声音开关**（交互控件；aria-hidden 子树里的可聚焦按钮对
          屏幕阅读器与键盘用户都是非法路径）。装饰性由各成员自己标注：
          视频 `aria-hidden="true"`、吉祥物 `aria-hidden={videoVisible}`。 */}
      <motion.div
        data-entry-animation
        className="absolute inset-0"
        animate={reduceMotion || state.canContinue || state.hasError ? { y: 0 } : { y: [0, -8, 0] }}
        transition={{
          duration: motionDuration.ambient * 6,
          ease: motionEase.gentle,
          repeat: reduceMotion || state.canContinue || state.hasError ? 0 : Infinity,
        }}
      >
        <OpeningMedia stopRequested={stopRequested} failed={state.hasError} reduceMotion={reduceMotion === true} />
      </motion.div>
      <div className="relative z-10 flex min-h-screen flex-col overflow-y-auto">
        <header className="p-5">
          <div className="glass-scrim inline-flex items-center gap-3 rounded-full px-4 py-2">
            <img src={logo} alt="" className="h-7 w-7" />
            <span className="type-title">{t('common.appName')}</span>
          </div>
        </header>
        <main className="mt-auto w-full px-5 pb-4" aria-busy={!state.canContinue && !state.hasError}>
          <div className="mx-auto flex w-full max-w-xl flex-col items-stretch gap-2.5">
            {/* 失败时才展开；就绪/进行中折叠为 sr-only（无障碍播报保留、视觉极简——王者加载页形态） */}
            <section className={`glass-scrim space-y-2 rounded-xl p-4 ${failure ? '' : 'sr-only'}`}>
              <h1 className="type-title">
                {t(
                  state.canContinue
                    ? 'entryPreparation.ready'
                    : state.hasError
                      ? 'entryPreparation.needsAttention'
                      : 'entryPreparation.title',
                )}
              </h1>
              <p className="type-body text-[var(--text-secondary)]">
                {t(state.canContinue ? 'entryPreparation.readyDetail' : 'entryPreparation.detail')}
              </p>
              <div
                role={failure ? 'alert' : 'status'}
                aria-live="polite"
                className={failure ? 'type-body text-[var(--danger)]' : 'type-support text-[var(--text-secondary)]'}
              >
                {failure ?? (state.canContinue ? t('entryPreparation.checked') : null)}
                {runtimeBlocked && <p className="mt-2">{t('entryPreparation.runtimeRetryHint')}</p>}
              </div>
            </section>
            <motion.div
              data-entry-continue-pop
              initial={false}
              animate={
                reduceMotion
                  ? { opacity: state.canContinue ? 1 : 0.85 }
                  : state.canContinue
                    ? { opacity: 1, scale: 1 }
                    : { opacity: 0.85, scale: 0.96 }
              }
              transition={{ duration: motionDuration.moderate, ease: motionEase.enter }}
              className={`mx-auto w-full max-w-sm ${state.canContinue ? '' : 'sr-only'} ${highlightReady ? 'glow-selected rounded-lg' : ''}`}
            >
              <Button
                data-entry-continue
                className="brand-action h-12 w-full"
                disabled={!state.canContinue || busy}
                onClick={() => {
                  if (deriveEntryPreparation(facts).canContinue) {
                    setStopRequested(true);
                    void run(onContinue);
                  }
                }}
              >
                {busy ? (
                  <Loader2 size={16} className="animate-spin motion-reduce:animate-none" />
                ) : (
                  <>
                    {t('entryPreparation.continue')}
                    <ArrowRight size={16} />
                  </>
                )}
              </Button>
            </motion.div>
            <WorkspaceRecreatedNotice />
            {/* 底部小进度条（常驻、贴近底边）：滚动状态 + 真实进度 + 百分比 */}
            <section
              className="glass-scrim-strong mx-auto w-full max-w-2xl space-y-2 rounded-2xl px-5 py-3.5"
              title={t('entryPreparation.animationNote')}
            >
              <div className="flex items-center justify-between gap-3 type-meta text-[var(--text-secondary)]">
                <span className="flex min-w-0 items-center gap-1.5">
                  {state.canContinue ? (
                    <CheckCircle2 size={13} className="shrink-0 text-[var(--accent)]" />
                  ) : state.hasError ? (
                    // ⭐ BUG-064（合同 #4）：**终态失败停止等待动画** —— 已出结论（失败）时
                    //    还在转圈就是在承诺"再等等会好"（现场"卡 17%"那一格的观感）。
                    //    换成静态警示图标；失败原因与下一步在上方卡片里说。
                    <AlertCircle size={13} className="shrink-0 text-[var(--danger)]" />
                  ) : (
                    <Loader2
                      size={13}
                      className={reduceMotion ? 'shrink-0' : 'shrink-0 animate-spin motion-reduce:animate-none'}
                    />
                  )}
                  <span className="truncate">
                    {state.canContinue ? t('entryPreparation.checked') : t(`entryPreparation.${state.stage}`)}
                  </span>
                </span>
                <span className="type-mono-data shrink-0 tabular-nums text-[var(--text-muted)]">
                  {Math.round((completedCount / stages.length) * 100)}%
                </span>
              </div>
              {/* 第二行：**部署**在干什么（真实阶段 + 真实百分比 + 已等多久）。
                  ⭐ 这一行就是"1–20 分钟黑箱"的出口：主进程一直知道自己在哪一步，
                  以前那条信号到不了这里（2026-10-07 体检问题 1/2）。 */}
              {deployActive && progress && (
                <div
                  data-entry-deploy-progress
                  className="flex items-center justify-between gap-3 type-meta text-[var(--text-muted)]"
                  aria-live="polite"
                >
                  <span className="truncate">{t(DEPLOY_PHASE_KEYS[progress.phase])}</span>
                  <span className="type-mono-data shrink-0 tabular-nums">
                    {deployPercent !== null && `${deployPercent}%`}
                    {deployPercent !== null && deployElapsedMs !== null && ' · '}
                    {deployElapsedMs !== null &&
                      t('startupReadiness.elapsed', { time: formatElapsed(deployElapsedMs) })}
                  </span>
                </div>
              )}
              <div
                role="progressbar"
                aria-label={t('entryPreparation.checks')}
                aria-valuemin={0}
                aria-valuemax={stages.length}
                aria-valuenow={completedCount}
                className="h-1 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
              >
                <div
                  className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-300 motion-reduce:transition-none"
                  style={{ width: `${(completedCount / stages.length) * 100}%` }}
                />
              </div>
              {/* 等待期间的两句人话（key 早就在 9 个语言里，只是原来挂在**到不了的屏**上）：
                  ① 别把窗口关掉（关掉就看不到准备了）；② 盘上运行时说明这不是"装到电脑"。 */}
              {deployActive && (
                <p className="type-meta text-[var(--text-secondary)]">{t('startupReadiness.keepOpen')}</p>
              )}
              {deployActive && portable && (
                <p data-entry-not-an-install className="type-meta text-[var(--text-secondary)]">
                  {t('startupReadiness.notAnInstall')}
                </p>
              )}
            </section>
            {showActivation && (
              <section data-entry-activation-panel className="glass-scrim rounded-xl p-4 text-left">
                <ActivationSection
                  // R2（§4）：把**已核账号 scope**传下去 —— 切号/卸载后，表单里
                  // 迟到的激活/刷新结果一律按这个 scope 作废（不许串到新账号）。
                  accountScope={facts.accountUserId}
                  onActivated={() => {
                    setShowActivation(false);
                    void run(onRetry);
                  }}
                />
              </section>
            )}
            <div className="flex flex-wrap justify-center gap-1">
              {/* ⭐ 运行端起不来时这个按钮**必须留着**（2026-10-07 体检问题 4）：
                  它现在由 IPC `runtime:bootstrap-retry` 真的重跑一轮 bootstrap ——
                  不再是"重新初始化连接层"那种按了没用的按钮，也不再要求用户完全退出重开。
                  ⚠️ U2（2026-10）：确定性 relay 拒绝时**不给它**（按了只会做无用功）——
                  那一档的出口是「去激活/换卡」，与工作台面板同一套策略。 */}
              {!needsActivation && (
                <Button data-entry-retry variant="ghost" disabled={busy} onClick={() => void run(onRetry)}>
                  {t('startupReadiness.retry')}
                </Button>
              )}
              {needsActivation && (
                <Button
                  data-entry-activation
                  variant="ghost"
                  disabled={busy}
                  onClick={() => setShowActivation((value) => !value)}
                >
                  <KeyRound size={14} />
                  {t('startupReadiness.openActivation')}
                </Button>
              )}
              <Button data-entry-workspace variant="ghost" disabled={busy} onClick={onChooseWorkspace}>
                {t('entryPreparation.chooseWorkspace')}
              </Button>
              <Button data-entry-account variant="ghost" disabled={busy} onClick={() => void run(onChangeAccount)}>
                {t('login.changeAccount')}
              </Button>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
