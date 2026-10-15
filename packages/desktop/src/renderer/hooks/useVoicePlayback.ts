import { useCallback, useEffect, useRef, useState } from 'react';
import { createSpeechPlayback } from '@/lib/voice/speech-playback';
import {
  answerRevisionDigest,
  deriveVoiceSentenceRequestId,
  voicePlaybackTargetString,
  type VoicePlaybackIdentity,
} from '@/lib/voice/playback-identity';

export type VoicePlaybackPhase = 'idle' | 'preparing' | 'playing' | 'failed';

/** 每个播放目标记住"完整播完"次数；只保留最近几十条，避免随朗读次数无限增长。 */
const COMPLETED_PLAYBACK_LIMIT = 64;

/**
 * 朗读播放器（R8-05 / VV-1）。
 *
 * 请求身份**在这里派生并逐层透传**（renderer → preload → main IPC → relay），不再让
 * main 侧每次 `randomUUID()`：
 *  - 失败（如 `voice-settlement-pending`：供应商已成功、结算已 COMMIT 但 ACK 丢失）后
 *    保留 `phase='failed'` 的**明确可重试状态**，不进静默 idle；用户再点朗读同一回答时
 *    沿用**同一身份**重放 —— relay 幂等回放已存结果，不会让供应商再跑一次、再扣一次费；
 *  - 一个目标**完整播完**后再点朗读 = 用户明确发起的新合成 ⇒ 身份前进一代（新请求）；
 *  - 换账号 / 换任务 / 换会话 / 文本变更 ⇒ 绑定字段变化 ⇒ 必然换身份（旧账号结果不复用）。
 */
export function useVoicePlayback(scopeKey: string, identity: VoicePlaybackIdentity) {
  const [phase, setPhase] = useState<VoicePlaybackPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const context = useRef<AudioContext | null>(null);
  const source = useRef<AudioBufferSourceNode | null>(null);
  const finishPlayback = useRef<(() => void) | null>(null);
  const epoch = useRef(0);
  const running = useRef(false);
  /** 绑定字段的最新值：speak 在异步循环里执行，不能闭包首帧的 identity。 */
  const identityRef = useRef(identity);
  identityRef.current = identity;
  /** 本次播放冻结的绑定：中途换账号/换任务也不改本轮各分句的身份。 */
  const operation = useRef<{ target: VoicePlaybackIdentity; answerDigest: string } | null>(null);
  const completedPlaybacks = useRef(new Map<string, number>());
  const cancel = useCallback(() => {
    const node = source.current;
    source.current = null;
    if (node) {
      node.onended = null;
      try {
        node.stop();
        node.disconnect();
      } catch {}
    }
    finishPlayback.current?.();
    finishPlayback.current = null;
    const active = context.current;
    context.current = null;
    if (active) void active.close().catch(() => {});
    void window.clawwork.cancelVoice?.();
  }, []);
  const player = useRef<ReturnType<typeof createSpeechPlayback> | null>(null);
  if (!player.current)
    player.current = createSpeechPlayback({
      cancel,
      speak: async (text, sentenceIndex) => {
        setPhase('preparing');
        const frozen = operation.current;
        const target = frozen?.target ?? identityRef.current;
        const answerDigest = frozen?.answerDigest ?? (await answerRevisionDigest(text));
        const requestId = await deriveVoiceSentenceRequestId({
          target,
          answerDigest,
          completedPlaybacks: completedPlaybacks.current.get(voicePlaybackTargetString(target, answerDigest)) ?? 0,
          sentenceIndex,
          text,
        });
        const response = await window.clawwork.synthesizeSpeech(text, requestId);
        if (!response.ok || !response.result) throw new Error(response.error ?? 'voice-playback-failed');
        return response.result;
      },
      play: async (audio) => {
        const active = context.current;
        if (!active) return;
        const decoded = await active.decodeAudioData(audio.slice(0));
        if (context.current !== active) return;
        const node = active.createBufferSource();
        node.buffer = decoded;
        node.connect(active.destination);
        source.current = node;
        setPhase('playing');
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            try {
              node.stop();
            } catch {}
            reject(new Error('voice-timeout'));
          }, 120_000);
          const finish = () => {
            clearTimeout(timer);
            resolve();
          };
          finishPlayback.current = finish;
          node.onended = finish;
          try {
            node.start();
          } catch (error) {
            clearTimeout(timer);
            reject(error);
          }
        });
        if (source.current === node) {
          source.current = null;
          node.disconnect();
          finishPlayback.current = null;
        }
      },
    });
  const stop = useCallback(() => {
    running.current = false;
    epoch.current++;
    player.current?.stop();
    setPhase('idle');
  }, []);
  const start = useCallback(
    async (text: string) => {
      if (running.current) return;
      stop();
      running.current = true;
      const current = epoch.current;
      setError(null);
      let failed = false;
      try {
        // 绑定在点击那一刻冻结：本轮的每个分句、以及失败后的重试，都用同一套字段。
        const target: VoicePlaybackIdentity = { ...identityRef.current };
        const answerDigest = await answerRevisionDigest(text);
        if (current !== epoch.current) return;
        operation.current = { target, answerDigest };
        // Create/resume in the user gesture, before waiting for synthesis.
        const active = new AudioContext();
        context.current = active;
        await active.resume();
        if (current !== epoch.current) return;
        // The queue's initial stop invalidates old requests; keep this fresh audio context.
        context.current = null;
        const pending = player.current!.start(text);
        context.current = active;
        await pending;
        // 只有整轮播完（无失败、无打断）才记一次"完整播完"：
        // 失败/中断不算 ⇒ 下一次点击按"结果未知的恢复"沿用同一身份重放。
        if (current === epoch.current) {
          const key = voicePlaybackTargetString(target, answerDigest);
          const map = completedPlaybacks.current;
          map.set(key, (map.get(key) ?? 0) + 1);
          if (map.size > COMPLETED_PLAYBACK_LIMIT) map.delete(map.keys().next().value!);
        }
      } catch (failure) {
        const message = failure instanceof Error ? failure.message : 'voice-playback-failed';
        // 用户主动取消/切走的（voice-cancelled）不算"可重试失败"。
        if (message !== 'voice-cancelled') failed = true;
        if (current === epoch.current) setError(message);
      } finally {
        if (current === epoch.current) {
          running.current = false;
          cancel();
          setPhase(failed ? 'failed' : 'idle');
        }
      }
    },
    [cancel, stop],
  );
  useEffect(() => {
    stop();
    return stop;
  }, [scopeKey, stop]);
  return { phase, error, start, stop };
}
