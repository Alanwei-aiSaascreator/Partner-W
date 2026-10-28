import { useState, useEffect, useMemo } from 'react';
import { motion } from 'framer-motion';
import { ExternalLink, Loader2, Copy, Check, X } from 'lucide-react';
import hljs from 'highlight.js';
import { useTranslation } from 'react-i18next';
import type { Artifact, ArtifactPreview } from '@clawwork/shared';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { motion as motionPresets } from '@/styles/design-tokens';
import { cn, formatFileSize } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { getArtifactDisplayName } from '@/lib/artifact-labels';
import { useTaskStore } from '@/stores/taskStore';
import MarkdownContent from './MarkdownContent';

interface FilePreviewProps {
  artifact: Artifact;
  onNavigateToTask: (taskId: string, messageId: string) => void;
  onClose?: () => void;
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
}

function isVideo(mime: string): boolean {
  return mime === 'video/mp4' || mime === 'video/webm';
}

function isMarkdown(name: string): boolean {
  return name.endsWith('.md');
}

function langFromName(name: string): string {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    json: 'json',
    html: 'html',
    css: 'css',
    sql: 'sql',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    sh: 'bash',
    bash: 'bash',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    toml: 'toml',
    txt: '',
  };
  return map[ext] ?? '';
}

function extFromName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot !== -1 ? name.slice(dot + 1).toUpperCase() : '';
}

function CopyButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      onClick={() => {
        void copyTextToClipboard(text);
        setCopied(true);
      }}
      title={copied ? t('chatMessage.copied') : t('chatMessage.copyCode')}
      className={cn(
        'type-support flex items-center gap-1 rounded-md px-2 py-1 transition-colors',
        'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-hover)]',
        copied && 'text-[var(--accent)]',
      )}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

/**
 * 展示快照（H4，2026-10-09 复审）：预览区的**全部**展示状态打包成一份带身份的快照。
 *
 * 为什么不是五个分散 state：换文件 / 换工作区 / 同 id 修订 / 可用性降级时，它们会被
 * **逐个**清理 —— 渲染提交可能落在"标题已经换成 B、正文还是 A"的中间态（复审逐提交
 * 实测到了 `B.docx + A 的正文`）。改成"一份快照 + 身份比对"后，**身份不匹配就直接按
 * loading 渲染**（不等任何 effect），跨身份的字段组合从结构上不再可能出现。
 */
type PreviewSnapshot =
  | { ownerKey: string; kind: 'loading' }
  | { ownerKey: string; kind: 'error' }
  | { ownerKey: string; kind: 'too-large'; size: number }
  | {
      ownerKey: string;
      kind: 'ready';
      preview: ArtifactPreview | null;
      content: string | null;
      encoding: 'utf-8' | 'base64';
    };

