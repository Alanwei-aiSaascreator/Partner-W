/**
 * 工作区所在**文件系统**的身份探测结果（主进程量、渲染层决定怎么说话）。
 *
 * 放在 shared 的理由与别的 DTO 一样：它跨 main → preload → renderer 三道边界，
 * 三个地方各抄一份字段名迟早会漂（`clawwork.d.ts` 里那些 import 就是这条规矩）。
 *
 * 背景：随包运行时的 `@openclaw/fs-safe` 对"零身份"（`dev === 0` 或 `ino === 0`）
 * 是 **fail-closed** —— 零值是 *unknown*，不是"还是我建的那个文件"的证明。
 * **FAT32 上 `dev` 恒为 0** ⇒ 助手读写工作区里的身份文件**必然**失败，
 * 表现是六个预置助手全部报 `unsafe workspace file`，而界面只会说"助手失败"。
 * 实测结论：FAT32 与 exFAT 都不满足随包 OpenClaw 的安全写入语义；产品只承诺 NTFS。
 */
export type WorkspaceFsIdentityState =
  /** 量到了非零身份：这块文件系统不会撞那条判据。 */
  | 'ok'
  /** 两次探测**都**量到零身份 ⇒ 就是 FAT32 那一类（助手必定读写失败）。 */
  | 'unsupported-identity'
  /** 探测文件都建不出来 ⇒ 只读盘 / 没权限 / 空间满（与文件系统类型是两件事）。 */
  | 'unwritable'
  /** 量到了但**不下结论**（两次结果不一致 = 偶发零值，或压根没量到）。 */
  | 'unknown';

export interface WorkspaceFsIdentity {
  state: WorkspaceFsIdentityState;
  /** 量到的 device id，十进制字符串（IPC 传不了 bigint）；没量到 = null。 */
  dev: string | null;
  /** 量到的 inode，同上。 */
  ino: string | null;
  /** 失败原因（给日志用；上屏的是渲染层那几句人话）。 */
  error?: string;
}
