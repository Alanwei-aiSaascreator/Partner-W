import { useCallback, useEffect, useRef } from 'react';
import type { IpcResult } from '@clawwork/shared';
import { SYSTEM_SESSION_BUSY } from '@clawwork/core';
import type { SystemSessionMessage, SystemSessionStatus } from '@clawwork/core';
import { useSystemSessionStore, systemSessionService } from '../platform';

interface UseSystemSessionReturn {
  status: SystemSessionStatus;
  messages: SystemSessionMessage[];
  error: string | null;
  start: (opts: {
    gatewayId: string;
    agentId: string;
    purpose: string;
    initialMessage?: string;
    /** 侧会话继承 agent 的模型；传它来指定一个当前可用的，避免继承到卡住的模型。 */
    model?: string;
  }) => Promise<IpcResult>;
  send: (content: string) => Promise<IpcResult>;
  end: () => Promise<void>;
}

export function useSystemSession(): UseSystemSessionReturn {
  const status = useSystemSessionStore((s) => s.status);
  const messages = useSystemSessionStore((s) => s.messages);
  const error = useSystemSessionStore((s) => s.error);
  const activeRef = useRef(false);

  const start = useCallback(
    async (opts: { gatewayId: string; agentId: string; purpose: string; initialMessage?: string; model?: string }) => {
      const res = await systemSessionService.start(opts);
      /**
       * ⚠️ 「我拥有这条会话」= 这次 start **没有**被 `SESSION_BUSY` 拒掉。
       *
       * 原来这里无条件置 `true`，于是：别的功能正占着会话时（目标分析 / AI 建助手），
       * 本组件 start 失败 → 卸载时的清理**会把别人那条会话 `end()` 掉**（2026-10-05 排查）。
       * 只有 BUSY 这一种失败是"会话不属于我"：其余失败（createSession/patchSession）
       * 服务自己已经关掉并删除了会话，置 true 只是让清理空跑一次，无害。
       */
      activeRef.current = res.errorCode !== SYSTEM_SESSION_BUSY;
      return res;
    },
    [],
  );

  const send = useCallback(async (content: string) => {
    return systemSessionService.send(content);
  }, []);

  const end = useCallback(async () => {
    activeRef.current = false;
    return systemSessionService.end();
  }, []);

  useEffect(() => {
    return () => {
      if (activeRef.current) {
        systemSessionService.end();
      }
    };
  }, []);

  return { status, messages, error, start, send, end };
}