export default function FilePreview({ artifact, onNavigateToTask, onClose }: FilePreviewProps) {
  const { t } = useTranslation();
  const workspaceEpoch = useTaskStore((s) => s.workspaceEpoch);
  /**
   * 身份 = 工作区 + 任务 + 文件 + 修订 + **可用性**。
   *
   * ⚠️ 可用性进身份是刻意的：`available → unknown/missing/unsafe` 是一次真实的**失效**
   *    （文件不再可读），旧正文必须当场失效；`?? 'unknown'` 让"没带可用性"的调用方
   *    落到"判不了"而不是被当成可读（缺省不等于可用）。
   */
  const availability = artifact.availability ?? 'unknown';
  const ownerKey = JSON.stringify([
    workspaceEpoch,
    artifact.taskId,
    artifact.id,
    artifact.sourceKey ?? null,
    availability,
  ]);
  const [snapshot, setSnapshot] = useState<PreviewSnapshot>({ ownerKey, kind: 'loading' });
  /** 只有身份匹配的快照才能渲染；否则当场按 loading 视图走（见类型注释）。 */
  const view: PreviewSnapshot = snapshot.ownerKey === ownerKey ? snapshot : { ownerKey, kind: 'loading' };
  /** 只有 `available` 才有"读"这回事；其余是状态文案，不启动 IPC。 */
  const canRead = availability === 'available';

  const ext = extFromName(artifact.name);
  // 预览标题（及其 alt）显示**注册的文件名**，不再显示类型名（2026-10-04 真机缺陷）。
  const title = getArtifactDisplayName(artifact, t);
  /** 正文 / 编码 / 富预览 / 复制出口一律取自**同属当前身份**的 ready 快照。 */
  const readyPreview = view.kind === 'ready' ? view.preview : null;
  const readyContent = view.kind === 'ready' ? view.content : null;
  const readyEncoding: 'utf-8' | 'base64' = view.kind === 'ready' ? view.encoding : 'utf-8';
  const isCode =
    view.kind === 'ready' &&
    readyEncoding === 'utf-8' &&
    !isMarkdown(artifact.name) &&
    !isImage(artifact.mimeType) &&
    !isVideo(artifact.mimeType);

  /**
   * PDF 的 blob URL（提到这一层是为了让它**不经过 ScrollArea** —— 见下面渲染处的说明）。
   *
   * ⚠️ 用 blob URL 而不是 `file://`：渲染层是沙箱化的，直接指文件路径会被挡；
   *    而 blob URL 交给 **Chromium 自带的阅读器**（实测：不会触发下载 ⇒ 是内嵌渲染）。
   * ⚠️ **URL 也带身份**：换身份时旧 URL 立刻不再满足显示条件（防止"B 的标题 + A 的 PDF"），
   *    并且每次换预览都要 `revokeObjectURL`，否则几十兆的字节会一直挂在内存里。
   */
  const pdfSource = view.kind === 'ready' && view.preview?.kind === 'pdf' ? view.preview.dataBase64 : null;
  const [pdfUrl, setPdfUrl] = useState<{ ownerKey: string; url: string } | null>(null);
  useEffect(() => {
    if (pdfSource === null) {
      setPdfUrl(null);
      return;
    }
    const bytes = Uint8Array.from(atob(pdfSource), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    setPdfUrl({ ownerKey, url });
    return () => URL.revokeObjectURL(url);
  }, [ownerKey, pdfSource]);
  const pdfHref =
    pdfUrl !== null && pdfUrl.ownerKey === ownerKey && canRead && view.kind === 'ready' ? pdfUrl.url : null;

  /** HTML：**直接从同属快照派生**，不需要 blob（走 `srcDoc`）—— 少一份生命周期要管。 */
  const htmlDoc = canRead && view.kind === 'ready' && view.preview?.kind === 'html' ? view.preview.html : null;

  /**
   * 请求归属（Task 1，2026-10-09 WorkBuddy 产物 UI A 批；H4 扩展）：
   *
   * - **每次读的归属** = 上面的 `ownerKey`（工作区 + 任务 + 文件 + 修订 + 可用性）；
   *   effect 重跑（换文件/换工作区/同 id 原地修订/可用性降级）即作废旧回调 —— 迟到的
   *   A 回包不许把 B 的内容盖掉，卸载后也不许再写状态。
   * - **两条链都不许悬空**：preview / read 任一拒绝 ⇒ 落定成可行动错误，
   *   绝不永远转圈（旧实现没有 rejection 处理，一拒就是永久 loading）。
   * - **preview `ok:false`（认得出但解析失败）不再降级**去读原始字节 ——
   *   二进制当文本上屏既是错的、又把真实原因吞了；如实报"读不了"。
   *   只有 `unsupported`（主进程明确说"不认识这个格式"）才走文本/图片老路。
   * - **非 available 不启动 IPC**（H4）：那不是"读失败"，是"按状态没有可读的东西"，
   *   渲染层如实显示对应状态文案（unknown/missing/unsafe），不冒充 readFailed。
   */
  useEffect(() => {
    /** 只有仍是**当前这一次**读的回包才能落定（其余一律丢弃）。 */
    let active = true;

    setSnapshot({ ownerKey, kind: 'loading' });

    const load = async (): Promise<void> => {
      try {
        // ⭐ **先问富预览**：主进程认得 .docx/.xlsx/.pptx/.pdf 就把它读成能渲染的形状；
        //    认不出（`unsupported`）会走老路（读文本/图片）。
        //    ⚠️ 认不认得**只由主进程一处判**（`previewKindFor`）—— 渲染层再写一份扩展名清单，
        //       两份迟早只改一处，而症状是功能对某种格式**静默不生效**。
        const rich = await window.clawwork.previewArtifact(artifact.id, artifact.taskId);
        if (!active) return;
        if (!rich.ok || !rich.result) {
          // 认得出但读/解析失败 ⇒ 如实报错（不把原始字节当文本读）。
          setSnapshot({ ownerKey, kind: 'error' });
          return;
        }
        if (rich.result.kind !== 'unsupported') {
          setSnapshot({ ownerKey, kind: 'ready', preview: rich.result, content: null, encoding: 'utf-8' });
          return;
        }
        const plain = await window.clawwork.readArtifactFile(artifact.id, artifact.taskId);
        if (!active) return;
        const result = plain.ok ? plain.result : undefined;
        if (!result) {
          setSnapshot({ ownerKey, kind: 'error' });
          return;
        }
        // ⚠️ 先判 `tooLarge`：这一支**没有 `content`**，当成"内容为空"喂给高亮
        //    会渲染出一块空白，而用户以为文件本来就是空的。
        if ('tooLarge' in result) {
          setSnapshot({ ownerKey, kind: 'too-large', size: result.size });
          return;
        }
        setSnapshot({ ownerKey, kind: 'ready', preview: null, content: result.content, encoding: result.encoding });
      } catch {
        if (active) setSnapshot({ ownerKey, kind: 'error' });
      }
    };

    if (canRead) void load();
    return () => {
      active = false;
    };
    // ⚠️ 依赖里**没有 `t`**（错误只存键、渲染时翻译）：i18n 的 `t` 不保证跨渲染同身份，
    //    放进来会让 effect 每次都重跑（自激循环）。这不是偷懒，是有意的稳定化。
  }, [ownerKey, canRead, artifact.id, artifact.taskId]);

  return (
    <motion.div className="glass-card flex flex-col h-full" {...motionPresets.slideIn}>
      <header className="flex items-center justify-between gap-2 px-4 h-11 border-b border-[var(--border)] flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {ext && (
            <span className="type-badge flex-shrink-0 rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[var(--text-muted)] leading-none">
              {ext}
            </span>
          )}
          <h3 className="type-label min-w-0 truncate text-[var(--text-primary)]">{title}</h3>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <span className="type-meta text-[var(--text-muted)]">{formatFileSize(artifact.size)}</span>
          {isCode && readyContent !== null && <CopyButton text={readyContent} />}
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t('filePreview.close')}
              title={t('filePreview.close')}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
                'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]',
              )}
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </header>

      {/* ⭐ PDF **不放进 ScrollArea**：它自带滚动（Chromium 阅读器），套在滚动容器里会变成
          嵌套滚动 —— 滚轮滚谁全看指针在哪，很难用。所以整块换成"占满剩余高度"的容器，
          高度由外层 flex 给（`min-h-0` 是让它在 flex 里能真的收缩），**不写任何任意值**。

          ⭐ HTML 同理（它也是自带滚动的整篇文档），但**封堵比 PDF 严得多**：
          `sandbox=""` 是不给任何权限（**尤其没有 `allow-scripts` / `allow-same-origin`**）——
          少了后者，iframe 里的脚本能摸到父窗口上的 `window.clawwork`（= 整台应用的 API）。
          主进程那边还注了一道 CSP（禁脚本/禁外联），两道锁缺一不可，见 `build-preview.ts`。
          ⚠️ 用 `srcDoc` 而不是拼进 `src`：内容不经 URL 解析，也不会把内容当文件路径去读。 */}
      {htmlDoc !== null ? (
        <div className="min-h-0 flex-1">
          <iframe
            title={t('filePreview.htmlTitle')}
            srcDoc={htmlDoc}
            sandbox=""
            className="h-full w-full border-0 bg-[var(--document-canvas)]"
          />
        </div>
      ) : pdfHref ? (
        <div className="min-h-0 flex-1">
          <iframe title={t('filePreview.pdfTitle')} src={pdfHref} className="h-full w-full border-0" />
        </div>
      ) : (
        <ScrollArea className="flex-1">
          {/* 非 available：这是**状态**不是错误 —— 复用成果卡那套 missing/unsafe/unknown 文案。 */}
          {!canRead && (
            <p
              className="type-support px-4 py-8 text-center text-[var(--text-muted)]"
              data-testid="preview-unavailable"
            >
              {t(`artifactCard.${availability}`)}
            </p>
          )}
          {canRead && view.kind === 'loading' && (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
            </div>
          )}
          {view.kind === 'error' && (
            <p className="type-support px-4 py-8 text-center text-[var(--danger)]">{t('filePreview.readFailed')}</p>
          )}
          {/* ⚠️ 不是错误、也不是"这种格式看不了"：文件是好的，只是太大。
              说清楚**有多大**，用户才知道下一步是"用系统程序打开"还是"这份文件不该在这看"。 */}
          {view.kind === 'too-large' && (
            <p className="type-support px-4 py-8 text-center text-[var(--text-muted)]" data-testid="preview-too-large">
              {t('filePreview.tooLargeToRead', { size: formatFileSize(view.size) })}
            </p>
          )}
          {readyPreview !== null && <RichPreview preview={readyPreview} />}
          {readyContent !== null && (
            <PreviewContent
              content={readyContent}
              encoding={readyEncoding}
              mimeType={artifact.mimeType}
              name={artifact.name}
              alt={title}
            />
          )}
        </ScrollArea>
      )}

      <div className="flex-shrink-0 border-t border-[var(--border)] px-4 py-2.5">
        <Button
          variant="soft"
          size="sm"
          onClick={() => onNavigateToTask(artifact.taskId, artifact.messageId)}
          className="w-full gap-2"
        >
          <ExternalLink size={14} />
          {t('filePreview.goToSource')}
        </Button>
      </div>
    </motion.div>
  );
}

