import { useStore } from 'zustand';
import type { Task } from '@clawwork/shared';
import { composer, ports, useTaskStore, useTeamStore, useUiStore, useMessageStore } from '../../platform';
import { useCommercialStore } from '../../stores/commercialStore';
import { evaluateCommercialSendAccess, quotaBlockCopy } from '../../lib/quota';
import { buildResponseLanguageContext } from '../../lib/response-language';
import { artifactFailureContext } from '../../lib/artifact-delivery-feedback';
import { buildArtifactsIndex } from '../../lib/artifact-index';
import { syncRun } from '../../lib/session-sync';
import { isThinkingSupported } from '../../components/ChatInput/thinking-levels';
import { canonicalModelRef } from '../../lib/team-model-ref';
import { toast } from '../../lib/toast';
import i18n from '../../i18n';
import { meetingCatalog } from './catalog';
import { createTeamMeetingController } from './controller';
import type { TeamMeetingState } from './store';

function validateTask(task: Task) {
  const ui = useUiStore.getState();
  const team = task.teamId ? useTeamStore.getState().teams[task.teamId] : undefined;
  const raw = ui.modelCatalogByGateway[task.gatewayId];
  if (
    !team ||
    team.gatewayId !== task.gatewayId ||
    ui.gatewayStatusMap[task.gatewayId] !== 'connected' ||
    !raw?.length ||
    ui.modelCatalogFailureByGateway[task.gatewayId]
  )
    throw new Error('Meeting gateway or catalog is unavailable');
  const catalog = meetingCatalog(team, ui.agentCatalogByGateway[task.gatewayId]?.agents ?? [], raw);
  if (
    !catalog.members.some((member) => member.agentId === task.agentId) ||
    !task.model ||
    !catalog.models.includes(task.model)
  )
    throw new Error('Meeting member or selected model is unavailable');
  const entry = raw.find((model) => canonicalModelRef(model) === task.model);
  if (task.thinkingLevel && !isThinkingSupported(entry, task.thinkingLevel))
    throw new Error('Meeting thinking level is unavailable for the selected model');
}

async function checkQuota(signal?: AbortSignal) {
  const commercial = useCommercialStore.getState();
  await (commercial.overview?.account ? commercial.refresh() : commercial.load());
  if (signal?.aborted) throw new Error('Meeting cancelled');
  const snapshot = useCommercialStore.getState();
  const access = evaluateCommercialSendAccess(snapshot.status, snapshot.overview);
  if (!access.allowed) throw new Error(i18n.t(quotaBlockCopy(access.reason).descKey));
  if (access.verdict.level === 'degrade') throw new Error(i18n.t('usage.degradeTitle'));
  if (access.verdict.level === 'warn')
    toast.warning(i18n.t('usage.warnToast', { percent: Math.round(access.verdict.usedPercent) }));
}

export const teamMeetingController = createTeamMeetingController({
  create: (input) => window.clawwork.createTeamMeeting(input),
  save: (input) => window.clawwork.saveTeamMeeting(input),
  list: () => window.clawwork.listTeamMeetings(),
  gateway: ports.gateway,
  send: (id, options) => composer.send(id, options),
  abort: async (task, receipt) => {
    const current = useTaskStore.getState().tasks.find((row) => row.id === task.id);
    if (current?.sessionKey !== task.sessionKey || current.gatewayId !== task.gatewayId) return undefined;
    const active = useMessageStore.getState().activeTurnBySession[task.sessionKey];
    if (receipt && (receipt.sessionKey !== task.sessionKey || (active?.runId && active.runId !== receipt.runId)))
      return undefined;
    return composer.abort(task.id);
  },
  syncRun,
  stageRequest: (stage) => i18n.t(`meeting.stage.${stage}`),
  registerTasks: (tasks) => useTaskStore.getState().registerPersistedTasks(tasks),
  getTask: (id) => useTaskStore.getState().tasks.find((task) => task.id === id),
  validateStart: async (input) => {
    input.tasks.forEach(validateTask);
    await checkQuota();
    input.tasks.forEach(validateTask);
  },
  preflight: async (task, signal) => {
    validateTask(task);
    await checkQuota(signal);
    validateTask(task);
  },
  context: async (task) => {
    const artifacts = await window.clawwork.listArtifacts();
    if (!artifacts.ok || !artifacts.result) throw new Error(artifacts.error ?? 'Artifact index unavailable');
    return [
      buildResponseLanguageContext(i18n.resolvedLanguage ?? i18n.language ?? 'zh-CN'),
      buildArtifactsIndex(artifacts.result, new Map(useTaskStore.getState().tasks.map((row) => [row.id, row.title])), {
        now: Date.now(),
        excludeTaskId: task.id,
        unknownTaskLabel: i18n.t('rightPanel.historyUnknownTask'),
      }),
      artifactFailureContext(useMessageStore.getState().messagesByTask[task.id] ?? [], task.sessionKey),
    ]
      .filter(Boolean)
      .join('\n\n');
  },
});

export const useTeamMeetingStore = <T>(selector: (state: TeamMeetingState) => T): T =>
  useStore(teamMeetingController.store, selector);
