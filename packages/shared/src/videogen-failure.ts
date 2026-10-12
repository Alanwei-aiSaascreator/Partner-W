/**
 * **一份视频没生成出来**的形状（助手在回复里写了 ```` ```videogen ```` 块，
 * 但客户端没能把它变成一份可打开的 mp4）。
 *
 * ## 这条通道与 docgen/htmlgen 的本质差别：**要花钱、要等**
 *
 * docgen/htmlgen 的"渲染"在本机一秒内完成；视频是**远端付费异步任务**：
 * 创建即冻结额度（端脑侧）、生成以分钟计、只有轮询到终态才有文件。
 * 所以失败形状里有两类这个流程特有的：
 *   · `videogen-content-rejected` —— 上游内容安全拦截（端脑 ErrCode 70000，**零费**）。
 *     这条必须与普通失败**分开**：用户要做的动作不同（改提示词，而不是重试）。
 *   · `videogen-timeout` —— 等超时了。文件可能稍后才好；如实说"没有等到"，不假装失败也不假装成功。
 *
 * ⚠️ 与 `htmlgen-failure.ts` 同一个道理：定义在 shared 是**故意的** ——
 *    这个形状要跨 主进程 → IPC → 渲染层 三道边界，每层各写一遍必然漂移；
 *    文案在界面那一侧本地化（九种语言各一份），这里只放**码 + 数据**。
 */

export const VIDEOGEN_DURATION_MIN = 4;
export const VIDEOGEN_DURATION_MAX = 15;
export const VIDEOGEN_PROMPT_MAX_CHARS = 7000;

/** 与 relay 校验白名单逐字一致（`services/relay/src/video.ts`；改一处必须改另一处，有测试钉着）。 */
export const VIDEOGEN_RESOLUTIONS = ['768P', '2K'] as const;
export const VIDEOGEN_ASPECT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;

export type VideogenFailure =
  /** 块本身坏了（JSON 非法 / 不是对象 / 没闭合）——还没解析出想做什么，不带任何载荷。 */
  | { code: 'videogen-block-invalid' }
  /** `prompt` 缺失或空。视频必须有提示词，没有就不收。 */
  | { code: 'videogen-prompt-missing' }
  | { code: 'videogen-prompt-too-long'; maxChars: number }
  | { code: 'videogen-duration-invalid'; min: number; max: number }
  | { code: 'videogen-resolution-invalid'; allowed: readonly string[] }
  /** `aspectRatio` 不认识。`value` 是助手原样写的那串，文案里逐字回显。 */
  | { code: 'videogen-aspect-invalid'; allowed: readonly string[]; value: string }
  /**
   * 写了协议**没有的字段**（`imageUrl` / `firstFrame` / `videoUrl` / `model`……）。
   *
   * ⭐ 这条是"没接的能力不会静默丢弃"的执行点：P0 只做文生视频，`imageUrl` 这类
   *    参考素材字段**不在 schema 里** ⇒ 走到这里必然是"多写了"，而不是"我们忽略了它"。
   *    静默忽略会让用户以为图被用上了——明确拒收 + 逐字回显字段名才对得上账。
   */
  | { code: 'videogen-unsupported-field'; field: string }
  /** 中转未配置（未激活/拿不到 relay key）——不是内容问题，是环境问题。 */
  | { code: 'videogen-not-configured' }
  /** 创建任务被拒（HTTP 非 2xx）。 */
  | { code: 'videogen-create-failed'; httpStatus: number }
  /** 上游内容安全拦截（端脑 ErrCode 70000）：**零费**，改提示词再来。 */
  | { code: 'videogen-content-rejected' }
  /** 任务终态失败（非内容安全）。`upstreamCode` 是端脑 ErrCode（可能没有）。 */
  | { code: 'videogen-task-failed'; upstreamCode: number | null }
  /** 等超时（`waitedMs` 已等时长）。文件可能稍后才好——如实说没等到，不猜。 */
  | { code: 'videogen-timeout'; waitedMs: number }
  /** 文件下载失败（网络/上游文件已过期）。 */
  | { code: 'videogen-download-failed' }
  /** 落盘/登记失败（zip 门之外的 mp4 完整性门 + 写库）。 */
  | { code: 'videogen-save-failed' };
