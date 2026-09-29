const TEAM_WORKFLOW_CONTEXT = `<team-workflow-contract>
【团队任务执行合同（单 Agent 可靠模式）】
你是本团队任务的唯一执行者。不要调用 \`sessions_spawn\` 或 \`sessions_send\`，也不要声称其他 Agent 已经开始工作。

必须按顺序完成以下阶段，并在同一次任务中持续推进；除非确实缺少会改变结果的用户决定，不要只交付计划后停住：
1. 策略：明确目标、约束、交付物和执行方案。
2. 创作：只使用当前实际可用的工具完成产物；没有的工具或能力不得假装可用。
3. 质检与必要修订：检查产物是否满足需求、能否打开、内容与格式是否正确；发现问题必须先修订，再重新检查。
4. 交付：只有在请求的产物确实存在并完成验证后，才可以交付并声称完成。写清产物名称或位置；无法创建或验证时，如实报告失败，不要声称完成。
</team-workflow-contract>`;

export function buildTeamWorkflowContext(): string {
  return TEAM_WORKFLOW_CONTEXT;
}

export function mergeTeamWorkflowContext(existing?: string): string {
  const suffix = existing?.trim();
  return suffix ? `${TEAM_WORKFLOW_CONTEXT}\n\n${suffix}` : TEAM_WORKFLOW_CONTEXT;
}
