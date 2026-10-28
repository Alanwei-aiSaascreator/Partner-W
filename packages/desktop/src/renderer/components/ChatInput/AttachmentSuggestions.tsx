import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  buildAttachmentActions,
  classifyAttachmentFile,
  type AttachmentAction,
  type AttachmentFileRef,
  type ImageInputSupport,
} from '../../lib/attachment-actions';

/**
 * 附件的**建议操作**行（F 组 / C 组共用）：拖入 / 选入文件后就地给出"接下来可以做什么"。
 *
 * 纪律：
 *   - 只给**真能做到**的动作：读类动作点击即发（如「提取文字」——不再多问一步）；
 *     改 / 生成类动作只把提示词填进输入框（缺具体诉求，等用户补完自己发）。
 *   - 模型确实不看图时**如实说明**，不假装能识别（好看的空承诺 = 用户白发一轮）。
 *   - 没有动作就整行不渲染 —— 不占位、不制造噪音。
 */
export default function AttachmentSuggestions({
  files,
  imageInput,
  disabled = false,
  onAction,
}: {
  files: readonly AttachmentFileRef[];
  imageInput: ImageInputSupport;
  disabled?: boolean;
  onAction: (action: AttachmentAction) => void;
}) {
  const { t } = useTranslation();
  // 图片动作只在模型自述支持看图（`supported`）时给 —— 开关传下去（判据在 attachment-actions 里）。
  const actions = buildAttachmentActions(files, imageInput);
  if (actions.length === 0) return null;

  const hasImage = files.some((file) => classifyAttachmentFile(file.fileName, file.mimeType) === 'image');

  return (
    <div className="mb-2 flex flex-wrap items-center gap-2 px-1" data-testid="attachment-suggestions">
      <span className="type-support shrink-0 text-[var(--text-muted)]">{t('chatInput.attachmentActions.title')}</span>
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          disabled={disabled}
          onClick={() => onAction(action)}
          className={cn(
            'type-support inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5',
            'border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)]',
            'transition-colors hover:bg-[var(--bg-hover)] focus-visible:outline-none glow-focus',
            action.kind === 'edit' && 'border-[var(--border-accent)] text-[var(--accent)]',
            disabled && 'cursor-not-allowed opacity-60',
          )}
        >
          {t(action.labelKey)}
        </button>
      ))}
      {hasImage && imageInput === 'unsupported' && (
        <span className="type-meta w-full text-[var(--text-muted)]" role="note">
          {t('chatInput.attachmentActions.imageUnsupported')}
        </span>
      )}
    </div>
  );
}
