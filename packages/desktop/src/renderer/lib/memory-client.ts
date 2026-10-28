/**
 * 长期记忆的**渲染层类型出口**。
 *
 * ## 为什么单独一个文件
 *
 * 类型从 `window.clawwork` 的真签名反推（`Awaited` + `ReturnType`），**不复制**一份
 * 平行的接口 —— 副本一定会和 preload 漂移，而漂移的表现是"参数写错了但编译通过"。
 *
 * ⚠️ 换行/写法上的硬约束：`scripts/check-renderer-copy.mjs` 用正则扫 `layouts/Settings/**`
 *    里的 JSX 文案，`> Promise<`、`=> Foo<` 这类**泛型箭头**会被它误判成"没走 i18n 的裸文案"。
 *    把这些类型写在 `lib/` 下（不在扫描范围内）就没有这个问题，同时组件里只剩裸类型名。
 */

/** `memory:list` 的结果（已确认 + 待确认 + 已拒绝）。 */
export type MemorySnapshot = Awaited<ReturnType<typeof window.clawwork.memoryList>>;

/** 任何一次记忆改动（新增 / 删除 / 确认 / 拒绝）的结果。 */
export type MemoryMutation = Awaited<ReturnType<typeof window.clawwork.memoryCreate>>;

/** 一次改动的执行体：拿回执 → 如实反馈 → 需要时重读。 */
export type MemoryMutationAction = () => ReturnType<typeof window.clawwork.memoryCreate>;
