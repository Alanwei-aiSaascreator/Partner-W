import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { ChevronRight } from 'lucide-react';

interface MarkdownContentProps {
  content: string;
}

const ALLOWED_ELEMENTS = new Set([
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'ul',
  'ol',
  'li',
  'code',
  'pre',
  'blockquote',
  'a',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  'hr',
  'br',
  'del',
  'input',
]);

function isSafeHref(href: string | undefined): string | undefined {
  if (!href) return href;
  const trimmed = href.trim().toLowerCase();
  if (trimmed.startsWith('javascript:') || trimmed.startsWith('data:')) return undefined;
  return href;
}

/** 把 React 子节点拼成纯文本（用于判断长度/形态）。 */
function plainText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  if (typeof node === 'object' && 'props' in (node as { props?: unknown })) {
    const props = (node as { props?: { children?: ReactNode } }).props;
    return plainText(props?.children);
  }
  return '';
}

/**
 * 长块（工具参数 JSON、文件路径列表、整段代码）默认折叠。
 *
 * 用户的原话：「输出的只要结果，这些全部虚化折叠进去」—— 模型把生成文档的
 * 参数 JSON（几十行）直接吐进正文时，手机上一条消息能占满整屏，真正的结论
 * 反而被挤没了。这里按长度兜底：超过 240 字符的代码/JSON 段先收起，
 * 只留一行「已折叠 N 字符」的提示。
 */
function CollapsibleBlock({
  text,
  children,
  alwaysFold = false,
}: {
  text: string;
  children: ReactNode;
  /** 路径这类"过程信息"不论长短都收起（用户不想在正文里看到 C:\... 路径）。 */
  alwaysFold?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const long = alwaysFold || text.trim().length > 240;

  if (!long) return <>{children}</>;

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="type-support flex items-center gap-1 rounded-md px-2 py-1"
        style={{ color: 'var(--text-muted)', backgroundColor: 'var(--bg-tertiary)' }}
      >
        <ChevronRight
          size={12}
          style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 0.2s' }}
          aria-hidden="true"
        />
        {open ? '收起' : `已折叠 ${text.trim().length.toLocaleString()} 字符 · 点击展开`}
      </button>
      {open && <div className="mt-1">{children}</div>}
    </div>
  );
}

const components: Components = {
  a: ({ children, href, ...props }) => (
    <a {...props} href={isSafeHref(href)} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
  input: (props) => {
    if (props.type !== 'checkbox') return null;
    return <input {...props} disabled />;
  },
  // 代码块：长内容默认收起
  pre: ({ children }) => <CollapsibleBlock text={plainText(children)}>{children}</CollapsibleBlock>,
  // 裸 JSON（模型经常不带围栏直接吐出来）也会落到 p 上，同样折叠
  p: ({ children }) => {
    const text = plainText(children);
    const looksLikeJson = /^\s*[{[]/.test(text) && /"[^"]+"\s*:/.test(text);
    // 绝对路径（Windows 盘符 / Unix 深路径）属于"过程信息"：默认收起，
    // 不让一长串 C:\Users\...\xxx.docx 占满手机屏幕。
    const looksLikePath =
      /[A-Za-z]:\\[^\s]+/.test(text) || /(^|\s)\/(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]{2,5}/i.test(text);
    if (looksLikeJson || looksLikePath) {
      return (
        <CollapsibleBlock text={text} alwaysFold={looksLikePath && !looksLikeJson}>
          <p className="type-body whitespace-pre-wrap">{children}</p>
        </CollapsibleBlock>
      );
    }
    return <p>{children}</p>;
  },
};

export function MarkdownContent({ content }: MarkdownContentProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      allowedElements={Array.from(ALLOWED_ELEMENTS)}
      unwrapDisallowed
      skipHtml
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
}
