/**
 * 商业后端的默认凭据（读取期兜底）。
 *
 * ## 私有化 / 开源版：默认**不内置**生产凭据（2026-10 私有化改造）
 *
 * 开源客户端默认进入**本地模式**：不强制登录、不校验 license、不发用量埋点。
 * 因此默认凭据清空（空串）⇒ `getCommercialClient()` 返回 null、渲染层判定
 * "未配置"直接进本地模式（无登录页），模型走 BYOK 或用户自配的官方 API。
 *
 * 需要接回商业后端时，在 `clawwork-config.json` 的 `commercial` 段填入
 * `supabaseUrl` / `supabaseAnonKey` 即可（`resolveCommercialCredentials` 非空优先）。
 *
 * ⚠️ 若将来恢复商业后端，这里只允许放 **anon key**（禁止 service_role）。
 */
export const DEFAULT_COMMERCIAL_SUPABASE_URL = '';

/** 私有化版默认不内置 anon key（空 = 本地模式）。 */
export const DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY = '';

/**
 * 生效的商业凭据 = 用户配置里非空的字段，逐字段回落到默认值。
 *
 * 私有化 / 开源版里默认值为空串：配置里没填商业段 ⇒ 返回空 ⇒ 本地模式
 * （无登录 / 无 license / 不发用量）。用户显式填了 `commercial` 段则优先用用户值。
 *
 * 逐字段（而不是"两个都填了才认"）是刻意的：用户填了 url 却没填 key 这种半配置
 * 只可能来自手工改文件，让它落到明显跑不通的状态、报错报在脸上，好过静默无视。
 * 同理，这里**不写回** config —— 默认值必须始终是"读取期的一层"。
 */
export function resolveCommercialCredentials(
  stored?: {
    supabaseUrl?: string;
    supabaseAnonKey?: string;
  } | null,
): { supabaseUrl: string; supabaseAnonKey: string } {
  return {
    supabaseUrl: stored?.supabaseUrl?.trim() || DEFAULT_COMMERCIAL_SUPABASE_URL,
    supabaseAnonKey: stored?.supabaseAnonKey?.trim() || DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY,
  };
}
