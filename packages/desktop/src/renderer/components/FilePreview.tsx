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
import { getArtifactLabel } from '@/lib/artifact-labels';
import MarkdownContent from './MarkdownContent';

interface FilePreviewProps {
  artifact: Artifact;
  onNavigateToTask: (taskId: string, messageId: string) => void;
  onClose?: () => void;
}

function isImage(mime: string): boolean {
  return mime.startsWith('image/');
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

export default function FilePreview({ artifact, onNavigateToTask, onClose }: FilePreviewProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [encoding, setEncoding] = useState<'utf-8' | 'base64'>('utf-8');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const ext = extFromName(artifact.name);
  const title = getArtifactLabel(artifact, t);
  const isCode = encoding === 'utf-8' && !isMarkdown(artifact.name) && !isImage(artifact.mimeType);

  const [preview, setPreview] = useState<ArtifactPreview | null>(null);

  /**
   * PDF 的 blob URL（提到这一层是为了让它**不经过 ScrollArea** —— 见下面渲染处的说明）。
   *
   * ⚠️ 用 blob URL 而不是 `file://`：渲染层是沙箱化的，直接指文件路径会被挡；
   *    而 blob URL 交给 **Chromium 自带的阅读器**（实测：不会触发下载 ⇒ 是内嵌渲染）。
   * ⚠️ 每次换预览都要 `revokeObjectURL`，否则几十兆的字节会一直挂在内存里。
   */
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  useEffect(() => {
    if (preview?.kind !== 'pdf') {
      setPdfUrl(null);
      return;
    }
    const bytes = Uint8Array.from(atob(preview.dataBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    setPdfUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview]);

  /** HTML：**直接从预览状态派生**，不需要 blob（走 `srcDoc`）—— 少一份生命周期要管。 */
  const htmlDoc = preview?.kind === 'html' ? preview.html : null;

  useEffect(() => {
    setLoading(true);
    setError(null);
    setContent(null);
    setPreview(null);

    const readPlain = () => {
      window.clawwork.readArtifactFile(artifact.id, artifact.taskId).then((res) => {
        if (res.ok && res.result) {
          const r = res.result as { content: string; encoding: string };
          setContent(r.content);
          setEncoding(r.encoding as 'utf-8' | 'base64');
        } else {
          setError(res.error ?? 'failed to read file');
        }
        setLoading(false);
      });
    };

    // ⭐ **先问富预览**：主进程认得 .docx/.xlsx/.pptx/.pdf 就把它读成能渲染的形状；
    //    认不出会回 `unsupported`，那时再走老路（读文本/图片）。
    //    ⚠️ 认不认得**只由主进程一处判**（`previewKindFor`）—— 渲染层再写一份扩展名清单，
    //       两份迟早只改一处，而症状是功能对某种格式**静默不生效**。
    window.clawwork.previewArtifact(artifact.id, artifact.taskId).then((res) => {
      if (res.ok && res.result && res.result.kind !== 'unsupported') {
        setPreview(res.result);
        setLoading(false);
        return;
      }
      readPlain();
    });
  }, [artifact.id, artifact.taskId]);

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
          {isCode && content !== null && <CopyButton text={content} />}
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
      ) : pdfUrl ? (
        <div className="min-h-0 flex-1">
          <iframe title={t('filePreview.pdfTitle')} src={pdfUrl} className="h-full w-full border-0" />
        </div>
      ) : (
        <ScrollArea className="flex-1">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
            </div>
          )}
          {error && <p className="type-support px-4 py-8 text-center text-[var(--danger)]">{error}</p>}
          {!loading && !error && preview !== null && <RichPreview preview={preview} />}
          {!loading && !error && content !== null && (
            <PreviewContent
              content={content}
              encoding={encoding}
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

function RichPreview({ preview }: { preview: ArtifactPreview }) {
  const { t } = useTranslation();

  if (preview.kind === 'sheet') {
    return (
      <div className="space-y-4 p-4">
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
