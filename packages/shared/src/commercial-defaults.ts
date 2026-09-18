/**
 * 商业后端的**生产默认凭据**（唯一真源）与读取期兜底。
 *
 * ## 为什么要有这个文件（2026-09-18 干净机器没有登录界面）
 *
 * 凭据以前**只**从 `clawwork-config.json` 的 `commercial` 段读。干净机器上那段
 * 必然是空的 ⇒ `getCommercialClient()` 返回 null ⇒ 渲染层判定"未配置"、直接进
 * 本地模式 —— 屏幕上根本没有登录页。而开发机之所以一直正常，是因为配置文件是
 * 彩排时手工塞进去的：**每场彩排都把这个洞盖住了**。
 *
 * 修法是把默认值**随包下发**、在读取期兜底：config 里非空的字段优先（用户/测试
 * 可以覆盖），空的回落到这里。这样安装包与 U 盘两种形态都不用再依赖"有人先写过配置"。
 *
 * ⚠️ 这里只允许放 **anon key**：它是设计上就对公众公开的客户端密钥（数据由 RLS
 *    保护），随包下发符合本项目"不许用 service_role"的纪律 —— service_role 能绕过
 *    RLS，一旦进客户端就是彻底的越权。`test/commercial-config.test.ts` 会解析
 *    JWT 的 `role` 段把这条钉死。
 */
export const DEFAULT_COMMERCIAL_SUPABASE_URL = 'https://qiprqsdfolcffjawkrsm.supabase.co';

/** 生产项目的 anon（公开）key。**不是** service_role —— 见文件头说明。 */
export const DEFAULT_COMMERCIAL_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFpcHJxc2Rmb2xjZmZqYXdrcnNtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1MDc1OTAsImV4cCI6MjEwNDA4MzU5MH0.b-eOfe6Zl_3ZshW5J0xjjsHDp7ZmH2QIbKqHxebLRwU';

/**
 * 生效的商业凭据 = 用户配置里非空的字段，逐字段回落到生产默认值。
 *
 * 逐字段（而不是"两个都填了才认"）是刻意的：用户填了 url 却没填 key 这种半配置
 * 只可能来自手工改文件，让它落到明显跑不通的状态、报错报在脸上，好过静默无视
 * 用户填的 url 去连生产库。同理，这里**不写回** config —— 默认值必须始终是
 * "读取期的一层"，一旦被某个写回路径烤进用户文件里，将来换 key 就再也下发不到
 * 那台机器了（本文件顶上的事故就是这么来的）。
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
