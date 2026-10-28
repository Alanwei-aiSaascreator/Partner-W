import { isRelaySearchPluginInstalled } from './relay-search-plugin.js';

/**
 * 「本机运行时能提供联网搜索」的可用性判据（relay 接线的接线闸）。
 *
 * ## 2026-10-12 语义变更（联网搜索接入批）
 *
 * 历史（2026-10-07–10-12，BUG-033 降级期）：判**随包 duckduckgo 扩展**的身份指纹
 *（`node_modules/openclaw/dist/extensions/duckduckgo` 的 package.json/manifest 逐项核对）。
 * 那时 DDG 是唯一可用的搜索 provider 面；DDG 反爬后它实际只剩"证明运行时捆了搜索能力"。
 *
 * 现在：可用面 = **我们自己的 provider 插件**（`runtime/relay-search-plugin.ts`，
 * 装在**状态目录**里、由 state-config 每次启动落盘、把查询转发到Partner-W relay）。
 * 判据跟着换成插件三件文件 + 清单外形的校验——入参也随之从 deployedRoot 换成 **stateDir**。
 *
 * ⚠️ 这个函数是"资源可接"的判断，不是"已接线"的判断：最终写配置的是
 *    `relay-config.ts`（还要活体 relay key + 用户开关都成立）。fail-closed 方向：
 *    这里 false ⇒ 一个字节都不接（工具在内核补丁下根本不出现）。
 */
export function hasInstalledSearchProvider(stateDir: string | null | undefined): boolean {
  return isRelaySearchPluginInstalled(stateDir);
}
