export function deriveQuotaDisplay(total: number, used: number) {
  const safeTotal = Number.isFinite(total) ? Math.max(0, total) : 0;
  const safeUsed = Number.isFinite(used) ? Math.max(0, used) : 0;
  const remaining = Math.max(0, safeTotal - safeUsed);
  const remainingPercent = safeTotal > 0 ? Math.min(100, (remaining / safeTotal) * 100) : 0;
  return { remaining, remainingPercent };
}

/**
 * **可用额**的唯一派生点（BUG-082 贯通收口，r14 返工）：
 *
 *     可用 = 额度 − 已用 − **预占**
 *
 * 三处展示 —— 账户页 `QuotaBar` / Dashboard「账户余额」卡 / 顶栏钱包 —— **共用这一份**，
 * 谁都不许再写第二遍 `quota − used`：held > 0 时那样算出来的数**偏高**，用户会在同一块屏
 * 上看到两个不同的可用额（实测 950.40 vs 1000.40）。这就是 held 没贯通到 UI 的同族缺陷。
 *
 * ⚠️ `held` 传 `readHeldView(license).micros`：口径不可判定时它是 0，但那种情况下调用方
 *    **本来就不许显示数字**（`readHeldView(license).unknown` 为真）—— 这里的 0 不会被
 *    当成"没有预占"上屏，两个判据各管一段，别把它们揉进一个函数里。
 */
export function deriveAvailableDisplay(quota: number, used: number, held: number) {
  return deriveQuotaDisplay(quota, used + held);
}

/** 判定预占所需的两个只增字段（`CommercialLicenseSummary` 的必读子集）。 */
export interface HeldReading {
  /** 预占口径**是否可判定**：`false` ⇒ 后端明确说读不全 hold 源。 */
  heldComplete?: boolean;
  /** 后端报的在途预占（微积分）。**只有真读到读数才有它**。 */
  tokenHeldMicros?: number;
}

export interface HeldView {
  /** 真读到的预占（微积分）；不可判定时为 0，只用于"是否另起一行/是否扣减"的判断。 */
  micros: number;
  /** 预占口径**不可判定**（后端明说，或这次根本没读到确定读数）。 */
  unknown: boolean;
}

/**
 * 预占（held）的**唯一读取口径**（BUG-082 续；r14 返工后三处界面共用）。
 *
 * 后端（relay `/v1/usage`）回两个只增字段，主进程透传到
 * `CommercialLicenseSummary`（见 `@clawwork/shared` 与 `main/commercial/license.ts`）：
 *   · `tokenHeldMicros` —— 三张媒体表在途预留之和（微积分）；
 *   · `heldComplete`    —— 这个口径**是否可判定**。
 *
 * 三种状态**必须分开**（本函数把它们折成 `HeldView`）：
 *   · 读到数值 + `heldComplete: true`  ⇒ 预占是确定值，可用 = 额度 − 已用 − 预占
 *     （数值为 0 也算确定：后端明确说了"没有预占"）；
 *   · `heldComplete: false`            ⇒ 不可判定（后端明确说读不全 hold 源）；
 *   · **读数缺省**（没有 `tokenHeldMicros`）⇒ **同样是不可判定** ——
 *     relay 不可达 / 网络失败 / 老后端不返回，客户端**分不出**是哪种，一律按未知。
 *
 * ⚠️ **绝不本地估算 hold**：任何按模型价目表推算的"预计扣费"都是在编造账目。
 * ⚠️ **绝不把"未知"当 0**（r14 返工）：旧实现把"读数缺省"当成"后端没报、沿用
 *    `quota − used` 旧口径"，于是 relay 返 503 时界面照样显示确定的 1,000.40 ——
 *    那是把"读不到"伪装成"确定没有预占"。**只有明确读到读数才敢给确定余额**，
 *    否则宁可显示"暂不可用"：同一块屏上账户页 / 顶栏 / Dashboard 必须同一口径，
 *    不能一个说"未知"、另一个照给数字（那比两边都保守更让用户困惑）。
 */
export function readHeldView(license: HeldReading | null | undefined): HeldView {
  if (!license) return { micros: 0, unknown: false };
  const raw = license.tokenHeldMicros;
  // "确定读到读数" = 有限非负数存在。除此之外（缺字段 / null / 负数 / NaN / 字符串）
  // 都是"没有确定读数" ⇒ 未知，不给确定余额。
  const hasReading = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0;
  const unknown = license.heldComplete === false || !hasReading;
  return { micros: unknown ? 0 : (raw as number), unknown };
}
