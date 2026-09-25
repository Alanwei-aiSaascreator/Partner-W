import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, FolderOpen, KeyRound, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { PRESET_AGENT_DEFINITIONS } from '@/lib/preset-agents';
import {
  gatewayFailureText,
  relayFailureText,
  startupBlockerText,
  type StartupReadiness,
} from '@/lib/startup-readiness';
import { formatElapsed } from '@/lib/waiting-copy';
import { useUiStore } from '@/stores/uiStore';

type Translate = (key: string, values?: Record<string, unknown>) => string;

function currentStatus(readiness: StartupReadiness, t: Translate): string {
  // ⚠️ 已知的中转失败**排在最前面**：它比目录那条推断更具体，也是唯一带出口的一条。
  if (readiness.relayFailure) return relayFailureText(readiness.relayFailure, t);
  if (readiness.ai.phase === 'starting') return t('startupReadiness.aiStarting');
  if (readiness.ai.phase === 'loading-models') return t('startupReadiness.aiLoadingModels');
  // 取不到 ≠ 没有模型：这句得说"没能取到"，否则用户会以为自己的账号/网关真的没模型。
  if (readiness.ai.phase === 'catalog-failed') return t('startupReadiness.aiCatalogFailed');
  // ⭐ 网关**说得出是哪一类**时用它那句（C2）：它比"暂时没有可用模型"具体得多，
  //    而且四类各自指向不同的下一步。说不清（`unknown`）时它会返回 null，落到通用那句。
  const gatewayFailure = gatewayFailureText(readiness, t);
  if (gatewayFailure) return gatewayFailure;
  if (readiness.ai.phase === 'error') return t('startupReadiness.aiError');

  const assistants = readiness.assistants;
  if (assistants.phase === 'waiting') return t('startupReadiness.assistantsWaiting');
  if (assistants.phase === 'verifying') return t('startupReadiness.assistantsVerifying');
  // ⭐ 助手失败 + 已知硬障碍（文件系统不支持 / 工作区不可写）⇒ 说那句**能行动**的话。
  //    它比"助手失败：某某某"具体，而且是重试不会变的那一类（出口是换盘/换目录）。
  const blocker = startupBlockerText(readiness.assistantBlocker ?? null, t);
  if (blocker) return blocker;
  if (assistants.phase === 'installing') {
    const definition = PRESET_AGENT_DEFINITIONS.find((item) => item.id === assistants.currentId);
    return t('startupReadiness.assistantsInstalling', {
      name: definition ? t(definition.displayNameKey) : '',
    });
  }
  if (assistants.phase === 'error') {
    const names = assistants.missingIds
      .map((id) => PRESET_AGENT_DEFINITIONS.find((item) => item.id === id))
      .filter((definition): definition is (typeof PRESET_AGENT_DEFINITIONS)[number] => Boolean(definition))
      .map((definition) => t(definition.displayNameKey))
      .join(', ');
    return t('startupReadiness.assistantsError', { names });
  }
  return t('startupReadiness.aiReady');
}

