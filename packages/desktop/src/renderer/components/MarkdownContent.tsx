import {
  isValidElement,
  memo,
  useMemo,
  useRef,
  type ReactNode,
  useEffect,
  useState,
  type ComponentPropsWithoutRef,
} from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy, Save, Loader2, Presentation, Globe, Video, ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { pendingFencedCodeStarts } from '@/lib/markdown-code-pending';
import { useArtifactDeliveryProof, type RequestCardState } from '@/lib/artifact-delivery-proof';

const REQUEST_CARD_ICON = { docgen: Presentation, htmlgen: Globe, videogen: Video, imagegen: ImageIcon } as const;

const REQUEST_CARD_STATE_KEY: Record<RequestCardState, string> = {
  pending: 'Pending',
  generating: 'Generating',
  failed: 'Failed',
  unconfirmed: 'Unconfirmed',
  delivered: 'Delivered',
};

/**
 * ⚠️ DOCX-205 合同 §5.C（2026-10-10）：`docgen` / `htmlgen` 围栏的**状态卡片**。
 * （2026-10-12 视频接入：`videogen` 并入同款卡片 —— 五态语义完全一样，
 * 差别只在：视频是后台作业（分钟级），活动帧与产物按 `videogen` 专属判据取，
 * 见 `artifact-delivery-proof.ts` 的 `kind` 参数。）
 *
 * 文案跟随**真实交付状态**（`useArtifactDeliveryProof`：交付活动 × 已登记且实时
 * 可读的产物），不再无条件写"成品见右侧「产物」"；只有 `delivered`（活动 succeeded
 * 且该 messageId 有 availability=available 的登记产物）才出现成功文案与「打开」按钮，
 * 且按钮只指向**已登记**的那一版（`openArtifactFile(id, taskId)`）。
 */
function RequestArtifactCard({
  kind,
  taskId,
  messageId,
}: {
  kind: 'docgen' | 'htmlgen' | 'videogen' | 'imagegen';
  taskId?: string;
  messageId?: string;
}) {
  const { t } = useTranslation();
  const [openFailed, setOpenFailed] = useState(false);
  const { state, artifactId } = useArtifactDeliveryProof(taskId, messageId, kind);
  const Icon = REQUEST_CARD_ICON[kind];
  const statusCopy =
    kind === 'imagegen'
      ? (() => {
          switch (state) {
            case 'pending':
              return t('chatMessage.imagegenPending');
            case 'generating':
              return t('chatMessage.imagegenGenerating');
            case 'failed':
              return t('chatMessage.imagegenFailed');
            case 'unconfirmed':
              return t('chatMessage.imagegenUnconfirmed');
            case 'delivered':
              return t('chatMessage.imagegenDelivered');
          }
        })()
      : t(`chatMessage.${kind}${REQUEST_CARD_STATE_KEY[state]}`);
  const open = async (): Promise<void> => {
    if (!artifactId || !taskId) return;
    try {
      const response = await window.clawwork.openArtifactFile(artifactId, taskId);
      if (!response.ok) throw new Error(response.error);
      setOpenFailed(false);
    } catch {
      setOpenFailed(true);
    }
  };
  return (
    <div
      data-testid={`${kind}-block`}
      data-delivery-state={state}
      className="my-1.5 flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] px-3 py-2 text-[var(--text-secondary)]"
    >
      <Icon size={14} className="shrink-0 text-[var(--accent)]" />
      <span className="type-support">{statusCopy}</span>
      {state === 'delivered' && artifactId && (
        <button
          type="button"
          onClick={() => void open()}
          className="type-support ml-auto shrink-0 underline underline-offset-2 hover:text-[var(--text-primary)]"
        >
          {t('artifactCard.open')}
        </button>
      )}
      {openFailed && (
        <span className="type-support shrink-0 text-[var(--danger)]">{t('artifactCard.openFailedHint')}</span>
      )}
    </div>
  );
}

