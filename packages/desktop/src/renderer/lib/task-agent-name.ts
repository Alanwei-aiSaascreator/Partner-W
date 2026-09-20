/**
 * 「这个任务的这个 agent 在界面上叫什么」—— 派活时写 `RoomPerformer.agentName`
 * **快照**那一刻要问的东西（T-a7 的**写入方那一半**）。
 *
 * ## 为什么要单独一个函数
 *
 * `RoomPerformer.agentName` 是"agent 从网关目录里消失之后**唯一**还记得的名字"
 * （目录是活的，快照是死的）。而**两个写入方都往里塞了裸 agentId**
 * （`useGatewayDispatcherSetup` 与 `room-store.verifyCandidates` 都是
 * `registerPerformerKey(taskId, key, agentId, agentId)`）⇒ 存量数据库里存的是
 * `rongying-tpl-78b62899`，而不是「爆款内容教练」。
 *
 * 展示层已经改成**目录优先**（`resolvePerformerAgentName`），所以用户现在看不到脏数据；
 * 这一半修的是**以后写进去的新数据**。
 *
 * ## 两步查找，查不到就返回 `undefined`
 *
 * 1. `taskId` → 网关：任务表里那一行（core 侧不认识网关目录，所以这一步在宿主做）；
 * 2. 目录里按 `agentId` 找到 `name`。
 *
 * ⚠️ 返回 `undefined` 是**正常路径**（任务还没落库、目录还没拉到、agent 被删了都会走到），
 * 调用方（`room-store`）会降级成裸 agentId —— 与今天的行为一样，不炸派活。
 *
 * ⚠️ 名字**空串不算找到**：`name: ''` 在目录里是可能的（网关侧缺字段），
 * 存进快照等于什么都没记。
 */
export function resolveTaskAgentName(params: {
  tasks: ReadonlyArray<{ id: string; gatewayId?: string }>;
  /** 网关目录（`uiStore.agentCatalogByGateway[gwId].agents`）。 */
  agentsForGateway: (gatewayId: string) => ReadonlyArray<{ id: string; name?: string }> | undefined;
  taskId: string;
  agentId: string;
}): string | undefined {
  const { tasks, agentsForGateway, taskId, agentId } = params;
  // ⚠️ 这里**只**挡空 agentId：空 id 去查目录是纯浪费，而且目录里真有可能有一行
  // `id: ''`（网关侧缺字段）⇒ 会拿一个看着像"找到了"的名字写进快照。
  // 空 taskId 不用单独挡 —— 任务表里查不到 `''`，走下面那条 not-found 路径。
  // （原先写成 `!taskId || !agentId`，但变异验证证明前半段**没有测试能证伪**：
  //   挡住它的是下面 `!gatewayId`，不是这一行。测不到的分支不留。）
  if (!agentId) return undefined;

  const gatewayId = tasks.find((task) => task.id === taskId)?.gatewayId;
  if (!gatewayId) return undefined;

  const name = agentsForGateway(gatewayId)?.find((agent) => agent.id === agentId)?.name;
  return name || undefined;
}
