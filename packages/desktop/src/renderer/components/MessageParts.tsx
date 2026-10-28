import { useEffect, useState, type ReactNode } from 'react';
import { File } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * 消息体里**用户与助手两边共用**的小零件：附件卡、图片气泡、那排悬停才出现的动作按钮。
 *
 * 单独一个文件是为了别让"助手块"（`AssistantBlock`）和"用户/系统消息"（`ChatMessage`）
 * 各写一份 —— 两份实现迟早只改一处（这类"桩与真身各一份"已经栽过一次）。
 */

export function MessageActionButton({
  title,
  onClick,
  children,
  disabled = false,
  tone = 'default',
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
  tone?: 'default' | 'accent' | 'danger';
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={title}
      title={title}
      disabled={disabled}
      className={cn(
        'h-7 w-7 rounded-md border-none bg-transparent shadow-none',
        tone === 'default' && 'text-[var(--text-muted)] hover:text-[var(--text-primary)]',
        tone === 'accent' && 'text-[var(--accent)] hover:text-[var(--accent)]',
        tone === 'danger' && 'text-[var(--danger)] hover:text-[var(--danger)]',
      )}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </Button>
  );
}

export function AttachmentFileCard({ attachment }: { attachment: { fileName: string; localPath?: string } }) {
  const { t } = useTranslation();
  const canOpen = Boolean(attachment.localPath);
  return (
    <button
      type="button"
      disabled={!canOpen}
      onClick={async () => {
        if (!attachment.localPath) return;
        const res = await window.clawwork.openInboxFile(attachment.localPath);
        if (!res.ok) toast.error(t('chatInput.openFailed', { fileName: attachment.fileName }));
      }}
      className={cn(
        'inline-flex items-center gap-2 rounded-xl px-3 py-2 max-w-xs',
        'border border-[var(--border-subtle)] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]',
        canOpen
          ? 'cursor-pointer hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)] transition-colors'
          : 'opacity-70 cursor-default',
      )}
      title={attachment.fileName}
    >
      <File size={16} className="flex-shrink-0" />
      <span className="type-body truncate">{attachment.fileName}</span>
    </button>
  );
}

export function InlineImageBubble({
  attachment,
  single,
  onOpen,
}: {
  attachment: { fileName: string; dataUrl: string; mimeType?: string; localPath?: string; sourcePath?: string };
  single: boolean;
  onOpen?: (src: string) => void;
}) {
  const [src, setSrc] = useState(attachment.dataUrl);
  useEffect(() => {
    if (attachment.sourcePath) {
      let aborted = false;
      window.clawwork.readMediaFile(attachment.sourcePath).then((res) => {
        if (aborted) return;
        if (res.ok && res.result) {
          setSrc(`data:${attachment.mimeType ?? 'image/png'};base64,${res.result.content}`);
        }
      });
      return () => {
        aborted = true;
      };
    }
    if (!attachment.localPath) return;
    if (attachment.dataUrl.startsWith('data:')) return;
    let aborted = false;
    window.clawwork.readInboxFile(attachment.localPath).then((res) => {
      if (aborted) return;
      if (res.ok && res.result) {
        setSrc(`data:${attachment.mimeType ?? 'image/png'};base64,${res.result.content}`);
      }
    });
    return () => {
      aborted = true;
    };
  }, [attachment.localPath, attachment.sourcePath, attachment.mimeType, attachment.dataUrl]);
  return (
    <img
      src={src}
      alt={attachment.fileName}
      className={cn(
        'rounded-xl object-cover cursor-pointer border border-[var(--border-subtle)]',
        'hover:opacity-90 transition-opacity',
        single ? 'max-w-72 max-h-48' : 'w-20 h-20',
      )}
      onClick={() => onOpen?.(src)}
    />
  );
}
