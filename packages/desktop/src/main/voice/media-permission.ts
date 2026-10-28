/**
 * 麦克风权限的判据（纯函数，便于钉住）。
 *
 * ## 为什么从 `ipc/voice-handlers.ts` 抽出来
 *
 * 它原来是那个文件里的私有函数 ⇒ **没有单测守着**，外部审计（2026-09-20）就从中
 * 挑出一条：`mediaType === 'unknown'` 也放行（防御性不足）。抽出来之后这类判据
 * 才有地方钉。
 *
 * ## 判据（只认明确的 audio 信号）
 *
 * 1. `mediaTypes` 是数组时**以它为准**（Electron 在标准 `getUserMedia` 请求上会给它）：
 *    含 `'audio'` 才放行；
 * 2. 没有 `mediaTypes` 时看 `mediaType`，**只有显式 `'audio'`** 放行；
 * 3. 其余（`'video'` / `'unknown'` / 缺字段 / 连 details 都没有）一律拒绝。
 *
 * ⚠️ **入参写成 `unknown`**（不是窄接口）：Electron 那两个 handler 给过来的 `details` 是个
 *    **联合类型**（`MediaAccessPermissionRequest | OpenExternalPermissionRequest | …`），
 *    其中有些成员根本没有 `mediaTypes` —— 用窄接口接收会逼调用点写 `as`，而那正是审计
 *    这类判据最容易糊过去的地方。
 *
 * ⚠️ **`'unknown'` 不再放行**，依据是我们自己的录音路径只有一条
 *    （`renderer/lib/voice/whisper-stt.ts` 的 `getUserMedia({ audio: … })` ⇒
 *    `mediaTypes` 必然含 `'audio'`）。要放开它得先指认一条真的会走 `unknown` 的调用方。
 */
export function allowsAudioMedia(details: unknown): boolean {
  if (!details) return false;
  // ⚠️ 这里**不写** `typeof details !== 'object'` 那道形状校验：变异验证实测 M4
  //    （删掉它）**存活** —— 非对象入参在两种写法下都会走到下面两个分支并返回 false
  //    （原始类型上没有 `mediaTypes` / `mediaType`），也就是说那行**分辨不出任何东西**。
  //    测不到的防御不留（本仓库的纪律），要加就得先指认一条真的会崩的输入。
  const media = details as { mediaTypes?: unknown; mediaType?: unknown };
  if (Array.isArray(media.mediaTypes)) return media.mediaTypes.includes('audio');
  return media.mediaType === 'audio';
}
