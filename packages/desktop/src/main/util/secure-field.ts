/**
 * 单字段的**落盘加密**（`safeStorage`，Windows 上是 DPAPI）。
 *
 * 为什么单独一个模块：`enc:` + base64 这套写法原先在 `workspace/config.ts` 与
 * `commercial/client.ts` 各抄了一份；设备身份再抄第三份就会漂移 —— 而这里漂移的
 * 代价是"某个文件悄悄变回明文"。规则收在**一份**实现里。
 *
 * ⚠️ 明文兜底是**刻意**的（与 `workspace/config.ts` 既有行为一致）：加密不可用时
 *    宁可明文也不要用户被挡在门外（老系统 / 受限环境）。代价是"加固没生效时没有
 *    明显失败信号"，所以调用方要自己决定要不要打日志。
 *
 * ⚠️ 与配置文件不同，这里的值是**整串**替换：调用方拿到的必须是能直接用的明文
 *    （签名要私钥、连网关要 token），所以解密失败要能表达"解不开"，不能悄悄给空串。
 */

import { safeStorage } from 'electron';

export const ENCRYPTED_PREFIX = 'enc:';

export function isEncryptedSecret(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/** 加密一个字段。加密不可用（或抛异常）时**原样返回**明文。 */
export function encryptSecret(value: string): string {
  if (!value) return value;
  // 幂等：已经带前缀的不再套一层（否则会解不开）
  if (isEncryptedSecret(value)) return value;
  if (!safeStorage.isEncryptionAvailable()) return value;
  try {
    return ENCRYPTED_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch (e) {
    console.error('safeStorage: encrypt failed, storing plaintext', e);
    return value;
  }
}

/**
 * 解密一个字段。
 *
 * - 不带 `enc:` 前缀 ⇒ 当成**加固前的明文**原样返回（加固不能把已配对的用户弄丢）；
 * - 带前缀但解不开（换了机器 / 换了 Windows 账户 / 密文被改）⇒ `null`，
 *   由调用方决定是**重新生成**还是**重新配对**。
 */
export function decryptSecret(value: string): string | null {
  if (!value) return value;
  if (!isEncryptedSecret(value)) return value;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64'));
  } catch {
    return null;
  }
}
