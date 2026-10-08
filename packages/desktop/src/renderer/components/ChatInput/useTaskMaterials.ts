import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { describeSendRefusal, UnknownAgentError } from '@clawwork/core';
import type { FileIndexEntry, ImportedTaskFile, TaskContextSource } from '@clawwork/shared';
import { toast } from '@/lib/toast';
import { describeImportRejections } from '@/lib/import-rejection-copy';
import { MAX_SEND_MATERIAL_BYTES, materialBudgetMb } from './constants';
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
          // ⭐ 2026-10-07（质量战役区 3 · 问题 6）：重载**走 mergeImported，不再整表替换**。
          //    整表替换会和在途导入竞态：列表 IPC 的响应可能早于导入完成，替换会把导入刚
          //    加进来的文件当场抹掉（而用户明明看到"已选"）。effect 头部本就把列表清空过，
          //    所以 merge 只会保留"这次加载期间新进的文件"——不会积累陈旧行。
          setImportedFiles((current) => mergeImported(current, fileResult.result ?? [], nextTaskId));
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
      toast.error(describeSendRefusal(error, t));
      return null;
    }
    previousRequestedTaskIdRef.current = created.id;
    identityRef.current = created.id;
    generationRef.current += 1;
    setTaskId(created.id);
    return created.id;
  }, [resolveCurrentTaskId, t]);

  /**
   * 导入的**共享后段**：目标任务解析、代际守卫、合并选中、失败/部分拒绝文案。
   *
   * 两条进料口（对话框选文件 / 拖入绝对路径）只在"怎么拿到文件列表"上不同，
   * 拿到之后逐字同一条路 —— 拒绝原因、选中语义、换任务中的守卫都不许各写一份。
   */
  const runImport = useCallback(
    async (
      fetchImport: (targetTaskId: string) => ReturnType<typeof window.clawwork.importTaskFiles>,
    ): Promise<ImportedTaskFile[]> => {
      const targetTaskId = ensureTaskId();
      if (!targetTaskId) return [];
      const generation = generationRef.current;
      try {
        const result = await fetchImport(targetTaskId);
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
          // ⚠️ 别只说"有 N 个没能添加"：`rejected` 里带着**文件名与原因**，
          //    丢掉它们，用户就只能得出"无法操作"（2026-09-24 同事的真机反馈）。
          toast.warning(t('chatInput.importFilesPartiallyRejected', { count: result.result.rejected.length }), {
            description: describeImportRejections(result.result.rejected, t),
          });
        }
        // ⭐ P2-2（2026-10-07）：导入侧放行 100MB、发送侧预算 18MiB —— 收得下但发不出的
        //    文件必须在**进来这一刻**点破（只提示、不拦截：用户可以先挑别的再发）。
        //    预算取默认值（网关协商值在 store 里，本函数不读 store；差异只在"网关被配得
        //    更宽/更窄"时，提示偏保守不拦人）。
        const overSendBudget = imported.filter((file) => file.size > MAX_SEND_MATERIAL_BYTES);
        if (overSendBudget.length > 0) {
          toast.warning(t('chatInput.materialSingleTooLarge', { size: materialBudgetMb(MAX_SEND_MATERIAL_BYTES) }), {
            description: overSendBudget.map((file) => file.fileName).join('、'),
          });
        }
        return imported;
      } catch (error) {
        if (!isCurrent(targetTaskId, generation)) return [];
        toast.error(t('chatInput.importFilesFailed'), {
          description: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
    [ensureTaskId, isCurrent, t],
  );

  const importFiles = useCallback(
    // `purpose: 'images'` = 「识别图片」入口（C 组 BUG-027）：主进程只把对话框的可选范围
    // 缩到图片；导入后段（拒绝原因 / 选中 / 跨任务守卫）与普通入口逐字同一条。
    // ⚠️ 不传 purpose 时**调用形状与从前逐字一致**（两个参数都不补）—— 补 undefined 会改掉
    //    IPC 参数形状，存量契约（含既有用例）没必要跟着变。
    (purpose?: 'files' | 'images') =>
      runImport((targetTaskId) =>
        purpose
          ? window.clawwork.importTaskFiles(targetTaskId, undefined, purpose)
          : window.clawwork.importTaskFiles(targetTaskId),
      ),
    [runImport],
  );

  /** 拖入路径的入口（T05）：与 `importFiles` 共享同一条导入后段，只是不弹对话框。 */
  const importFilesFromPaths = useCallback(
    (filePaths: string[]) => runImport((targetTaskId) => window.clawwork.importTaskFiles(targetTaskId, filePaths)),
    [runImport],
  );

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

  /**
   * 「从当前对话移除」（BUG-029）—— 把这份材料移出**当前对话的引用集合**。
   *
   * 与 `toggleImportedFile` 的区别（为什么不能复用开关）：
   *   - 移除是**幂等**的：点了就是"不在本次请求里"，再渲染一次也不会翻回来；
   *   - 语义只在"引用"这一层：`importedFiles` 一个字都不动（材料还在，用户随时能再引用），
   *     inbox 里的那份文件更没被碰（没有"删文件"这回事 —— 文案也不许这么写）。
   */
  const removeImportedFileReference = useCallback((localPath: string) => {
    setSelectedImportedPaths((current) => {
      if (!current.has(localPath)) return current;
      const next = new Set(current);
      next.delete(localPath);
      return next;
    });
  }, []);

  /**
   * 只保留前 `keepCount` 个**已选**导入材料（「只保留前 N 个」一键裁剪，2026-10-07 · 方案 D）。
   *
   * 顺序 = `importedFiles` 的列表顺序（与材料条展示一致，用户看到的"前 N 个"就是留下的
   * 前 N 个）；与 `removeImportedFileReference` 同一层语义 —— 只动**引用集合**，
   * `importedFiles` 与 inbox 原文件一个字都不碰。
   */
  const trimSelectedImportedFiles = useCallback(
    (keepCount: number) => {
      const keep = Math.max(0, Math.floor(keepCount));
      const selectedInOrder = importedFiles.filter(
        (file) => file.availability === 'available' && selectedImportedPaths.has(file.localPath),
      );
      const keepPaths = new Set(selectedInOrder.slice(0, keep).map((file) => file.localPath));
      setSelectedImportedPaths((current) => {
        const next = new Set([...current].filter((localPath) => keepPaths.has(localPath)));
        return next.size === current.size ? current : next;
      });
    },
    [importedFiles, selectedImportedPaths],
  );

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
    importFilesFromPaths,
    grantFolder,
    revokeSource,
    listSourceFiles,
    loadSourceFiles,
    toggleImportedFile,
    removeImportedFileReference,
    trimSelectedImportedFiles,
    clearSelectedImportedFiles,
    markImportedFileMissing,
  };
}
