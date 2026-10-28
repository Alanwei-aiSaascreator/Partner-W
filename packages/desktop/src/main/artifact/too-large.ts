/**
 * "朴素读法"（`artifact:read-file`）的上限，以及"超限"这件事的**类型**。
 *
 * ## 为什么要单独一个文件
 *
 * 上限是在 `access.ts` 里判的（那里才知道**磁盘上的真实大小**），而**要用**这个判断的是
 * IPC handler（它决定回什么形状给界面）。两边跨了模块，于是要么共享一个常量，
 * 要么各写一份 —— 后者迟早只改一处，而症状是"界面上说 4 MB 不能再大，主进程其实放行到 40 MB"。
 *
 * 三个更差的方案：
 *  1. **比字符串**（`error.message === 'artifact too large'`）—— 改一个字就静默失效，
 *     而失效的表现是"界面又去读整份几十兆的文件"，不是一条报错。
 *  2. **把类/常量放在 `access.ts` 里** —— `artifact-handlers.test.ts` 整个 mock 掉了
 *     `artifact/access.js`（它只关心 handler 怎么反应，不关心文件怎么读）。东西跟着被 mock 掉，
 *     `instanceof undefined` 直接抛 TypeError，而**测试的 mock 边界不该决定产品代码的形状**。
 *  3. **放在 handler 文件里** —— 那个文件 import 了 electron，测试静态 import 它会撞上
 *     mock 工厂的 TDZ（`Cannot access 'showSaveDialogMock' before initialization`），
 *     于是"上限是多少"这个被测对象只能靠动态 import 在测试体里捞。
 *
 * 所以：一个不碰文件系统、也不碰 electron 的小模块，谁都能 import。
 */

/** 磁盘上的真实字节数（不是库里记的那个，库里的可能已经过期）。 */
export class ArtifactTooLargeError extends Error {
  readonly size: number;

  constructor(size: number) {
    super('artifact too large');
    this.name = 'ArtifactTooLargeError';
    this.size = size;
  }
}

/**
 * `artifact:read-file` 读**文本**时的上限（原来是**没有上限**的）。
 *
 * ## 为什么这条必须有
 *
 * 这条路上的内容会整份变成字符串、跨 IPC 搬到渲染进程，再整份进 `hljs.highlight` ——
 * 那是**同步**的。所以几十兆的文件不是"画得慢"，是**界面直接卡死**，
 * 而这条恰好是"富预览放弃之后"的兜底路（`.html` 超过 `MAX_HTML_PREVIEW_BYTES` 就掉到这里），
 * 于是"文件大"这个最常见的触发条件正好走在最没保护的一条路上。
 *
 * ⚠️ 定成 4 MiB 是**刻意与 `MAX_HTML_PREVIEW_BYTES` 取同一个量级**：两者服务的是同一个
 *    "一份东西整块进界面"的场景，差一个数量级只会让"为什么 5 MB 反而能看"变成没人说得清的事。
 */
export const MAX_PLAIN_TEXT_SOURCE_BYTES = 4 * 1024 * 1024;

/**
 * `artifact:read-file` 读**二进制**（图片等）时的上限，**比文本那条松十倍**。
 *
 * ⚠️ 不能拿文本那条卡图片：手机照片动辄 3–8 MB，卡在 4 MB 会把**正常用法**挡在门外
 *    （用户拖一张照片进来看，界面说"太大"）。这里的上限只兜"失控的巨大文件"，
 *    量级对齐 `artifact-handlers.ts` 里的 `MAX_PREVIEW_SOURCE_BYTES`。
 */
export const MAX_PLAIN_BINARY_SOURCE_BYTES = 40 * 1024 * 1024;
