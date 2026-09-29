import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/renderer/layouts/MainArea/index.tsx', import.meta.url), 'utf8');

describe('MainArea 自定义助手动作固定网关', () => {
  it('在首个 await 之前捕获网关，并让创建、刷新、选择始终使用同一个快照', () => {
    const start = source.indexOf('const handleCreateCustomAssistant');
    const end = source.indexOf('const closeFilePreview', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const action = source.slice(start, end);
    const capture = action.indexOf('const actionGatewayId = defaultGatewayId;');
    const firstAwait = action.indexOf('await ');
    expect(capture).toBeGreaterThanOrEqual(0);
    expect(firstAwait).toBeGreaterThan(capture);
    expect(action).toContain('gatewayId: actionGatewayId');
    expect(action).toContain('fetchAgentsForGateway(actionGatewayId, { force: true })');
    expect(action).toContain('selectRecommendedAssistant(agentId, actionGatewayId)');
    expect(action).not.toContain('gatewayId: defaultGatewayId');
    expect(action).not.toContain('fetchAgentsForGateway(defaultGatewayId');
    expect(action).not.toContain('selectRecommendedAssistant(agentId, defaultGatewayId)');
  });
});
