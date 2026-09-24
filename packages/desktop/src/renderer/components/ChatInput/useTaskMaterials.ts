import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { UnknownAgentError } from '@clawwork/core';
import type { FileIndexEntry, ImportedTaskFile, TaskContextSource } from '@clawwork/shared';
import { toast } from '@/lib/toast';
import { useTaskStore } from '../../stores/taskStore';

export type ImportedMaterialFile = ImportedTaskFile & { taskId: string; availability: 'available' | 'missing' };

export type TaskContextFile = Omit<FileIndexEntry, 'absolutePath'> & {
  taskId: string;
  sourceId: string;
  sourceName: string;
};

function mergeImported(
  current: ImportedMaterialFile[],
  incoming: ImportedTaskFile[],
  taskId: string,
): ImportedMaterialFile[] {
  const byPath = new Map(current.map((file) => [file.localPath, file]));
  for (const file of incoming) byPath.set(file.localPath, { ...file, taskId, availability: 'available' });
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
  const sourceLoadSequence = useRef(0);
  const mountedRef = useRef(true);
  const identityRef = useRef<string | null>(requestedTaskId ?? null);
  const previousRequestedTaskIdRef = useRef<string | null>(requestedTaskId ?? null);
  const generationRef = useRef(0);
  if (previousRequestedTaskIdRef.current !== (requestedTaskId ?? null)) {
    previousRequestedTaskIdRef.current = requestedTaskId ?? null;
    identityRef.current = previousRequestedTaskIdRef.current;
    generationRef.current += 1;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  const isCurrent = useCallback(
    (targetTaskId: string, generation: number) =>
      mountedRef.current && identityRef.current === targetTaskId && generationRef.current === generation,
    [],
  );

  useEffect(() => {
    const nextTaskId = requestedTaskId ?? null;
    setTaskId(nextTaskId);
    setSources([]);
    setImportedFiles([]);
    setContextFiles([]);
    setSelectedImportedPaths(new Set());
    sourceLoadSequence.current += 1;
    const sequence = ++loadSequence.current;
    const generation = generationRef.current;
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
        if (loadSequence.current !== sequence || !isCurrent(nextTaskId, generation)) return;
        if (!sourceResult.ok || !fileResult.ok) {
          toast.error(t('chatInput.materialsLoadFailed'), {
            description: [sourceResult.error, fileResult.error].filter(Boolean).join('; '),
          });
          return;
        }
        setSources(sourceResult.result ?? []);
        if (fileResult.ok) {
          setImportedFiles(
            (fileResult.result ?? []).map((file) => ({ ...file, taskId: nextTaskId, availability: 'available' })),
          );
        }
      })
      .catch((error: unknown) => {
        if (loadSequence.current !== sequence || !isCurrent(nextTaskId, generation)) return;
        toast.error(t('chatInput.materialsLoadFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (loadSequence.current === sequence && isCurrent(nextTaskId, generation)) setLoading(false);
      });
  }, [requestedTaskId, t, isCurrent]);

  const resolveCurrentTaskId = useCallback(() => identityRef.current, []);

  /**
   * 拿（必要时先建）当前任务 id。**拒绝时返回 `null`**。
   *
   * ⚠️ 2026-09-24：`commitPendingTask` 现在会在「点名要的助手不在已加载的目录里」时拒绝
   * （见 core 的 `UnknownAgentError`）。这个函数在**两个调用点的 try 之外**被调，不在这里
   * 接住的话会逃成 unhandled rejection ⇒ 如实提示并返回 `null`，由调用点早退。
   * ⚠️ 只吞这一种：其它异常**照旧抛出去**，不改变既有行为。
   */
  const ensureTaskId = useCallback((): string | null => {
    const current = resolveCurrentTaskId();
    if (current) return current;
    let created: { id: string };
    try {
      created = useTaskStore.getState().commitPendingTask();
    } catch (error) {
      if (!(error instanceof UnknownAgentError)) throw error;
      toast.error(t('errors.agentMissing'));
      return null;
    }
    previousRequestedTaskIdRef.current = created.id;
    identityRef.current = created.id;
    generationRef.current += 1;
    setTaskId(created.id);
    return created.id;
  }, [resolveCurrentTaskId, t]);

  const importFiles = useCallback(async () => {
    const targetTaskId = ensureTaskId();
    if (!targetTaskId) return [];
    const generation = generationRef.current;
    try {
      const result = await window.clawwork.importTaskFiles(targetTaskId);
      if (!isCurrent(targetTaskId, generation)) return [];
      if (!result.ok || !result.result) {
        toast.error(t('chatInput.importFilesFailed'), { description: result.error });
        return [];
      }
      const imported = result.result.imported;
      setImportedFiles((current) => mergeImported(current, imported, targetTaskId));
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
      if (!isCurrent(targetTaskId, generation)) return [];
      toast.error(t('chatInput.importFilesFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }, [ensureTaskId, isCurrent, t]);

  const grantFolder = useCallback(async () => {
    const targetTaskId = ensureTaskId();
    if (!targetTaskId) return null;
    const generation = generationRef.current;
    try {
      const result = await window.clawwork.grantTaskContextFolder(targetTaskId);
      if (!isCurrent(targetTaskId, generation)) return null;
      if (!result.ok) {
        toast.error(t('chatInput.grantFolderFailed'), { description: result.error });
        return null;
      }
      if (result.result) {
        setSources((current) => [result.result!, ...current.filter((source) => source.id !== result.result!.id)]);
      }
      return result.result ?? null;
    } catch (error) {
      if (!isCurrent(targetTaskId, generation)) return null;
      toast.error(t('chatInput.grantFolderFailed'), {
        description: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }, [ensureTaskId, isCurrent, t]);

  const revokeSource = useCallback(
    async (sourceId: string) => {
      const targetTaskId = resolveCurrentTaskId();
      if (!targetTaskId) return false;
      const generation = generationRef.current;
      try {
        const result = await window.clawwork.revokeTaskContextSource(targetTaskId, sourceId);
        if (!isCurrent(targetTaskId, generation)) return false;
        if (!result.ok || !result.result) {
          toast.error(t('chatInput.revokeFolderFailed'), { description: result.error });
          return false;
        }
        setSources((current) => current.filter((source) => source.id !== sourceId));
        setContextFiles((current) => current.filter((file) => file.sourceId !== sourceId));
        return true;
      } catch (error) {
        if (!isCurrent(targetTaskId, generation)) return false;
        toast.error(t('chatInput.revokeFolderFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
    },
    [isCurrent, resolveCurrentTaskId, t],
  );

  const listSourceFiles = useCallback(
    async (sourceId: string, query?: string): Promise<TaskContextFile[]> => {
      const targetTaskId = resolveCurrentTaskId();
      if (!targetTaskId) return [];
      const generation = generationRef.current;
      const source = sources.find((item) => item.id === sourceId);
      try {
        const result = await window.clawwork.listTaskContextFiles(targetTaskId, sourceId, query);
        if (!isCurrent(targetTaskId, generation)) return [];
        if (!result.ok || !result.result) {
          toast.error(t('chatInput.materialsLoadFailed'), { description: result.error });
          return [];
        }
        return result.result.map(({ absolutePath: _absolutePath, ...file }) => ({
          ...file,
          taskId: targetTaskId,
          sourceId,
          sourceName: source?.displayName ?? '',
        }));
      } catch (error) {
        if (!isCurrent(targetTaskId, generation)) return [];
        toast.error(t('chatInput.materialsLoadFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
    [isCurrent, resolveCurrentTaskId, sources, t],
  );

  const loadSourceFiles = useCallback(
    async (query?: string) => {
      const targetTaskId = resolveCurrentTaskId();
      if (!targetTaskId) return [];
      const generation = generationRef.current;
      const sequence = ++sourceLoadSequence.current;
      const groups = await Promise.all(
        sources
          .filter((source) => source.availability === 'available')
          .map((source) => listSourceFiles(source.id, query)),
      );
      const files = groups.flat();
      if (sourceLoadSequence.current === sequence && isCurrent(targetTaskId, generation)) setContextFiles(files);
      return files;
    },
    [isCurrent, listSourceFiles, resolveCurrentTaskId, sources],
  );

  const toggleImportedFile = useCallback((localPath: string) => {
    setSelectedImportedPaths((current) => {
      const next = new Set(current);
      if (next.has(localPath)) next.delete(localPath);
      else next.add(localPath);
      return next;
    });
  }, []);

  const clearSelectedImportedFiles = useCallback((expectedTaskId?: string) => {
    if (!mountedRef.current || (expectedTaskId && identityRef.current !== expectedTaskId)) return;
    setSelectedImportedPaths(new Set());
  }, []);
  const markImportedFileMissing = useCallback((localPath: string, expectedTaskId?: string) => {
    if (!mountedRef.current || (expectedTaskId && identityRef.current !== expectedTaskId)) return;
    setImportedFiles((current) =>
      current.map((file) => (file.localPath === localPath ? { ...file, availability: 'missing' } : file)),
    );
  }, []);

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