export default function StartupReadinessPanel({
  readiness,
  onRetry,
}: {
  readiness: StartupReadiness;
  onRetry: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const setSettingsSection = useUiStore((s) => s.setSettingsSection);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const [takingLonger, setTakingLonger] = useState(false);
  const relayFailure = readiness.relayFailure;
  const completed = Math.min(readiness.assistants.completed, readiness.assistants.total);
  const hasAssistantProgress = readiness.ai.phase === 'ready' && readiness.assistants.total > 0;
  // ⭐ 2026-09-20（T-a28 实机）：助手没就绪时，**原因**一直躺在 `assistants.error` 里
  // （`preset-agent-bootstrap` 在"抛错"和"全部失败"两种情况下填的 missingIds 都是全部 6 个
  // ⇒ 光看「0 / 6」分不出是哪种），而这个面板从没渲染过它。原文不翻译：它是证据。
  const assistantError = readiness.assistants.phase === 'error' ? readiness.assistants.error : undefined;
  const progressPercent = hasAssistantProgress ? (completed / readiness.assistants.total) * 100 : 0;
  const status = readiness.hasError ? 'error' : readiness.isReady ? 'ready' : 'active';
  /**
   * ⚠️ 顺序：**已知的结论优先于"等太久了"**（原来是反的）。
   *    原来的三元链把 `takingLonger` 放在最前面 ⇒ 90 秒之后连"这张卡绑在别的组织"
   *    都会被替换成"准备时间比平时更久"，而那个结论**再等也不会变**：
   *    用户被劝着继续等一件永远不会发生的事（2026-09-21 第二台机器实机）。
   */
  const statusText = readiness.hasError
    ? currentStatus(readiness, t)
    : takingLonger
      ? t('startupReadiness.takingLonger')
      : currentStatus(readiness, t);
  /**
   * ⚠️ 不确定的**脉冲**进度条只许在"确实还在准备"时出现 —— 它承诺的是"还在动"。
   *    已经出结论（失败）时没有进度可承诺：静态那条也不画，什么都不说比画一个假装在走的条诚实。
   *    （有真实助手进度时照旧画真实百分比：那是事实，不是承诺。）
   */
  const showProgress = hasAssistantProgress || !readiness.hasError;
  // 出口只有两种，而且互斥：确定性失败去激活，不确定的失败才给"重新准备"。
  // ⚠️ 名额已满（`activation-limit-reached`）**例外：不给按钮**。复核实测激活页今天既没有
  //    设备列表也没有解绑入口 ⇒ "去激活"对它是近似死路，留一个按了没用的按钮比没有按钮更坏。
  //    它的出路（换一张卡 / 找客服）由那句文案说清楚。
  const action = relayFailure
    ? relayFailure.kind === 'retryable'
      ? 'retry'
      : relayFailure.kind === 'activation-limit-reached'
        ? null
        : 'activation'
    : // ⭐ 已知的文件系统障碍：出口是**换工作区**（设置 → 系统），不是"重新准备"。
      //    那块盘上再点一百次"重新准备"还是六个助手全失败 —— 给一个按了有用的按钮。
      readiness.assistantBlocker
      ? 'workspace'
      : readiness.hasError || takingLonger
        ? 'retry'
        : null;
  const openActivationSettings = useCallback(() => {
    setSettingsSection('activation');
    setSettingsOpen(true);
  }, [setSettingsSection, setSettingsOpen]);
  const openSystemSettings = useCallback(() => {
    setSettingsSection('system');
    setSettingsOpen(true);
  }, [setSettingsSection, setSettingsOpen]);

  useEffect(() => {
    if (readiness.conversationReady) return;
    const timer = window.setTimeout(() => setTakingLonger(true), 90_000);
    return () => window.clearTimeout(timer);
  }, [readiness.conversationReady]);

  /**
   * ⭐ 那个"一直在走的秒数"。
   *
   * ⚠️ 为什么必须有：用户骂"卡住"多半不是因为真的卡住，而是因为**看不出它是否还在动** ——
   *    一句不动的文案配一条脉冲的进度条，等待与假死在观感上没有区别
   *    （2026-09-25 真日志：六分钟里这块面板**一个字都没变**）。
   *    聊天活动条早就用了同一个手法（`waiting-copy.ts` 头注释），这里接的是同一条推理。
   * ⚠️ **只在"还在准备"时报时**：已经有结论（失败 / 就绪）时秒数只是噪音，
   *    而且会让人以为"再等等也许就好了"——那正是这一整轮要消灭的形状。
   * ⚠️ 它量的是**这块面板从出现到现在**（不是"从进程启动"）：渲染层拿不到更早的时间戳，
   *    把话说成从开机算起就是编。两者相差通常只有几秒。
   */
  const showElapsed = !readiness.hasError && !readiness.conversationReady;

  /**
   * ⭐ 「这不是安装」——**只对盘上运行成立**的那句说明。
   *
   * 为什么要在这里说：U 盘版首次启动会把运行环境准备到**本机缓存**（约 2–3 分钟，设计如此，
   * 为的是拔盘后还能继续用），那个进度界面**看起来就是在装软件** —— 实测有同事因此反馈
   * "双击 exe 装到电脑"。而这句话以前只活在一个**没人渲染**的整屏里
   * （[[tests-keep-dead-code-alive]]），用户一个字都看不到。
   *
   * ⚠️ 两个条件，各自独立的理由 —— 别再把它们抄成一个：
   *    ① **盘上运行**才说：装机版**确实**写进系统、**确实**出现在「程序和功能」里，
   *       对它说这句就是假话。
   *    ② **准备还没结束**才说：准备结束了就没什么可解释的。
   *       ⚠️ 注意这里**不含"失败"** —— 早先一版把它挂在"还在准备"（`showElapsed`）上，
   *       而那个条件的理由是"结论出来之后秒数只是噪音"，跟这句话**不是同一个理由**。
   *       照抄的结果是：**恰恰在用户最怀疑"我是不是装了什么东西把电脑搞坏了"的时候
   *       （启动失败），这句话不见了** —— 而它在那时为真、也正是用户需要的那句。
   */
  const [portable, setPortable] = useState(false);
  useEffect(() => {
    // ⚠️ **可选调用**（`?.`）：这个方法比有些宿主新，缺了不许把整块面板带崩
    //    —— 这一版刚写出来时就是硬调，几十条老用例当场全红。
    // ⚠️ 问不出来一律当**不是**盘上运行：宁可少说一句，也不许对装机版说这句假话。
    void Promise.resolve(window.clawwork?.isPortableWorkspace?.())
      .then((value) => setPortable(value === true))
      .catch(() => setPortable(false));
  }, []);
  const showNotAnInstall = portable && !readiness.isReady;
  /**
   * 「请保持应用开启，无需重复操作。」
   *
   * ⚠️ 这句是从那个**没人渲染的整屏**里搬过来的（`layouts/StartupReadiness` 已删除）——
   *    它是那个组件里四条文案**唯一**还有出口没说、值得留下的一条：等待那 2–3 分钟里
   *    用户会做的两件事恰好是"把窗口关掉"和"再点一次重新准备"。
   * ⚠️ 只在**还在准备**时说：已经失败时"保持开启"没有意义（这时该看的是原因和出口）。
   */
  const showKeepOpen = showElapsed;
  const [now, setNow] = useState(() => Date.now());
  const startedAtRef = useRef(now);
  useEffect(() => {
    if (!showElapsed) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [showElapsed]);
  const elapsedMs = Math.max(0, now - startedAtRef.current);

  return (
    <section
      aria-live="polite"
      aria-busy={!readiness.isReady && !readiness.hasError}
      className="mx-auto mt-3 w-full max-w-[var(--content-max-width)] rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] px-4 py-3"
    >
      <div className="flex items-center gap-3">
        <span
          className={
            status === 'error'
              ? 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--danger-bg)] text-[var(--danger)]'
              : 'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-dim)] text-[var(--accent)]'
          }
        >
          {status === 'error' ? (
            <TriangleAlert size={16} aria-hidden="true" />
          ) : status === 'ready' ? (
            <CheckCircle2 size={16} aria-hidden="true" />
          ) : (
            <LoaderCircle size={16} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="type-label truncate text-[var(--text-primary)]">{statusText}</h2>
            {showElapsed && (
              <span
                className="type-mono-data shrink-0 text-[var(--text-muted)]"
                data-testid="readiness-elapsed"
                // ⚠️ 不设 `aria-live`：每秒变一次的数字会被读屏器念成噪音。
                //    状态文案那句（外面那个 `aria-live="polite"` 的 section）才是给耳朵的。
                aria-hidden="true"
              >
                {t('startupReadiness.elapsed', { time: formatElapsed(elapsedMs) })}
              </span>
            )}
            {hasAssistantProgress && (
              <span className="type-mono-data shrink-0 text-[var(--text-muted)]">
                {t('startupReadiness.progress', { completed, total: readiness.assistants.total })}
              </span>
            )}
          </div>
          {showProgress && (
            <div
              role="progressbar"
              aria-label={t('startupReadiness.overallProgress')}
              aria-valuemin={hasAssistantProgress ? 0 : undefined}
              aria-valuemax={hasAssistantProgress ? readiness.assistants.total : undefined}
              aria-valuenow={hasAssistantProgress ? completed : undefined}
              className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--bg-tertiary)]"
            >
              <div
                className={
                  hasAssistantProgress
                    ? 'h-full rounded-full bg-[var(--accent)] transition-[width] duration-200 motion-reduce:transition-none'
                    : 'h-full w-1/3 rounded-full bg-[var(--accent)] animate-pulse motion-reduce:animate-none'
                }
                style={hasAssistantProgress ? { width: `${progressPercent}%` } : undefined}
              />
            </div>
          )}
          {assistantError && (
            <p className="type-meta mt-1.5 break-words text-[var(--text-danger)]" data-testid="readiness-reason">
              {assistantError}
            </p>
          )}
          {showNotAnInstall && (
            <p className="type-meta mt-1.5 text-[var(--text-muted)]" data-testid="not-an-install">
              {t('startupReadiness.notAnInstall')}
            </p>
          )}
          {showKeepOpen && (
            <p className="type-meta mt-1.5 text-[var(--text-muted)]" data-testid="keep-open">
              {t('startupReadiness.keepOpen')}
            </p>
          )}
        </div>
        {action === 'retry' ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry} className="shrink-0">
            <RefreshCw size={14} />
            {t('startupReadiness.retry')}
          </Button>
        ) : action === 'activation' ? (
          // ⚠️ 确定性失败**不给重试按钮**：那个按钮按下去只会让用户再做一次无用功。
          //    给的是"去哪儿能解决"——设置里那一页（`setSettingsSection('activation')`）。
          <Button type="button" variant="outline" size="sm" onClick={openActivationSettings} className="shrink-0">
            <KeyRound size={14} />
            {t('startupReadiness.openActivation')}
          </Button>
        ) : action === 'workspace' ? (
          // 同上：文件系统不支持 / 工作区不可写，都是"换个地方"才好的事。
          <Button type="button" variant="outline" size="sm" onClick={openSystemSettings} className="shrink-0">
            <FolderOpen size={14} />
            {t('startupReadiness.openWorkspaceSettings')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}