function CodePreview({ content, lang }: { content: string; lang: string }) {
  const highlighted = useMemo(() => {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(content, { language: lang }).value;
    }
    return hljs.highlightAuto(content).value;
  }, [content, lang]);

  return (
    <div className="overflow-x-auto">
      <pre className="type-code-block p-4 leading-relaxed">
        <code
          className={cn('hljs', lang && `language-${lang}`)}
          style={{ background: 'none', padding: 0 }}
          dangerouslySetInnerHTML={{ __html: highlighted }}
        />
      </pre>
    </div>
  );
}

function PreviewContent({
  content,
  encoding,
  mimeType,
  name,
  alt,
}: {
  content: string;
  encoding: string;
  mimeType: string;
  name: string;
  alt: string;
}) {
  const { t } = useTranslation();

  if (isVideo(mimeType) && encoding === 'base64') {
    return (
      <div className="flex items-center justify-center p-4">
        <video
          src={`data:${mimeType};base64,${content}`}
          aria-label={alt}
          controls
          playsInline
          preload="metadata"
          className="max-w-full max-h-96 rounded-lg object-contain"
        />
      </div>
    );
  }

  if (isImage(mimeType) && encoding === 'base64') {
    return (
      <div className="flex items-center justify-center p-4">
        <img
          src={`data:${mimeType};base64,${content}`}
          alt={alt}
          className="max-w-full max-h-96 rounded-lg object-contain"
        />
      </div>
    );
  }

  if (isMarkdown(name)) {
    return (
      <div className="p-4">
        <MarkdownContent content={content} />
      </div>
    );
  }

  if (encoding === 'utf-8') {
    const lang = langFromName(name);
    return <CodePreview content={content} lang={lang} />;
  }

  return (
    <p className="type-support px-4 py-8 text-center text-[var(--text-muted)]">
      {t('filePreview.cannotPreview')} ({mimeType})
    </p>
  );
}

