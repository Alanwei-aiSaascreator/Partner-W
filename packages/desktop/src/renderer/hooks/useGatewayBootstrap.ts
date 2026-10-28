import { useEffect } from 'react';
import { useEnsembleSync } from './useEnsembleSync';
import { useGatewayDispatcherSetup } from './useGatewayDispatcherSetup';
import { useGatewayEventListeners } from './useGatewayEventListeners';
import { useTaskStore, useUiStore } from '../platform';

export { fetchAgentsForGateway } from './useGatewayDispatcherSetup';

export function useGatewayBootstrap(): void {
  const dispatcher = useGatewayDispatcherSetup();
  useGatewayEventListeners(dispatcher);
  useEnsembleSync();
  const activeTask = useTaskStore((state) => state.tasks.find((task) => task.id === state.activeTaskId));
  const gatewayStatus = useUiStore((state) => (activeTask ? state.gatewayStatusMap[activeTask.gatewayId] : undefined));

  useEffect(() => {
    if (!activeTask || gatewayStatus !== 'connected') return;
    void dispatcher.fetchEffectiveTools(activeTask.gatewayId, activeTask.sessionKey);
  }, [activeTask, dispatcher, gatewayStatus]);
}
