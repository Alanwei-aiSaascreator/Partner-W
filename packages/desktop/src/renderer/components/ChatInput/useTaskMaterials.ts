import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileIndexEntry, ImportedTaskFile, TaskContextSource } from '@clawwork/shared';
import { toast } from '@/lib/toast';
import { useTaskStore } from '../../stores/taskStore';

export type ImportedMaterialFile = ImportedTaskFile & { availability: 'available' | 'missing' };

export type TaskContextFile = Omit<FileIndexEntry, 'absolutePath'> & {
  sourceId: string;
  sourceName: string;
};

function mergeImported(current: ImportedMaterialFile[], incoming: ImportedTaskFile[]): ImportedMaterialFile[] {
  const byPath = new Map(current.map((file) => [file.localPath, file]));
  for (const file of incoming) byPath.set(file.localPath, { ...file, availability: 'available' });
  return [...byPath.values()];
}

export function useTaskMaterials(taskIdOverride?: string | null) {
  const { t } = useTranslation();
  const activeTaskId = useTaskStore((state) => state.activeTaskId);
  const requestedTaskId = taskIdOverride === undefined ? activeTaskId : taskIdOverride;
  const [taskId, setTaskId] = useState<string | null>(requestedTaskId ?? null);
  const [sources, setSources] = useState<TaskContextSource[]>([]);
  const [importedFiles, setImportedFiles] = useState<ImportedMaterialFile[]>([]);
  const [contextFiles, setContextFiles] = useState<TaskContextFile[]>([]);
  const [selectedImportedPaths, setSelectedImportedPaths] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const loadSequence = useRef(0);

  useEffect(() => {
    const nextTaskId = requestedTaskId ?? null;
    setTaskId(nextTaskId);
    setSources([]);
    setImportedFiles([]);
    setContextFiles([]);
    setSelectedImportedPaths(new Set());
    const sequence = ++loadSequence.current;
    if (!nextTaskId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    void Promise.all([
      window.clawwork.listTaskContextSources(nextTaskId),
      window.clawwork.listImportedTaskFiles(nextTaskId),
    ])
      .then(([sourceResult, fileResult]) => {
        if (loadSequence.current !== sequence) return;
        if (sourceResult.ok) setSources(sourceResult.result ?? []);
        if (fileResult.ok) {
          setImportedFiles((fileResult.result ?? []).map((file) => ({ ...file, availability: 'available' })));
        }
      })
      .catch((error: unknown) => {
        if (loadSequence.current !== sequence) return;
        toast.error(t('chatInput.materialsLoadFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (loadSequence.current === sequence) setLoading(false);
      });
  }, [requestedTaskId, t]);

  const ensureTaskId = useCallback(() => {
    const current = taskId ?? useTaskStore.getState().activeTaskId;
    if (current) return current;
    const created = useTaskStore.getState().commitPendingTask();
    setTaskId(created.id);
    return created.id;
  }, [taskId]);

  const importFiles = useCallback(async () => {
    try {
      const targetTaskId = ensureTaskId();
      const result = await window.clawwork.importTaskFiles(targetTaskId);
      if (!result.ok || !result.result) {
        toast.error(t('chatInput.importFilesFailed'), { description: result.error });
        return [];
      }
      const imported = result.result.imported;
      setImportedFiles((current) => mergeImported(current, imported));
      setSelectedImportedPaths((current) => {
        const next = new Set(current);
        for (const file of imported) next.add(file.localPath);
        return next;
      });
      if (result.result.rejected.length > 0) {
        toast.warning(t('chatInput.importFilesPartiallyRejected', { count: result.result.rejected.length }));
      }
      return imported;
    } catch (error) {
      toast.error(t('chatInput.importFilesFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }, [ensureTaskId, t]);

  const grantFolder = useCallback(async () => {
    try {
      const targetTaskId = ensureTaskId();
      const result = await window.clawwork.grantTaskContextFolder(targetTaskId);
      if (!result.ok) {
        toast.error(t('chatInput.grantFolderFailed'), { description: result.error });
        return null;
      }
      if (result.result) {
        setSources((current) => [result.result!, ...current.filter((source) => source.id !== result.result!.id)]);
      }
      return result.result ?? null;
    } catch (error) {
      toast.error(t('chatInput.grantFolderFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }, [ensureTaskId, t]);

  const revokeSource = useCallback(
    async (sourceId: string) => {
      if (!taskId) return false;
      const result = await window.clawwork.revokeTaskContextSource(taskId, sourceId);
      if (!result.ok || !result.result) {
        toast.error(t('chatInput.revokeFolderFailed'), { description: result.error });
        return false;
      }
      setSources((current) => current.filter((source) => source.id !== sourceId));
      return true;
    },
    [taskId, t],
  );

  const listSourceFiles = useCallback(
    async (sourceId: string, query?: string): Promise<TaskContextFile[]> => {
      if (!taskId) return [];
      const source = sources.find((item) => item.id === sourceId);
      const result = await window.clawwork.listTaskContextFiles(taskId, sourceId, query);
      if (!result.ok || !result.result) return [];
      return result.result.map(({ absolutePath: _absolutePath, ...file }) => ({
        ...file,
        sourceId,
        sourceName: source?.displayName ?? '',
      }));
    },
    [sources, taskId],
  );

  const loadSourceFiles = useCallback(
    async (query?: string) => {
      const groups = await Promise.all(
        sources
          .filter((source) => source.availability === 'available')
          .map((source) => listSourceFiles(source.id, query)),
      );
      const files = groups.flat();
      setContextFiles(files);
      return files;
    },
    [listSourceFiles, sources],
  );

  const toggleImportedFile = useCallback((localPath: string) => {
    setSelectedImportedPaths((current) => {
      const next = new Set(current);
      if (next.has(localPath)) next.delete(localPath);
      else next.add(localPath);
      return next;
    });
  }, []);

  const clearSelectedImportedFiles = useCallback(() => setSelectedImportedPaths(new Set()), []);
  const markImportedFileMissing = useCallback((localPath: string) => {
    setImportedFiles((current) =>
      current.map((file) => (file.localPath === localPath ? { ...file, availability: 'missing' } : file)),
    );
  }, []);

  useEffect(() => {
    const addFiles = () => void importFiles();
    const addFolder = () => void grantFolder();
    window.addEventListener('task-materials:add-files', addFiles);
    window.addEventListener('task-materials:add-folder', addFolder);
    return () => {
      window.removeEventListener('task-materials:add-files', addFiles);
      window.removeEventListener('task-materials:add-folder', addFolder);
    };
  }, [grantFolder, importFiles]);

  const selectedImportedFiles = importedFiles.filter(
    (file) => file.availability === 'available' && selectedImportedPaths.has(file.localPath),
  );

  return {
    taskId,
    sources,
    importedFiles,
    contextFiles,
    selectedImportedFiles,
    selectedImportedPaths,
    loading,
    importFiles,
    grantFolder,
    revokeSource,
    listSourceFiles,
    loadSourceFiles,
    toggleImportedFile,
    clearSelectedImportedFiles,
    markImportedFileMissing,
  };
}
