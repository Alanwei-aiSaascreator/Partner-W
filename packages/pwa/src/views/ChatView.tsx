import { useRef, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Message } from '@clawwork/shared';
import type { ActiveTurn } from '@clawwork/core';
import { EMPTY_MESSAGES } from '@clawwork/core';
import { Virtuoso } from 'react-virtuoso';
import { useTaskStore, useMessageStore, useUiStore } from '../stores/hooks';
import { ChatMessage } from '../components/ChatMessage';
import { StreamingMessage } from '../components/StreamingMessage';
import { ChatInput } from '../components/ChatInput';
import { QuestionPanel } from '../components/QuestionPanel';
import { TurnActivity } from '../components/TurnActivity';
import { sessionSync } from '../stores/index.js';
import { formatCredits, useSpendStore } from '../stores/spend';
import { gatewayToken, mobileFetch } from '../lib/remote-api';
import { WelcomeHero } from './WelcomeHero';
import { LoadingTip } from '../components/LoadingTip';
import { ensureHydrationReady } from '../stores';

const VIRTUALIZATION_THRESHOLD = 100;

interface TailContext {
  activeTurn: ActiveTurn | undefined;
  processing: boolean;
  gatewayStatus: string | undefined;
  taskId?: string;
  sessionKey?: string;
  t: (key: string, options?: Record<string, string>) => string;
}

function ChatTail({ context }: { context?: TailContext }) {
  const turnMicros = useSpendStore((s) => (context?.sessionKey ? s.turnMicros[context.sessionKey] : undefined));
  const taskMicros = useSpendStore((s) => (context?.taskId ? s.taskMicros[context.taskId] : undefined));
  if (!context) return null;
  const { activeTurn, processing, gatewayStatus, t } = context;
  return (
    <>
      {/*
        ⚠️ 条件里必须带上"思考"：模型先思考再出正文，纯思考阶段 `streamingText` 还是空串，
        原来这里直接不渲染 —— 真机表现就是"手机上看不到深度思考过程"，而电脑端有。
      */}
      {activeTurn &&
        (activeTurn.streamingText ||
          activeTurn.streamingThinking ||
          activeTurn.thinkingContent ||
          activeTurn.toolCalls.length > 0) && <StreamingMessage turn={activeTurn} />}
      {processing && !activeTurn && (
        <div className="flex items-center gap-2 py-3" role="status">
          <div
            className="h-2 w-2 animate-pulse rounded-full"
            style={{ backgroundColor: 'var(--accent)' }}
            aria-hidden="true"
          />
          <LoadingTip className="type-support" style={{ color: 'var(--text-muted)' }} />
        </div>
      )}
      {gatewayStatus === 'connecting' && (
        <p className="px-3 py-3 type-support" style={{ color: 'var(--text-muted)' }}>
          {t('chat.authorizationPending')}
        </p>
      )}
      {/* 本轮 / 累计消耗（与桌面端同一口径：余额差分，不估） */}
      {!processing && (turnMicros || taskMicros) && (
        <div className="px-1 pb-3 pt-1 text-center">
          {turnMicros ? (
            <p className="type-support" style={{ color: 'var(--text-muted)' }}>
              {t('chat.turnSpend', { credits: formatCredits(turnMicros) })}
            </p>
          ) : null}
          {taskMicros ? (
            <p className="type-support" style={{ color: 'var(--text-muted)', opacity: 0.75 }}>
              {t('chat.taskSpend', { credits: formatCredits(taskMicros) })}
            </p>
          ) : null}
        </div>
      )}
    </>
  );
}

const VIRTUOSO_COMPONENTS = { Footer: ChatTail };

