import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/**
 * 新建笔记（T-c1）。
 *
 * 为什么要有它：资料库的另一半入口是"用户自己写一条"。文件那条路要用户先在盘上
 * 有东西，而很多时候知识就是一句话 —— 让他开编辑器、存盘、再回来添加，是把成本
 * 转嫁给了用户。
 *
 * ⚠️ **两个字段都必填**，而且空着提交时要**当场说清楚**：静默什么都不发生
 * （按钮看起来坏了）与"建了一条空笔记"（列表里多一条没用的）都是坏结果。
 * 校验放在这一层而不是后端：后端只知道"空文本"，说不出是哪个框没填。
 */
interface NoteComposerDialogProps {
  open: boolean;
  onCancel: () => void;
  onSubmit: (input: { title: string; text: string }) => Promise<void> | void;
}

export default function NoteComposerDialog({ open, onCancel, onSubmit }: NoteComposerDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 每次打开都是干净的：上一次的内容留着会让人误以为已经建过了
  useEffect(() => {
    if (open) {
      setTitle('');
      setText('');
      setInvalid(false);
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = async (): Promise<void> => {
    if (!title.trim() || !text.trim()) {
      setInvalid(true);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ title: title.trim(), text });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent data-testid="kb-note-dialog">
        <DialogHeader>
          <DialogTitle>{t('kb.noteTitle')}</DialogTitle>
          <DialogDescription>{t('kb.noteDescription')}</DialogDescription>
        </DialogHeader>

        <div className="mt-4 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="type-meta text-[var(--text-muted)]">{t('kb.noteTitleLabel')}</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t('kb.noteTitlePlaceholder')}
              className="rounded-lg border border-[var(--border-subtle)] bg-transparent px-2.5 py-1.5 type-body outline-none placeholder:text-[var(--text-muted)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="type-meta text-[var(--text-muted)]">{t('kb.noteBodyLabel')}</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder={t('kb.noteBodyPlaceholder')}
              rows={6}
              className="resize-y rounded-lg border border-[var(--border-subtle)] bg-transparent px-2.5 py-1.5 type-body outline-none placeholder:text-[var(--text-muted)]"
            />
          </label>
          {invalid && (
            <p data-testid="kb-note-invalid" className="type-support text-[var(--danger)]">
              {t('kb.noteNeedContent')}
            </p>
          )}
        </div>

        <DialogFooter className="mt-6">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button disabled={submitting} onClick={() => void handleSubmit()}>
            {t('kb.noteCreate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
