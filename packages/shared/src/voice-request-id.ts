/**
 * 语音请求身份（R8-05 / VV-1，2026-10-15 终审返工）。
 *
 * 为什么必须有：朗读与转写都是**按次计费**操作。身份（requestId）以前由 main 侧
 * `randomUUID()` 每次现生成 —— 一旦"供应商已成功、结算 COMMIT 了但 ACK 丢了"，
 * 用户从失败状态再点一次就会变成一个**全新的收费操作**，绕开 relay 的结果缓存
 * （120s）与 `relay_voice_requests(license_id, request_id)` 的幂等主键。
 *
 * 现在的契约：身份由发起方（renderer 的逻辑播放/录音操作）持有并逐层透传
 * （renderer → preload → main IPC → relay）。main 只校验形状，不改写、不重发；
 * 失败恢复沿用同一身份（relay 幂等回放或明确拒绝），绝不静默再付一次。
 *
 * 形状跟着 relay 的 `parseVoiceInput` 走：UUIDv4（version=4、variant∈[89ab]）。
 * 大小写不敏感（relay 侧统一 `toLowerCase()` 后再做键）。
 */
export const VOICE_REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isVoiceRequestId(value: unknown): value is string {
  return typeof value === 'string' && VOICE_REQUEST_ID_PATTERN.test(value);
}

/**
 * 把 128 位摘要（前 32 个十六进制字符）折成 UUIDv4 形状字符串。
 *
 * - 第 13 个十六进制位（第三组首位）固定为 `4`（版本位）；
 * - 第 17 位按 RFC 4122 取变体位 `[89ab]`（用摘要自身的半字节 % 4 选一个，保持确定性）。
 *
 * 折叠是**纯函数**：同一摘要永远得到同一身份 —— 这是"失败重试沿用原 ID"能成立的前提。
 */
export function voiceRequestIdFromDigest(hexDigest: string): string {
  if (!/^[0-9a-f]{32}/i.test(hexDigest)) throw new Error('voice-request-id-digest-invalid');
  const chars = hexDigest.slice(0, 32).toLowerCase().split('');
  chars[12] = '4';
  chars[16] = '89ab'[Number.parseInt(chars[16]!, 16) % 4]!;
  return `${chars.slice(0, 8).join('')}-${chars.slice(8, 12).join('')}-${chars.slice(12, 16).join('')}-${chars
    .slice(16, 20)
    .join('')}-${chars.slice(20, 32).join('')}`;
}
