import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IpcResult } from '@clawwork/shared';
import type { SystemSessionMessage, SystemSessionStatus } from '@clawwork/core';
import { useSystemSession } from '@/hooks/useSystemSession';
import { goalAnalysisVersion, type OnboardingProfile } from '@/lib/user-onboarding';
import {
  buildGoalAnalysisPrompt,
  loadGoalAnalysis,
  parseGoalAnalysis,
  saveGoalAnalysis,
  type GoalAnalysisResult,
  type GoalAnalysisStorage,
} from './goal-analysis';

export interface GoalAnalysisSession {
  status: SystemSessionStatus;
  messages: SystemSessionMessage[];
  error: string | null;
  start: (options: {
    gatewayId: string;
    agentId: string;
    purpose: string;
    initialMessage?: string;
  }) => Promise<IpcResult>;
  end: () => Promise<void>;
}

interface GoalAnalysisOptions {
  profile: OnboardingProfile;
  enabled: boolean;
  gatewayId: string;
  agentId: string;
  modelIds: readonly string[];
  storage?: GoalAnalysisStorage;
}

export type GoalAnalysisStatus = 'idle' | 'waiting' | 'analyzing' | 'ready' | 'error';

interface GoalAnalysisState {
  status: GoalAnalysisStatus;
  result: GoalAnalysisResult | null;
  error: string | null;
  retry: () => void;
}

const inFlightVersions = new Set<string>();

export function useGoalAnalysisWithSession(
  { profile, enabled, gatewayId, agentId, modelIds, storage = window.localStorage }: GoalAnalysisOptions,
  session: GoalAnalysisSession,
): GoalAnalysisState {
  const version = useMemo(() => goalAnalysisVersion(profile), [profile]);
  const stored = useMemo(() => loadGoalAnalysis(profile, storage), [profile, storage, version]);
  const [result, setResult] = useState<GoalAnalysisResult | null>(stored);
  const [status, setStatus] = useState<GoalAnalysisStatus>(() =>
    stored ? 'ready' : profile.customGoal.trim() ? 'waiting' : 'idle',
  );
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const activeVersionRef = useRef<string | null>(null);

  useEffect(() => {
    setResult(stored);
    setError(null);
    if (stored) setStatus('ready');
    else if (!profile.customGoal.trim()) setStatus('idle');
    else setStatus('waiting');
  }, [profile.customGoal, stored, version]);

  useEffect(() => {
    if (!profile.customGoal.trim() || stored) return;
    if (!enabled || !gatewayId) {
      setStatus('waiting');
      return;
    }

    activeVersionRef.current = version;
    setStatus('analyzing');
    if (inFlightVersions.has(version)) return;
    inFlightVersions.add(version);

    void session
      .start({
        gatewayId,
        agentId,
        purpose: 'goal-analysis',
        initialMessage: buildGoalAnalysisPrompt(profile, modelIds),
      })
      .then((response) => {
        if (response.ok) return;
        inFlightVersions.delete(version);
        setError(response.error ?? 'goal_analysis_failed');
        setStatus('error');
      })
      .catch((reason: unknown) => {
        inFlightVersions.delete(version);
        setError(reason instanceof Error ? reason.message : String(reason));
        setStatus('error');
      });
  }, [agentId, attempt, enabled, gatewayId, modelIds, profile, session, stored, version]);

  useEffect(() => {
    if (!activeVersionRef.current || status !== 'analyzing') return;
    if (session.error) {
      inFlightVersions.delete(activeVersionRef.current);
      setError(session.error);
      setStatus('error');
      return;
    }
    if (session.status !== 'active') return;
    const message = [...session.messages].reverse().find((item) => item.role === 'assistant');
    if (!message || !message.content.includes('```goal-analysis')) return;
    const parsed = parseGoalAnalysis(message.content);
    if (!parsed) {
      inFlightVersions.delete(activeVersionRef.current);
      setError('goal_analysis_invalid_response');
      setStatus('error');
      return;
    }
    saveGoalAnalysis(profile, parsed, storage);
    inFlightVersions.delete(activeVersionRef.current);
    setResult(parsed);
    setError(null);
    setStatus('ready');
    void session.end();
  }, [profile, session, status, storage]);

  const retry = useCallback(() => {
    inFlightVersions.delete(version);
    activeVersionRef.current = null;
    setError(null);
    setResult(null);
    setStatus('waiting');
    setAttempt((value) => value + 1);
  }, [version]);

  return { status, result, error, retry };
}

export function useGoalAnalysis(options: GoalAnalysisOptions): GoalAnalysisState {
  return useGoalAnalysisWithSession(options, useSystemSession());
}
