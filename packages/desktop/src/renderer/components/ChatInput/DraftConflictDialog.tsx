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

interface DraftConflictDialogProps {
  open: boolean;
  onCancel: () => void;
  onAppend: () => void;
  onReplace: () => void;
}

export default function DraftConflictDialog({ open, onCancel, onAppend, onReplace }: DraftConflictDialogProps) {
  const { t } = useTranslation();

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('taskWorkbench.draftConflictTitle')}</DialogTitle>
          <DialogDescription>{t('taskWorkbench.draftConflictDescription')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-6">
          <Button variant="ghost" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button variant="secondary" onClick={onAppend}>
            {t('taskWorkbench.appendDraft')}
          </Button>
          <Button onClick={onReplace}>{t('taskWorkbench.replaceDraft')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
