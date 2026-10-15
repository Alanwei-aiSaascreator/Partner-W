import { createHash, randomUUID } from 'node:crypto';
import { getSqlite } from '../db/index.js';
import type { VideogenRequest } from './request.js';

/**
 * 视频生成请求的**稳定逻辑身份**（R8-06 返工，2026-10-15）。
 *
 * ## 为什么必须有它（r8 独立终审 VV-2）
 *
 * Seedance 是**远端付费异步任务**，relay 侧按 `requestId` 做幂等（同 id 重放 ⇒ 返回既有
 * 作业、不重发上游）。原生产入口只调 `client.create(request)`：JSON 里既没有 requestId，
 * 也没有首帧 —— 一次"创建请求发出去了但结果没回来"的重放就会变成**第二次付费创建**，
 * 而 relay 因为没有 id 连"这是同一次操作"都判不出来（终端终审实测
 * `seedance-request-id-required`）。
 *
 * ## 绑定字段（改这里 = 改"哪些请求算同一个操作"，付费边界随之改变）
 *
 * `v1 + taskId + model + prompt + duration + resolution + aspectRatio + 首帧字节 digest`
 *
 *  · **taskId**：同一个任务里的同一次请求才可能是"重放"；跨任务各自成操作。
 *  · **首帧字节 digest**（不是路径）：换图 = 换操作（审核要求"首帧字节 digest"入键）；
 *    只有 `firstFrameData` 已装载（= 真实受信字节）时才有值，装载失败根本不会走到这里。
 *  · **不含 messageId**：重试的形态是"用户再发一条消息"（`start.ts` 头注），把它算进键
 *    会让每次重试都换新 id = 重新付费，正是这条返工要修的东西。
 *
 * ## 持久化：`videogen_request_identities`（工作区 sqlite，见 `db/index.ts`）
 *
 * 一条操作一行：第一次创建**之前**铸一把 `randomUUID()` 存下来，之后同键一律读回同一把
 * —— 进程重启（重开库）后依然同 id。库未就绪时退化成"由操作键直接派生的确定性 id"：
 * 语义相同（同操作同 id、异操作异 id），只是没有审计行；不会退化成随机 id（那会重复付费）。
 */

/** 绑定字段的版本。改绑定字段必须 +1（老行仍按各自的键命中，不会串台）。 */
export const VIDEOGEN_OPERATION_KEY_VERSION = 1;

/**
 * 逻辑操作键：绑定字段的 sha256。**纯函数**（不碰 IO），所以测试能逐条钉住字段。
 */
export function videogenOperationKey(input: { taskId: string; request: VideogenRequest }): string {
  const firstFrame = input.request.firstFrameData;
  const firstFrameDigest = firstFrame
    ? createHash('sha256').update(Buffer.from(firstFrame.content, 'base64')).digest('hex')
    : '';
  return createHash('sha256')
    .update(
      JSON.stringify({
        v: VIDEOGEN_OPERATION_KEY_VERSION,
        taskId: input.taskId,
        model: input.request.model ?? 'minimax-h3',
        prompt: input.request.prompt,
        duration: input.request.duration,
        resolution: input.request.resolution,
        aspectRatio: input.request.aspectRatio,
        firstFrameDigest,
      }),
    )
    .digest('hex');
}

/** 库未就绪时的确定性 id（仍有界、可复现；relay 的 id 判据是 8..160 个 [a-zA-Z0-9:_-]）。 */
function derivedRequestId(operationKey: string): string {
  return `vgen-${operationKey.slice(0, 48)}`;
}

interface IdentityRow {
  request_id?: unknown;
}

/**
 * 解析（或首次铸造）这把操作的 requestId。
 *
 * 幂等：同操作重复调用返回同一把 id；不同操作各自不同。**不抛**——库存取失败按
 * "没有账本"处理（派生 id），让视频流程继续，同时由调用方如实记日志。
 */
export function resolveVideogenRequestId(input: { taskId: string; request: VideogenRequest }): string {
  const operationKey = videogenOperationKey(input);
  const sqlite = getSqlite();
  if (!sqlite) return derivedRequestId(operationKey);

  const read = (): string | null => {
    const row = sqlite
      .prepare('SELECT request_id FROM videogen_request_identities WHERE operation_key = ?')
      .get(operationKey) as IdentityRow | undefined;
    return typeof row?.request_id === 'string' && row.request_id ? row.request_id : null;
  };

  const existing = read();
  if (existing) return existing;

  // `INSERT OR IGNORE` + 回读：两个进程同时首铸时，先落库的那把是**唯一**答案
  // （各自返回自己那把会让"同操作两把 id"重新出现 = 重复付费的入口）。
  sqlite
    .prepare(
      'INSERT OR IGNORE INTO videogen_request_identities (operation_key, request_id, task_id, created_at) VALUES (?, ?, ?, ?)',
    )
    .run(operationKey, randomUUID(), input.taskId, new Date().toISOString());
  return read() ?? derivedRequestId(operationKey);
}
