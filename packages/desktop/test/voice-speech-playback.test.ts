import { describe, expect, it, vi } from 'vitest';
import { createSpeechPlayback, speechBillingUnits, splitSpeechText } from '../src/renderer/lib/voice/speech-playback';
describe('bounded speech playback', () => {
  it('estimates provider billing units separately from the unicode input limit', () => {
    expect(speechBillingUnits('Partner-W语音测试。今天的验证码是七二九四。')).toBe(40);
    expect(speechBillingUnits('Hi, 你好🙂')).toBe(9);
  });
  it('preserves all text in unicode safe chunks and refuses unbounded answers', () => {
    const text = '😀'.repeat(601);
    const chunks = splitSpeechText(text);
    expect(chunks.join('')).toBe(text);
    expect(chunks.every((c) => Array.from(c).length <= 600)).toBe(true);
    expect(() => splitSpeechText('字'.repeat(6001))).toThrow('voice-answer-too-long');
  });
  it('drops late synthesis after stop before playing and never retries', async () => {
    let finish: ((audio: ArrayBuffer) => void) | undefined;
    const speak = vi.fn(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          finish = resolve;
        }),
    );
    const play = vi.fn(async () => {});
    const cancel = vi.fn();
    const p = createSpeechPlayback({ speak, play, cancel });
    const pending = p.start('hello');
    p.stop();
    finish?.(new ArrayBuffer(44));
    await pending;
    expect(play).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalled();
    expect(speak).toHaveBeenCalledTimes(1);
  });
  it('synthesizes and plays each paragraph in strict order', async () => {
    const order: string[] = [];
    const p = createSpeechPlayback({
      speak: async (text) => {
        order.push('s:' + text);
        return new ArrayBuffer(44);
      },
      play: async () => {
        order.push('p');
      },
      cancel: () => {},
    });
    await p.start('字'.repeat(601));
    expect(order.map((item) => item[0])).toEqual(['s', 'p', 's', 'p']);
  });
});
