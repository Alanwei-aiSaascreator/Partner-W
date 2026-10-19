/**
 * 视频画质档位（2026-10-17 用户要求）。
 *
 * 产品语义：
 *   · `standard` —— 默认档，MiniMax H3（便宜）；
 *   · `seedance` —— **高质量档**：豆包 Seedance 2.5，更贵、更清晰。
 *
 * 放在主进程而不是渲染层：视频请求是在**消息收尾**（主进程解析围栏）时才发起的，
 * 渲染层那一刻已经不在调用栈上了。UI 选择通过 IPC 同步到这里，进程内有效；
 * 渲染层用 localStorage 记住选择，下次启动时重新推一次。
 */
export type VideoQuality = 'standard' | 'seedance';

let current: VideoQuality = 'standard';

export function getVideoQuality(): VideoQuality {
  return current;
}

/** 只认这两个值，其它（含 undefined / 脏数据）一律回默认档 —— 不猜。 */
export function setVideoQuality(value: unknown): VideoQuality {
  current = value === 'seedance' ? 'seedance' : 'standard';
  return current;
}
