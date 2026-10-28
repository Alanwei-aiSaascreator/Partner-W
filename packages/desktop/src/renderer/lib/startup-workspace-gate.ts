import type { WorkspaceFsIdentity } from '@clawwork/shared';

export interface WorkspaceGatedBootstrapDeps {
  probe: () => Promise<WorkspaceFsIdentity | null>;
  isCurrent?: () => boolean;
  bootstrapAssistants: () => Promise<unknown>;
  ensureSkills: () => Promise<unknown>;
  /**
   * 给主罗盘（agent `main`）写交付合同（IDENTITY/SOUL）。
   *
   * ⚠️ 它也是**工作区写入**，所以必须和另外两条一样待在这道文件系统能力闸后面 ——
   *    不支持的文件系统（FAT32 等）上写失败的原因在界面上长得像"产品坏了"，
   *    而闸门已经替我们挡掉了那类注定失败的写入。
   * ⚠️ 实现必须**永不抛**（这个 `Promise.all` 里没有 catch）：失败只能在内部记结果。
   */
  ensureMainContract: () => Promise<unknown>;
}

/**
 * The filesystem capability probe is the barrier in front of every automatic
 * workspace writer.  Keep this orchestration outside React so ordering and the
 * zero-write rejection path stay directly testable.
 */
export async function runWorkspaceGatedBootstrap(
  deps: WorkspaceGatedBootstrapDeps,
): Promise<WorkspaceFsIdentity | null> {
  if (deps.isCurrent?.() === false) return null;
  const identity = await deps.probe();
  if (deps.isCurrent?.() === false) return null;
  if (identity?.state !== 'ok') return identity;
  await Promise.all([deps.bootstrapAssistants(), deps.ensureSkills(), deps.ensureMainContract()]);
  return identity;
}
