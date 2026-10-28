import { useEffect, useState } from 'react';
import { FolderLock, FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export default function WorkspaceAccessSummary() {
  const { t } = useTranslation();
  const [workspacePath, setWorkspacePath] = useState('');

  useEffect(() => {
    let active = true;
    void window.clawwork.getWorkspacePath().then((path) => {
      if (active) setWorkspacePath(path ?? '');
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <section className="mx-6 mt-4 rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--accent-dim)] text-[var(--accent)]">
          <FolderLock size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="type-label text-[var(--text-primary)]">{t('fileBrowser.workspaceAccessTitle')}</h3>
          <p className="type-support mt-1 text-[var(--text-secondary)]">
            {t('fileBrowser.workspaceAccessDescription')}
          </p>
          {workspacePath && (
            <p className="type-mono-data mt-2 truncate rounded-md bg-[var(--bg-tertiary)] px-2 py-1 text-[var(--text-muted)]">
              {workspacePath}
            </p>
          )}
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => window.clawwork.openWorkspaceFolder()}>
          <FolderOpen size={14} />
          {t('fileBrowser.openWorkspace')}
        </Button>
      </div>
    </section>
  );
}