/**
 * ⭐ **富预览**：把 `.docx` / `.xlsx` / `.pptx` / `.pdf` 直接画出来。
 *
 * 为什么要有它：我们自己就能生成前三种（docgen），而这块组件以前只认图片 / Markdown / 代码
 * ⇒ **用户做完一份东西，在应用里看不见它**，只能导出去用 Office 开。
 *
 * ⚠️ docx / pptx 是**文字大纲**，不是像素级还原（那要引渲染库，而这个仓库加依赖有前科）。
 *    界面上**如实标出来**，不许让用户以为"我的文档就这么简陋"。
 */
function TruncatedNote() {
  const { t } = useTranslation();
  return (
    <p className="type-meta mt-2 text-[var(--text-muted)]" data-testid="preview-truncated">
      {t('filePreview.truncated')}
    </p>
  );
}

/**
 * 预览**模式**的如实标注（Task 1，2026-10-09）。
 *
 * docx/pptx 是**文字大纲**、xlsx 是**值**（公式不重算）—— 都是有用的近似，但都不是
 * 版式还原。之前源码注释里写着"界面上如实标出来"，界面却没标：用户容易以为
 * "我的文档就这么简陋"。这里把话说清楚（文案键 9 语言同步）。
 */
function PreviewModeNote({ kind }: { kind: 'text' | 'values' }) {
  const { t } = useTranslation();
  return (
    <p className="type-meta mb-2 text-[var(--text-muted)]" data-testid="preview-mode-note">
      {kind === 'text' ? t('filePreview.modeTextOnly') : t('filePreview.modeValuesOnly')}
    </p>
  );
}

