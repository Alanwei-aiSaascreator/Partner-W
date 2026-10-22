import { useState, useRef, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowUp, Check, Mic, Plus, Square, Users, X } from 'lucide-react';
import type { ChatAttachment } from '@clawwork/shared';
import { composer, ensureHydrationReady } from '../stores';
import { useMessageStore, useTaskStore, useUiStore } from '../stores/hooks';
import { gatewayToken, mobileFetch } from '../lib/remote-api';
import { startVoiceRecording, voiceCapabilities } from '../lib/voice-stt';
import { reportDebugEvent } from '../lib/debug';
import { toast } from 'sonner';

interface ChatInputProps {
  taskId: string;
}

interface TeamMemberRow {
  agentId: string;
  role?: string;
  position?: string;
  isManager?: number;
}

function insideRect(el: Element, x: number, y: number): boolean {
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

const MAX_HEIGHT = 120;

export function ChatInput({ taskId }: ChatInputProps) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const sendShortcut = useUiStore((s) => s.sendShortcut);
  const pendingNewTask = useTaskStore((s) => s.pendingNewTask);
  const task = useTaskStore((s) => s.tasks.find((tk) => tk.id === taskId));
  const processing = useMessageStore((s) => (task?.sessionKey ? s.processingBySession.has(task.sessionKey) : false));
  const hasActiveTurn = useMessageStore((s) => (task?.sessionKey ? !!s.activeTurnBySession[task.sessionKey] : false));
  const isStreaming = processing || hasActiveTurn;
  // ⚠️ 团队任务 gatewayId 可能是 'local-runtime'，而手机端连接的网关 id 未必一致：
  //    只查任务 gatewayId 会查不到状态 → 输入框永远「连接中」禁用。
  //    用 defaultGatewayId（手机端实际已连接的）兜底判断可输入性。
  const defaultGatewayId = useUiStore((s) => s.defaultGatewayId);
  const effectiveGatewayId = task?.gatewayId || pendingNewTask?.gatewayId || defaultGatewayId;
  const gatewayStatus = useUiStore((s) => (effectiveGatewayId ? s.gatewayStatusMap[effectiveGatewayId] : undefined));
  const connected = gatewayStatus === 'connected';

  const placeholder = !connected ? t('gateway.connecting') : t('chat.inputPlaceholder');

  // ── 团队协作分发：任务带 teamId 时，可指定本条消息发给团队内某个成员（对齐桌面端 MentionPicker） ──
  const teamId = task?.teamId || pendingNewTask?.teamId;
  const [teamMembers, setTeamMembers] = useState<TeamMemberRow[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionTarget, setMentionTarget] = useState<string | null>(null);
  const [mentionPanelOpen, setMentionPanelOpen] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!teamId) {
      setTeamMembers([]);
      setMentionTarget(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const token = await gatewayToken();
      if (!token) return;
      try {
        const response = await mobileFetch('/api/mobile/teams', token);
        if (!response.ok) return;
        const data = (await response.json()) as { teams?: Array<{ id: string; members?: TeamMemberRow[] }> };
        const team = (data.teams ?? []).find((tm) => tm.id === teamId);
        if (!cancelled) setTeamMembers(team?.members ?? []);
      } catch {
        /* 拉不到就退化为普通输入 */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const pickMention = (member: TeamMemberRow) => {
    setMentionTarget(member.agentId);
    setMentionOpen(false);
    const label = member.position || member.agentId;
    setText((prev) => (prev ? `${prev} @${label} ` : `@${label} `));
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      const reader = new FileReader();
      reader.onload = () => {
        const content = reader.result as string;
        if (!content) return;
        setAttachments((prev) => [
          ...prev,
          { mimeType: file.type || 'application/octet-stream', fileName: file.name, content },
        ]);
      };
      reader.readAsDataURL(file);
    }
    event.target.value = '';
  };

  const sendContent = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed && attachments.length === 0) return;

      const prev = text;
      setText('');
      if (textareaRef.current) {
        textareaRef.current.style.height = '32px';
      }

      try {
        await composer.send(taskId === '__pending__' ? undefined : taskId, {
          content: trimmed,
          titleHint: trimmed,
          ...(mentionTarget ? { mentions: [mentionTarget] } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        setMentionTarget(null);
        setAttachments([]);
      } catch {
        setText(prev);
      }
    },
    [taskId, mentionTarget, attachments, text],
  );

  const handleSend = useCallback(async () => {
    await sendContent(text);
  }, [sendContent, text]);

  const handleAbort = useCallback(async () => {
    if (taskId === '__pending__') return;
    try {
      await composer.abort(taskId);
    } catch {
      /* abort is best-effort */
    }
  }, [taskId]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      const meta = e.metaKey || e.ctrlKey;
      const shouldSend = sendShortcut === 'cmdEnter' ? meta && !e.shiftKey : !meta && !e.shiftKey;
      if (!shouldSend) return;
      e.preventDefault();
      if (!isStreaming && text.trim()) {
        handleSend();
      }
    }
  };

  const handleInput = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, MAX_HEIGHT) + 'px';
    }
  };

  // ── 语音输入（2026-10-22 v3）────────────────────────────────────────────
  // 长按麦克风说话（默认：松手转写写入输入框）；按住时上方浮出三泡泡：
  //   时间泡泡（实时显示录音秒数）/ 发送泡泡 / 取消泡泡。
  // 手指**划到泡泡上**（泡泡高亮选中）→ 松手执行该泡泡动作；不划直接松手 = 写入输入框。
  // 不做实时转写（分段网络请求是卡的根源）；录音中只有 1s 一次的本地计时器，不卡。
  const [voiceSupported, setVoiceSupported] = useState(true);
  const [voiceState, setVoiceState] = useState<'idle' | 'listening' | 'transcribing'>('idle');
  const [voiceSeconds, setVoiceSeconds] = useState(0);
  const [voiceTarget, setVoiceTarget] = useState<'send' | 'cancel' | null>(null);
  const voiceHandleRef = useRef<Awaited<ReturnType<typeof startVoiceRecording>> | null>(null);
  const voiceAutoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceTickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const sendBubbleRef = useRef<HTMLButtonElement | null>(null);
  const cancelBubbleRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const caps = await voiceCapabilities();
        if (cancelled) return;
        if (caps === null) {
          reportDebugEvent({
            level: 'warn',
            domain: 'renderer',
            event: 'voice.capabilities.probe-failed',
            error: { message: 'voice capabilities probe threw (plugin bridge unavailable?)' },
          });
          return; // 探测异常：保持按钮可见
        }
        setVoiceSupported(caps.asr === true);
      } catch (err) {
        if (cancelled) return;
        reportDebugEvent({
          level: 'warn',
          domain: 'renderer',
          event: 'voice.capabilities.probe-failed',
          error: { message: err instanceof Error ? err.message : 'probe threw' },
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 卸载：清掉在录的会话与计时器
  useEffect(() => {
    return () => {
      if (voiceState === 'listening') voiceHandleRef.current?.cancel();
      if (voiceAutoTimer.current) clearTimeout(voiceAutoTimer.current);
      if (voiceTickTimer.current) clearInterval(voiceTickTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const voiceErrorToast = (msg: string): void => {
    if (msg === 'voice-unsupported') toast.error(t('chat.voiceUnsupported'));
    else if (msg === 'voice-mic-denied' || /permission|denied/i.test(msg)) toast.error(t('chat.voiceMicDenied'));
    else if (msg === 'voice-mic-unavailable') toast.error(t('chat.voiceMicUnavailable'));
    else if (msg === 'voice-unavailable') toast.error(t('chat.voiceRelayUnavailable'));
    else if (msg === 'voice-cancelled') return;
    else toast.error(t('chat.voiceFailed'));
  };

  const stopTicking = (): void => {
    if (voiceTickTimer.current) {
      clearInterval(voiceTickTimer.current);
      voiceTickTimer.current = null;
    }
  };

  /** 长按开始录音：三泡泡浮出，时间泡泡走秒。 */
  const handleVoiceDown = useCallback(
    (e: React.PointerEvent): void => {
      if (voiceState !== 'idle' || !connected) return;
      e.preventDefault();
      // 指针捕获：滑出按钮后 move/up 仍归本按钮处理（泡泡是视觉目标，不拦截手势）
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture 失败不致命：move 仍会触发 */
      }
      setVoiceTarget(null);
      setVoiceSeconds(0);
      setVoiceState('listening');
      // 录音秒数：1s 一次本地计时（轻量）
      voiceTickTimer.current = setInterval(() => {
        setVoiceSeconds((s) => s + 1);
      }, 1000);
      void startVoiceRecording()
        .then((handle) => {
          voiceHandleRef.current = handle;
          // 60s 自动停：视为「直接松手」（转写写入输入框）
          voiceAutoTimer.current = setTimeout(() => {
            handleVoiceUp();
          }, 60_000);
        })
        .catch((err: unknown) => {
          stopTicking();
          setVoiceState('idle');
          const msg = err instanceof Error ? err.message : '';
          reportDebugEvent({
            level: 'warn',
            domain: 'renderer',
            event: 'voice.start.failed',
            error: { message: msg || 'start threw' },
          });
          voiceErrorToast(msg);
        });
    },
    [voiceState, connected, t],
  );

  /** 按住滑动：手指落在哪个泡泡上就选中哪个（高亮），移出取消选中。 */
  const handleVoiceMove = useCallback(
    (e: React.PointerEvent): void => {
      if (voiceState !== 'listening') return;
      const x = e.clientX;
      const y = e.clientY;
      const hitSend = sendBubbleRef.current ? insideRect(sendBubbleRef.current, x, y) : false;
      const hitCancel = cancelBubbleRef.current ? insideRect(cancelBubbleRef.current, x, y) : false;
      const next = hitSend ? 'send' : hitCancel ? 'cancel' : null;
      if (next !== voiceTarget) setVoiceTarget(next);
    },
    [voiceState, voiceTarget],
  );

  /** 松手：按选中的泡泡执行；没选 = 转写写入输入框。 */
  const handleVoiceUp = useCallback((): void => {
    if (voiceState !== 'listening') return;
    stopTicking();
    const handle = voiceHandleRef.current;
    voiceHandleRef.current = null;
    if (voiceAutoTimer.current) {
      clearTimeout(voiceAutoTimer.current);
      voiceAutoTimer.current = null;
    }
    const target = voiceTarget;
    setVoiceTarget(null);
    setVoiceSeconds(0);
    if (!handle) {
      setVoiceState('idle');
      return;
    }
    if (target === 'cancel') {
      handle.cancel();
      setVoiceState('idle');
      toast.info(t('chat.voiceCancelled'));
      return;
    }
    setVoiceState('transcribing');
    void handle
      .stop()
      .then((transcript) => {
        setVoiceState('idle');
        const trimmed = transcript.trim();
        if (!trimmed) return;
        if (target === 'send') {
          // 划到发送泡泡：转写后直接发送
          void sendContent(trimmed);
        } else {
          // 直接松手：写入输入框，用户确认后再发送
          setText((prev) => (prev.trim() ? `${prev.trim()} ${trimmed}` : trimmed));
          textareaRef.current?.focus();
        }
      })
      .catch((err: unknown) => {
        setVoiceState('idle');
        const msg = err instanceof Error ? err.message : '';
        if (msg === 'voice-cancelled') return;
        reportDebugEvent({
          level: 'warn',
          domain: 'renderer',
          event: 'voice.stop.failed',
          error: { message: msg || 'stop threw' },
        });
        voiceErrorToast(msg);
      });
  }, [voiceState, voiceTarget, t, sendContent]);

  const mentionLabel = teamMembers.find((m) => m.agentId === mentionTarget)?.position || mentionTarget;

  return (
    <div className="safe-area-bottom relative bg-[var(--bg-primary)] px-3 py-2">
      {/* 三泡泡层：长按录音时浮在输入区上方 —— 取消（左）/ 时间（中）/ 发送（右）。
          手指划到泡泡上高亮选中，松手执行；不划直接松手 = 转写写入输入框。
          泡泡不拦截手势（pointer-events-none），手势全部在麦克风按钮上（已捕获指针）。 */}
      {voiceState !== 'idle' && (
        <div
          className="pointer-events-none absolute inset-x-0 z-50 flex items-center justify-center gap-3"
          style={{ bottom: 'calc(100% + 14px)' }}
        >
          <button
            ref={cancelBubbleRef}
            aria-label={t('chat.voiceCancelBubble')}
            className="flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-transform"
            style={{
              backgroundColor: voiceTarget === 'cancel' ? 'var(--danger)' : 'var(--bg-secondary)',
              color: voiceTarget === 'cancel' ? '#fff' : 'var(--danger)',
              border: '1px solid var(--border-primary)',
              transform: voiceTarget === 'cancel' ? 'scale(1.25)' : 'scale(1)',
            }}
          >
            <X size={20} />
          </button>
          <div
            className="type-label flex h-14 min-w-[76px] items-center justify-center rounded-full px-4 shadow-lg"
            style={{
              backgroundColor: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              border: '1px solid var(--border-primary)',
            }}
            aria-live="polite"
          >
            {voiceState === 'transcribing' ? t('chat.voiceTranscribing') : `${voiceSeconds}s`}
          </div>
          <button
            ref={sendBubbleRef}
            aria-label={t('chat.voiceSendBubble')}
            className="flex h-12 w-12 items-center justify-center rounded-full shadow-lg transition-transform"
            style={{
              backgroundColor: voiceTarget === 'send' ? 'var(--accent)' : 'var(--bg-secondary)',
              color: voiceTarget === 'send' ? 'var(--accent-foreground)' : 'var(--accent)',
              border: '1px solid var(--border-primary)',
              transform: voiceTarget === 'send' ? 'scale(1.25)' : 'scale(1)',
            }}
          >
            <ArrowUp size={20} />
          </button>
        </div>
      )}

      <div className="composer-shell flex items-end gap-2 px-2 py-1.5">
        <button
          onClick={() => fileInputRef.current?.click()}
          aria-label="添加附件"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors"
        >
          <Plus size={18} />
        </button>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          onInput={handleInput}
          placeholder={mentionTarget ? `发送给 ${mentionLabel}…` : placeholder}
          disabled={!connected}
          rows={1}
          aria-label={t('chat.inputPlaceholder')}
          className="type-body min-h-8 flex-1 resize-none bg-transparent py-1 text-[var(--text-primary)] outline-none"
        />
        {/* 语音：长按说话，松手转写写入输入框；按住上滑取消 */}
        {voiceSupported && (
          <button
            onPointerDown={handleVoiceDown}
            onPointerMove={handleVoiceMove}
            onPointerUp={handleVoiceUp}
            onPointerCancel={handleVoiceUp}
            onContextMenu={(e) => e.preventDefault()}
            aria-label={t('chat.voiceHold')}
            aria-pressed={voiceState === 'listening'}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors select-none"
            style={{
              color: voiceState !== 'idle' ? 'var(--accent-foreground)' : 'var(--text-secondary)',
              backgroundColor: voiceState !== 'idle' ? 'var(--accent)' : 'transparent',
              touchAction: 'none',
            }}
          >
            <Mic size={18} />
          </button>
        )}
        {isStreaming ? (
          <button
            onClick={handleAbort}
            aria-label={t('chat.abortButton')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--danger-bg)] text-[var(--danger)] transition-colors"
          >
            <Square size={14} />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim() || !connected}
            aria-label={t('chat.sendButton')}
            className="composer-send flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:opacity-30"
          >
            <ArrowUp size={16} />
          </button>
        )}
      </div>

      {teamId && teamMembers.length > 0 && (
        <>
          {/* 收起态：左侧悬浮圆球（当前选中成员 / 团队图标），点击展开 */}
          {!mentionPanelOpen && (
            <button
              onClick={() => setMentionPanelOpen(true)}
              aria-label="展开成员选择"
              className="fixed left-3 z-50 flex h-11 w-11 items-center justify-center rounded-full transition-all"
              style={{
                top: '50%',
                transform: 'translateY(-50%)',
                backgroundColor: mentionTarget ? 'var(--accent)' : 'var(--bg-secondary)',
                color: mentionTarget ? 'var(--accent-foreground)' : 'var(--text-secondary)',
                border: '1px solid var(--border-subtle)',
                boxShadow: '0 8px 24px -8px rgba(0,0,0,0.4)',
              }}
            >
              {mentionTarget ? (
                <span className="type-support font-semibold">
                  {teamMembers.find((m) => m.agentId === mentionTarget)?.isManager
                    ? '👑'
                    : (mentionLabel || '').slice(0, 1)}
                </span>
              ) : (
                <Users size={18} />
              )}
            </button>
          )}

          {/* 展开态：毛玻璃成员列表，点击选中 / 再点取消 */}
          {mentionPanelOpen && (
            <div
              className="fixed left-3 z-50 flex flex-col gap-1 rounded-2xl p-2"
              style={{
                top: '50%',
                transform: 'translateY(-50%)',
                backgroundColor: 'color-mix(in srgb, var(--bg-secondary) 92%, transparent)',
                backdropFilter: 'blur(14px)',
                boxShadow: '0 12px 40px -12px rgba(0,0,0,0.35)',
                border: '1px solid var(--border-subtle)',
                minWidth: 148,
              }}
            >
              <div className="flex items-center justify-between px-1.5 pb-1 pt-0.5">
                <span className="type-meta" style={{ color: 'var(--text-muted)' }}>
                  发给
                </span>
                <button
                  onClick={() => setMentionPanelOpen(false)}
                  aria-label="收起"
                  className="rounded p-1"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <X size={12} />
                </button>
              </div>
              {teamMembers.map((member) => {
                const active = member.agentId === mentionTarget;
                return (
                  <button
                    key={member.agentId}
                    onClick={() =>
                      setMentionTarget((prev) => (prev === member.agentId ? null : member.agentId))
                    }
                    aria-label={`${member.position || member.agentId}${active ? '（已选中）' : ''}`}
                    className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 text-left transition-colors"
                    style={{
                      backgroundColor: active ? 'var(--accent-dim)' : 'transparent',
                      color: active ? 'var(--accent)' : 'var(--text-secondary)',
                    }}
                  >
                    <span className="type-body" aria-hidden="true">
                      {member.isManager ? '👑' : '🤖'}
                    </span>
                    <span className="type-support flex-1 truncate">{member.position || member.agentId}</span>
                    {active && <Check size={14} style={{ color: 'var(--accent)' }} />}
                  </button>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* 附件预览（加号选择文件/图片后展示，可移除） */}
      {attachments.length > 0 && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          {attachments.map((att, index) => (
            <div
              key={index}
              className="flex items-center gap-1 rounded-lg px-2 py-1 type-support"
              style={{ backgroundColor: 'var(--bg-secondary)', minHeight: 30 }}
            >
              {att.mimeType.startsWith('image/') ? (
                <img src={att.content} alt={att.fileName} className="h-6 w-6 rounded object-cover" />
              ) : (
                <span aria-hidden="true">📄</span>
              )}
              <span className="max-w-[90px] truncate" style={{ color: 'var(--text-secondary)' }}>
                {att.fileName}
              </span>
              <button
                onClick={() => setAttachments((prev) => prev.filter((_, i) => i !== index))}
                aria-label="移除附件"
                className="p-0.5"
                style={{ color: 'var(--text-muted)' }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 隐藏的文件选择器：加号触发 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileChange}
        className="hidden"
        accept="image/*,.pdf,.doc,.docx,.txt,.md,.xlsx,.xls,.csv,.zip,.json"
      />

    </div>
  );
}
