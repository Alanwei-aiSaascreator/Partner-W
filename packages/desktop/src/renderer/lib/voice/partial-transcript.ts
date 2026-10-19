/**
 * 语音"实时逐字"的纯逻辑（2026-10-17）。
 *
 * 背景：relay 的 ASR 是 REST 批式 —— 整段 WAV 进、整段文字出，没有流式通道。
 * 真流式（DashScope paraformer-realtime / WebSocket）需要 relay 新增端点 + 新的计费通道，
 * 属于后端改动；在它落地之前，客户端用**增量分段**换实时性：
 *
 *   · 录音中每积累 ≥ 2.5s 新语音、且距上次 ≥ 1200ms，就把 [上次提交点-0.3s, 现在] 这一段
 *     单独送一次转写（0.3s 重叠用来避免切在字中间）；
 *   · 结果按序拼起来作为**预览**显示；松手后仍用整段音频做一次**权威**转写并替换。
 *
 * 代价（必须诚实）：每段各自按秒计费，一次 30s 录音大约花 1.4～2.4 倍的钱。
 * 所以这里的判据全部是纯函数 —— "什么时候花钱"能被单测钉死，不藏在副作用里。
 */

/** 需要攒够多少**新**语音才发下一段（秒）。 */
export const PARTIAL_MIN_NEW_SECONDS = 2.5;
/** 相邻两次分段的最小间隔（毫秒）—— 防止极短音频连发抢 relay 槽位。 */
export const PARTIAL_MIN_INTERVAL_MS = 1200;
/** 分段之间重叠多少秒（给模型上下文，避免切在字中间丢字）。 */
export const PARTIAL_OVERLAP_SECONDS = 0.3;

export interface PartialPlanInput {
  /** 当前累计样本数（整段录音）。 */
  sampleCount: number;
  /** 上一次已经送出去的那段音频的结束位置（绝对样本下标）。 */
  lastPartialSamples: number;
  sampleRate: number;
  nowMs: number;
  /** 上一次发分段的时刻（0 = 还没发过）。 */
  lastPartialAtMs: number;
  /** 是否已有一个分段请求在飞（串行化：一次只允许一个）。 */
  inFlight: boolean;
}

export function shouldEmitPartial(input: PartialPlanInput): boolean {
  if (input.inFlight) return false;
  const newSamples = input.sampleCount - input.lastPartialSamples;
  if (newSamples < input.sampleRate * PARTIAL_MIN_NEW_SECONDS) return false;
  if (input.lastPartialAtMs > 0 && input.nowMs - input.lastPartialAtMs < PARTIAL_MIN_INTERVAL_MS) return false;
  return true;
}

/** 本次分段要送的绝对样本区间（含重叠；`from` 不会为负）。 */
export function partialWindow(
  sampleCount: number,
  lastPartialSamples: number,
  sampleRate: number,
): { from: number; to: number } {
  const overlap = Math.round(sampleRate * PARTIAL_OVERLAP_SECONDS);
  return { from: Math.max(0, lastPartialSamples - overlap), to: sampleCount };
}

/** 按绝对样本下标跨 chunk 切片；越界自动钳制。 */
export function sliceSamples(chunks: readonly Float32Array[], from: number, to: number): Float32Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const start = Math.max(0, Math.min(Math.floor(from), total));
  const end = Math.max(start, Math.min(Math.floor(to), total));
  const out = new Float32Array(end - start);
  let offset = 0;
  let index = 0;
  for (const chunk of chunks) {
    const chunkStart = offset;
    const chunkEnd = offset + chunk.length;
    offset = chunkEnd;
    if (chunkEnd <= start) continue;
    if (chunkStart >= end) break;
    const sliceStart = Math.max(start, chunkStart) - chunkStart;
    const sliceEnd = Math.min(end, chunkEnd) - chunkStart;
    out.set(chunk.subarray(sliceStart, sliceEnd), index);
    index += sliceEnd - sliceStart;
  }
  return out;
}

const CJK = /[㐀-鿿豈-﫿]/;
const WORD_CHAR = /[A-Za-z0-9]/;
/** 边界去重最多看多少个字符（中文里够长了；英文按词处理）。 */
const MAX_OVERLAP_CHARS = 12;

/**
 * 拼接两段转写，消掉 0.3s 重叠造成的重复边界。
 *
 * 例：`今天天气不错` + `不错我们去公园` ⇒ `今天天气不错我们去公园`（"不错"只留一份）。
 * 没有重叠时：中文直接拼，西文之间补一个空格。
 */
export function appendTranscript(left: string, right: string): string {
  const a = left.trimEnd();
  const b = right.trimStart();
  if (!a) return b;
  if (!b) return a;

  for (let size = Math.min(MAX_OVERLAP_CHARS, a.length, b.length); size >= 1; size--) {
    if (a.slice(-size) === b.slice(0, size)) {
      // 纯空白或纯标点的"重叠"不算重叠（否则会把句号吃掉）。
      if (!WORD_CHAR.test(a.slice(-size)) && !CJK.test(a.slice(-size))) continue;
      return a + b.slice(size);
    }
  }

  const needsSpace = WORD_CHAR.test(a.slice(-1)) && WORD_CHAR.test(b.slice(0, 1));
  return needsSpace ? `${a} ${b}` : a + b;
}