function RichPreview({ preview }: { preview: ArtifactPreview }) {
  const { t } = useTranslation();

  if (preview.kind === 'sheet') {
    return (
      <div className="space-y-4 p-4">
        <PreviewModeNote kind="values" />
        {preview.sheets.map((sheet) => (
          <section key={sheet.name}>
            <h4 className="type-label mb-1.5 text-[var(--text-secondary)]">{sheet.name}</h4>
            <div className="overflow-x-auto">
              <table className="type-meta border-collapse">
                <tbody>
                  {sheet.rows.map((row, r) => (
                    <tr key={r}>
                      {row.map((cell, c) => (
                        <td
                          key={c}
                          className="whitespace-pre-wrap border border-[var(--border)] px-2 py-1 align-top text-[var(--text-primary)]"
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        {preview.truncated && <TruncatedNote />}
      </div>
    );
  }

  if (preview.kind === 'docx') {
    return (
      <div className="space-y-2 p-4">
        <PreviewModeNote kind="text" />
        {preview.paragraphs.map((line, i) => (
          <p key={i} className="type-body whitespace-pre-wrap text-[var(--text-primary)]">
            {line}
          </p>
        ))}
        {preview.truncated && <TruncatedNote />}
      </div>
    );
  }

  if (preview.kind === 'pptx') {
    return (
      <div className="space-y-4 p-4">
        <PreviewModeNote kind="text" />
        {preview.slides.map((slide) => (
          <section key={slide.index} className="rounded-lg border border-[var(--border)] p-3">
            <h4 className="type-meta mb-1.5 text-[var(--text-muted)]">
              {t('filePreview.slideLabel', { index: slide.index })}
            </h4>
            {slide.lines.length === 0 ? (
              <p className="type-meta text-[var(--text-muted)]">{t('filePreview.slideEmpty')}</p>
            ) : (
              slide.lines.map((line, i) => (
                <p key={i} className="type-body whitespace-pre-wrap text-[var(--text-primary)]">
                  {line}
                </p>
              ))
            )}
          </section>
        ))}
        {preview.truncated && <TruncatedNote />}
      </div>
    );
  }

  return (
    <p className="type-support px-4 py-8 text-center text-[var(--text-muted)]">{t('filePreview.cannotPreview')}</p>
  );
}
