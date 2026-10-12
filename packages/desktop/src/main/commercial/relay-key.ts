/**
 * 活体 relay key 的**内存持有者**（2026-10-12 视频接入）。
 *
 * ## 为什么需要它：网关配置里读不回真 key
 *
 * 视频生成（`main/videogen/`）从主进程直呼 relay，需要那把 relay key。
 * 第一版实现从 `gateway.getConfig()` 的快照里读 provider 的 `apiKey` ——
 * **错的**：网关的 `config.get` 对 apiKey 做**脱敏**，回读值是占位符
 * `__OPENCLAW_REDACTED__`（`relay-endpoint.test.ts` 的快照夹具里就有它）。
 * 真机实锤（2026-10-12）：视频创建带着这个占位符出站 → relay 401
 * `invalid relay key`，而 chat 一切正常（chat 走网关进程自己的配置内存，不经过 getConfig）。
 *
 * ## 语义与纪律
 *
 * - **只在内存**：不落盘、不进日志、不进 IPC。写点唯一 —— `applyRelayConfig`
 *   （激活与每轮启动 bootstrap 的公共漏斗），值就是那份刚写进网关的 key 本身；
 * - 进程重启后由启动期的 relay bootstrap 重新写入（激活流每一次都会经过它）；
 * - 读不到（null）= 中转未配置 → 调用方按 `videogen-not-configured` 如实上报，不猜。
 */

let activeRelayKey: string | null = null;

/** 设置当前生效的 relay key；`null`/空串 = 清除。调用方只该传刚写进网关的那把。 */
export function setActiveRelayKey(key: string | null | undefined): void {
  activeRelayKey = typeof key === 'string' && key.trim() ? key.trim() : null;
}

/** 当前生效的 relay key；没配到返回 null。⚠️ 返回值**不要**上日志 / 进 IPC。 */
export function getActiveRelayKey(): string | null {
  return activeRelayKey;
}