export function ChatView() {
  const { t } = useTranslation();
  const activeTaskId = useTaskStore((s) => s.activeTaskId);
  const pendingNewTask = useTaskStore((s) => s.pendingNewTask);
  const activeTask = useTaskStore((s) => s.tasks.find((tk) => tk.id === activeTaskId));
  const gatewayStatus = useUiStore((s) =>
    activeTask?.gatewayId ? s.gatewayStatusMap[activeTask.gatewayId] : undefined,
  );
  const messages: Message[] = useMessageStore((s) =>
    activeTaskId ? (s.messagesByTask[activeTaskId] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES,
  );
  const activeTurn = useMessageStore((s) =>
    activeTask?.sessionKey ? s.activeTurnBySession[activeTask.sessionKey] : undefined,
  );
  const processing = useMessageStore((s) =>
    activeTask?.sessionKey ? s.processingBySession.has(activeTask.sessionKey) : false,
  );

  /**
   * 兜底轮询：处理中每 1.5s 拉一次该会话历史。
   *
   * 为什么要它：流式本该由网关事件驱动，但手机端实测出现过"显示正在响应、界面一个字都不出，
   * 退出重进才看到一点"的情况（事件没落到 UI）。轮询 history 不依赖事件通道，
   * 慢 1.5s 但保证内容一定会出现。
   */
  /**
   * 每轮结束结算一次消耗：processing true→false 那一刻读余额，与上一轮余额做差分。
   * 不在这里轮询 —— 只有回合边界才有意义，轮询既费流量又会把同一次结算算两遍。
   */
  const settleSpend = useSpendStore((s) => s.settle);
  const wasProcessing = useRef(false);
  useEffect(() => {
    const was = wasProcessing.current;
    wasProcessing.current = processing;
    if (was && !processing && activeTaskId && activeTask?.sessionKey) {
      void settleSpend({ sessionKey: activeTask.sessionKey, taskId: activeTaskId });
    }
  }, [processing, activeTaskId, activeTask?.sessionKey, settleSpend]);

  /**
   * 兜底轮询：只要打开着任务就**一直**拉（处理中 1.5s，空闲 3s）。
   *
   * 为什么不只在 processing 时拉：对端（电脑）发起的轮次，本机 processing 是 false，
   * 于是永远不拉 —— 真机表现就是"电脑发的消息手机上看不到，只看到模型在回复"。
   */
  useEffect(() => {
    if (!activeTaskId) return;
    const interval = processing ? 1500 : 3000;
    const timer = setInterval(() => {
      void sessionSync.syncSessionMessages(activeTaskId).catch(() => undefined);
    }, interval);
    return () => clearInterval(timer);
  }, [processing, activeTaskId]);
  /**
   * 文档产物（docgen）：模型回复里的 ```` ```docgen {...} ```` 块要由客户端渲染成 .docx，
   * 手机没有 Electron 那条渲染管线 ⇒ 之前真机就是"回复早就来了，产物永远没有"。
   * 这里在一条回复定稿后把正文交给桌面主进程渲染，文件落进 artifacts 表，产物页即可下载。
   */
  const docgenSubmitted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (processing || !activeTask?.sessionKey) return;
    const last = messages[messages.length - 1];
    if (!last || last.role !== 'assistant') return;
    const text = typeof last.content === 'string' ? last.content : '';
    if (!text.includes('docgen') || docgenSubmitted.current.has(last.id)) return;
    docgenSubmitted.current.add(last.id);
    void (async () => {
      try {
        const token = await gatewayToken();
        if (!token) return;
        await mobileFetch('/api/mobile/docgen', token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionKey: activeTask.sessionKey, messageId: last.id, content: text }),
        });
      } catch {
        /* 失败不打断对话，产物页仍可手动刷新 */
      }
    })();
  }, [messages, processing, activeTask?.sessionKey]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const useVirtualization = messages.length >= VIRTUALIZATION_THRESHOLD;

  const messageItems = useMemo(
    () => messages.map((msg) => ({ type: 'message' as const, id: msg.id, message: msg })),
    [messages],
  );

  const tailContext = useMemo<TailContext>(
    () => ({
      activeTurn,
      processing,
      gatewayStatus,
      taskId: activeTaskId ?? undefined,
      sessionKey: activeTask?.sessionKey,
      t,
    }),
    [activeTurn, processing, gatewayStatus, activeTaskId, activeTask?.sessionKey, t],
  );

  useEffect(() => {
    const container = scrollRef.current;
    const content = contentRef.current;
    if (!container || !content || useVirtualization) return;

    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        container.scrollTop = container.scrollHeight;
      });
    });
    ro.observe(content);

    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [useVirtualization]);

  if (!activeTaskId && !pendingNewTask) {
    // 首屏：深色沉浸卡片（发光星球 + 大字标题 + 主/次按钮），比一行灰字 + 一个按钮有分量。
    return (
      <div className="flex h-full flex-col justify-center gap-3" role="main" aria-label={t('chat.mainArea')}>
        <WelcomeHero
          onNewTask={async () => {
            await ensureHydrationReady();
            useTaskStore.getState().startNewTask();
          }}
          onOpenTasks={() => window.dispatchEvent(new CustomEvent('clawwork:open-compass'))}
        />
        <p className="px-6 text-center type-support" style={{ color: 'var(--text-muted)' }}>
          {t('chat.emptyHint')}
        </p>
      </div>
    );
  }

  if (!activeTaskId && pendingNewTask) {
    return (
      <div className="flex h-full flex-col" role="main" aria-label={t('chat.mainArea')}>
        <div className="flex-1" />
        <ChatInput taskId="__pending__" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" role="main" aria-label={t('chat.mainArea')}>
      <div
        ref={useVirtualization ? undefined : scrollRef}
        className={`flex-1 px-4 py-4 ${useVirtualization ? 'overflow-hidden' : 'overflow-y-auto overflow-x-hidden'}`}
      >
        {useVirtualization ? (
          <Virtuoso
            style={{ height: '100%' }}
            data={messageItems}
            followOutput="smooth"
            alignToBottom
            context={tailContext}
            aria-label={t('chat.virtualizedList')}
            computeItemKey={(_index, item) => item.id}
            itemContent={(_index, item) => <ChatMessage message={item.message} />}
            components={VIRTUOSO_COMPONENTS}
          />
        ) : (
          <div ref={contentRef}>
            {messages.map((msg) => (
              <ChatMessage key={msg.id} message={msg} />
            ))}
            <ChatTail context={tailContext} />
          </div>
        )}
      </div>
      <TurnActivity turn={activeTurn} processing={processing} taskId={activeTaskId ?? '__pending__'} />
      <QuestionPanel />
      <ChatInput taskId={activeTaskId ?? '__pending__'} />
    </div>
  );
}
