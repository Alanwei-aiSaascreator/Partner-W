/**
 * 首次部署本机运行时（把盘上的运行环境准备到运行数据目录）的**进度** ——
 * 能过 IPC、能上界面的那一部分。
 *
 * 为什么要有这个类型：部署在慢盘上要几分钟（找盘 → 两次全量 sha256 → 解压四万个小文件
 * → 原子换入），而主进程**早就算得出**这些阶段，只是在最后一跳被丢掉了 ——
 * 用户看到的是一格不动的「本机服务启动」。
 *
 * ⚠️ 与 `RuntimeBootstrapStatus` 同一个纪律：**闭集**。形状里只有阶段与计数，
 *    **没有路径、没有文件名、没有原始错误文本** —— 这条通道要跨三道边界
 *    （主进程 → IPC → 渲染层），进得了截图与用户随手贴出来的对话。
 *
 * ⚠️ 定义在 shared 是**故意的**：形状要跨主进程 / preload / 渲染层，
 *    每一层各写一遍就会漂移（同 `RuntimeBootstrapStatus`）。
 */
export const DEPLOY_PROGRESS_PHASES = ['verify', 'extract', 'node', 'finalize', 'stalled'] as const;

export type DeployProgressPhase = (typeof DEPLOY_PROGRESS_PHASES)[number];

export interface RuntimeDeployProgress {
  /**
   * `verify` = 校验盘上那两份文件（两个 sha256）；
   * `extract` = 解压运行时本体（`done/total` 是**条目**数）；
   * `node` = 随行 Node 进缓存；
   * `finalize` = 原子换入（部署的最后一步，**到这一步就不再有"停滞"之说**）；
   * `stalled` = 倒计时里**没有新事件**（慢盘/卡住）—— 不是失败，**绝不中止**。
   */
  phase: DeployProgressPhase;
  done: number;
  total: number;
  /**
   * 这一轮部署**第一件**真实事件的时间（epoch 毫秒）。
   *
   * ⚠️ 它让界面可以说"从开始算起等了多久"，而不是"这块面板从出现算起" ——
   *    后者在"面板出现时部署已经跑了几十秒"的情况下就是一句假话。
   */
  startedAt: number;
}