/**
 * react-markdown 注入的 hast 节点（只用位置信息；避免为此把 `hast` 引成依赖）。
 */
interface MarkdownNodePosition {
  position?: { start?: { offset?: number } | null; end?: { offset?: number } | null } | null;
}

interface MarkdownContentProps {
  content: string;
  onImageClick?: (src: string) => void;
  showMessageCopy?: boolean;
  showCursor?: boolean;
  taskId?: string;
  messageId?: string;
}

function flattenTextContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(flattenTextContent).join('');
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return flattenTextContent(node.props.children);
  }
  return '';
}

function extractLang(children: ReactNode): string {
  if (!isValidElement<{ className?: string }>(children)) return '';
  const cls = children.props.className ?? '';
  const match = /language-(\S+)/.exec(cls);
  return match ? match[1] : '';
}

interface CopyActionButtonProps {
  label: string;
  copiedLabel: string;
  text: string;
  className?: string;
}

function CopyActionButton({ label, copiedLabel, text, className }: CopyActionButtonProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async (): Promise<void> => {
    await copyTextToClipboard(text);
    setCopied(true);
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? copiedLabel : label}
      title={copied ? copiedLabel : label}
      className={cn(
        'h-7 w-7 rounded-md border-none bg-transparent shadow-none',
        'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        void handleCopy();
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </Button>
  );
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

interface SaveActionButtonProps {
  className?: string;
  onSave: () => Promise<void>;
}

function SaveActionButton({ className, onSave }: SaveActionButtonProps) {
  const [state, setSaveState] = useState<SaveState>('idle');

  useEffect(() => {
    if (state !== 'saved' && state !== 'error') return;
    const timer = window.setTimeout(() => setSaveState('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const handleSave = async (): Promise<void> => {
    if (state === 'saving') return;
    setSaveState('saving');
    try {
      await onSave();
      setSaveState('saved');
    } catch {
      setSaveState('error');
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      disabled={state === 'saving'}
      className={cn(
        'h-7 w-7 rounded-md border-none bg-transparent shadow-none',
        'text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
        state === 'saved' && 'text-[var(--accent)]',
        state === 'error' && 'text-[var(--danger)]',
        className,
      )}
      onClick={(event) => {
        event.stopPropagation();
        void handleSave();
      }}
    >
      {state === 'saving' ? (
        <Loader2 size={14} className="animate-spin" />
      ) : state === 'saved' ? (
        <Check size={14} />
      ) : (
        <Save size={14} />
      )}
    </Button>
  );
}

/**
 * ⚠️ **不要加 `as const`，也不要每次渲染现展开一份**。
 *
 * 这两个数组原来写成 `as const` + 传参时 `[...REMARK_PLUGINS]` 展开：
 * 加 `as const` 会变成 `readonly` 元组，而 `react-markdown` 收的是可变的 `Pluggable[]`
 * —— 展开正是为了绕开类型。代价是**每个 delta 都造一个新数组** ⇒
 * react-markdown 每次重建 unified processor。
 * 写成普通数组两者兼得：类型可变 + 引用稳定（`pnpm typecheck` 会守住这一点）。
 */
const REMARK_PLUGINS = [remarkGfm];
const REHYPE_PLUGINS = [rehypeHighlight];

function MarkdownContent({
  content,
  onImageClick,
  showMessageCopy = false,
  showCursor = false,
  taskId,
  messageId,
}: MarkdownContentProps) {
  const { t } = useTranslation();
  const copyMessageLabel = t('chatMessage.copyMessage');
  const copyCodeLabel = t('chatMessage.copyCode');
  const copiedLabel = t('chatMessage.copied');

  /**
   * 未闭合代码块判据（Task 6 / G2）需要**当前原文**与**是否流式**，但 `components` 表
   * **必须引用稳定**（见下方注释：新 components 对象 = 每个子树卸载重建）。
   * 所以：原文 → `pendingFencedCodeStarts`（按 content memo，**每次原文只解析一次**，
   * 不在每个 `pre` 里重复解析；非流式/历史消息直接空集、不扫描），再走 ref 传入
   * 渲染函数（同一趟 render 里先写后读；ref 只传值、不承载状态）。
   */
  const pendingStarts = useMemo(
    () => (showCursor ? pendingFencedCodeStarts(content) : new Set<number>()),
    [content, showCursor],
  );
  const pendingStartsRef = useRef(pendingStarts);
  pendingStartsRef.current = pendingStarts;
  const showCursorRef = useRef(showCursor);
  showCursorRef.current = showCursor;

  /**
   * ⚠️ 插件数组与 `components` 表**必须引用稳定**，别在渲染里现造。
   *
   * 这不是风格问题：`react-markdown` 拿到**新的** `components` 对象时，
   * 里面每个渲染函数（`pre` / `a` / `img` / `table` …）都是**新的组件类型**，
   * 于是 React 把那些子树**卸载重建**而不是更新 —— 流式期间每个 delta 都来一次。
   * ⚠️ 依赖里每一项在流式期间都是稳定的；漏掉任何一项都会让闭包拿到旧的
   *   `onImageClick` / `taskId` / `messageId`，那是"点了没反应"。
   */
  const components = useMemo(
    () => ({
      table: ({ children }: ComponentPropsWithoutRef<'table'>) => (
        <div className="my-2 overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)]">
          <table>{children}</table>
        </div>
      ),
      a: ({ href, children }: ComponentPropsWithoutRef<'a'>) => (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            if (href && /^https?:\/\//.test(href)) {
              window.open(href, '_blank');
            }
          }}
          rel="noopener noreferrer"
        >
          {children}
        </a>
      ),
      img: ({ src, alt }: ComponentPropsWithoutRef<'img'>) => {
        const actualSrc = src?.startsWith('clawwork-media://') ? `file://${src.replace('clawwork-media://', '')}` : src;
        return (
          <span className="group/img relative inline-block">
            <img
              src={actualSrc}
              alt={alt ?? ''}
              loading="lazy"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
              className="max-w-full max-h-80 rounded-lg mt-2 cursor-pointer"
              onClick={() => actualSrc && onImageClick?.(actualSrc)}
            />
            {taskId && messageId && actualSrc && (
              <span className="absolute top-3 right-2 opacity-0 transition-opacity group-hover/img:opacity-100">
                <SaveActionButton
                  onSave={() =>
                    window.clawwork
                      .saveImageFromUrl({ taskId, messageId, url: src ?? '', alt: alt ?? '' })
                      .then((r) => {
                        if (!r.ok) throw new Error(r.error);
                      })
                  }
                />
              </span>
            )}
          </span>
        );
      },
      pre: ({ children, node }: ComponentPropsWithoutRef<'pre'> & { node?: MarkdownNodePosition }) => {
        const code = flattenTextContent(children).replace(/\n$/, '');
        const lang = extractLang(children);
        /**
         * ⭐ `docgen` / `htmlgen` / `videogen` 块**不是代码**，是"请生成一份文件 /
         * 网页 / 视频"的请求（schema 见 `main/docgen/request.ts`、
         * `main/htmlgen/request.ts`、`main/videogen/request.ts`）。
         * 把原始 JSON 摊给用户看既是噪音、又像是让他去编辑它 ——
         * **更要命的是它带一个"复制"按钮**：用户会以为"我得自己存成文件"，
         * 而那正是这条通道想消灭的行为。
         * 这里换成一行卡片：真正的东西是客户端渲染/生成出来的文件，出现在右侧「产物」里。
         *
         * ⚠️ 三条通道必须**同时**在这里有分支：`htmlgen` 曾经漏掉，
         *    于是它渲染成普通代码块 + 复制按钮 —— 界面上等于告诉用户
         *    "这功能不存在，你自己复制吧"。加通道时别忘了这里。
         */
        const requestCard = (() => {
          switch (lang.toLowerCase()) {
            case 'docgen':
              return { kind: 'docgen' as const };
            case 'htmlgen':
              return { kind: 'htmlgen' as const };
            case 'imagegen':
              return { kind: 'imagegen' as const };
            case 'videogen':
              return { kind: 'videogen' as const };
            default:
              return null;
          }
        })();
        if (requestCard) {
          // ⚠️ DOCX-205 合同 §5.C：卡片文案**跟随真实交付状态**（待处理/正在生成/
          //    失败/未确认/已生成）—— 不再无条件承诺"成品见右侧「产物」"。
          return <RequestArtifactCard kind={requestCard.kind} taskId={taskId} messageId={messageId} />;
        }
        /*
          未闭合围栏占位（Task 6 / G2）：位置来自**真实解析器**（hast node.position 起点），
          判据 = 起点在 `pendingFencedCodeStarts`（真实 mdast + micromark token 交叉判定，
          见 `markdown-code-pending.ts`）。仅流式期间生效；docgen/htmlgen 在此之前已分支。
        */
        const startOffset = node?.position?.start?.offset;
        const codePending =
          showCursorRef.current && typeof startOffset === 'number' && pendingStartsRef.current.has(startOffset);
        return (
          <div className="group/code relative max-w-full" data-code-pending={codePending ? 'true' : undefined}>
            {lang && (
              <span className="type-support pointer-events-none absolute left-3 top-2.5 select-none text-[var(--text-muted)]">
                {lang}
              </span>
            )}
            <div className="absolute right-2 top-2 z-10 flex gap-1 opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100">
              {taskId && messageId && (
                <SaveActionButton
                  onSave={() =>
                    window.clawwork
                      .saveCodeBlock({ taskId, messageId, content: code, language: lang || undefined })
                      .then((r) => {
                        if (!r.ok) throw new Error(r.error);
                      })
                  }
                />
              )}
              <CopyActionButton label={copyCodeLabel} copiedLabel={copiedLabel} text={code} />
            </div>
            <pre className="pt-10">{children}</pre>
          </div>
        );
      },
    }),
    // ⚠️ 这里**不需要** `t`：docgen/htmlgen 卡片的文案由 `RequestArtifactCard`
    //    自己订阅（内部 `useTranslation`），切语言时那张卡片自行重渲染；
    //    memo 里只用到上面这些已解构出的标签与稳定回调。
    [copyCodeLabel, copiedLabel, messageId, onImageClick, taskId],
  );

  return (
    <div className="group min-w-0">
      <div className={cn('flex min-w-0 items-start gap-2', showMessageCopy && 'justify-between')}>
        <div className="prose-chat min-w-0 flex-1">
          <Markdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={REHYPE_PLUGINS} components={components}>
            {content}
          </Markdown>
        </div>
        {showMessageCopy && content.trim() && (
          <div className="flex gap-1 mt-0.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100">
            {taskId && messageId && (
              <SaveActionButton
                onSave={() =>
                  window.clawwork.saveCodeBlock({ taskId, messageId, content, language: 'md' }).then((r) => {
                    if (!r.ok) throw new Error(r.error);
                  })
                }
              />
            )}
            <CopyActionButton label={copyMessageLabel} copiedLabel={copiedLabel} text={content} />
          </div>
        )}
      </div>
      {showCursor && (
        /* 流式光标：2px×15px 品牌色 1s step-end 闪烁（Task 6；样式在 theme.css `.stream-cursor`）。 */
        <span className="stream-cursor" />
      )}
    </div>
  );
}

/**
 * ⚠️ **默认浅比较就够了，千万别写自定义比较器**：比较器里漏掉 `content`
 * 会把**流式正文冻住**（内容在涨而界面不动）—— 那是这条路上最坏的失效。
 * 浅比较对 `content` 这种字符串是按值比的，正好。
 */
export default memo(MarkdownContent);
