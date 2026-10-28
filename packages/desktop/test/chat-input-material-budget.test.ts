import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_PAYLOAD_BYTES,
  MAX_SEND_MATERIAL_BYTES,
  MAX_SEND_MATERIAL_COUNT,
  SEND_FRAME_RESERVE_BYTES,
  deriveMaterialByteBudget,
  materialBudgetMb,
} from '../src/renderer/components/ChatInput/constants';

/**
 * 发送字节预算的**换算本身**（2026-10-07 · 质量战役区 2 · P1-1）。
 *
 * 口径：预算（按文件原始字节）= 单帧上限 × 3/4 − 余量，因为二进制附件走 base64
 * 会膨胀 4/3 —— 按原始字节对着 25MB 判等于暗中放行 33MB 的帧，真撞上限时死在
 * WS 层（1009 断连）而不是一句能看懂的提示。
 */
describe('deriveMaterialByteBudget（base64 折算预算）', () => {
  it('默认 25MiB 单帧 ⇒ 恰好 18MiB 材料预算（25×3/4 − 0.75）', () => {
    expect(DEFAULT_MAX_PAYLOAD_BYTES).toBe(25 * 1024 * 1024);
    expect(SEND_FRAME_RESERVE_BYTES).toBe(768 * 1024);
    expect(deriveMaterialByteBudget()).toBe(18 * 1024 * 1024);
    expect(MAX_SEND_MATERIAL_BYTES).toBe(18 * 1024 * 1024);
    expect(materialBudgetMb(MAX_SEND_MATERIAL_BYTES)).toBe(18);
  });

  it('跟随网关协商值（hello-ok.policy.maxPayload）', () => {
    expect(deriveMaterialByteBudget(25 * 1024 * 1024)).toBe(18 * 1024 * 1024);
    // 8MiB 单帧 ⇒ 6MiB − 0.75MiB = 5.25MiB
    expect(deriveMaterialByteBudget(8 * 1024 * 1024)).toBe(6 * 1024 * 1024 - SEND_FRAME_RESERVE_BYTES);
    expect(deriveMaterialByteBudget(50 * 1024 * 1024)).toBe(
      Math.floor(50 * 0.75 * 1024 * 1024) - SEND_FRAME_RESERVE_BYTES,
    );
  });

  it('非法协商值一律回落默认（不猜、不放大到 0/无限）', () => {
    for (const invalid of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deriveMaterialByteBudget(invalid as number | undefined), String(invalid)).toBe(18 * 1024 * 1024);
    }
  });

  it('计数上限 30 与报告口径一致（旧 10 无任何依据可查）', () => {
    expect(MAX_SEND_MATERIAL_COUNT).toBe(30);
  });
});
