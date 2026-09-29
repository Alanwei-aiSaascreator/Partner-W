# 1.0.3 Release Blockers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 1.0.3 候选中五个已复现的 P1，保证设备身份、PPT 成本闸、技能探测、助手入口和网关路由不会在真实边界上误判或串线。

**Architecture:** 把算法与竞态判据收进现有纯函数/小型 helper，UI 入口只消费结构化结果。所有行为先以定向用例复现 RED，再做最小实现；每个独立修复单独提交，最后运行全量门禁。

**Tech Stack:** TypeScript、React 19、Zustand、Electron 34、Vitest、pnpm。

---

## 文件结构

- `packages/desktop/src/main/ws/device-identity.ts`：只接受 Ed25519 设备身份。
- `packages/desktop/test/device-identity-secure.test.ts`：RSA/EC 负例。
- `packages/shared/src/slidegen-failure.ts`：单 deck 与单消息累计页数预算的纯判据。
- `packages/desktop/src/main/slidegen/generate.ts`：先预检所有可求值 deck，再产生文件。
- `packages/desktop/test/slidegen-page-budget.test.ts`：累计预算边界。
- `packages/desktop/test/slidegen-message-budget.test.ts`：生成链在写文件前拒绝累计超限。
- `packages/desktop/src/renderer/layouts/SkillMarket/use-skill-verdicts.ts`：以任一完整成功为优先、全部结束后才失败。
- `packages/desktop/test/skill-market.test.tsx`：并发返回次序回归。
- `packages/desktop/src/renderer/lib/requested-agent.ts`：loading 时强制刷新一次的共用动作判据。
- `packages/desktop/src/renderer/layouts/IdentityCenter/index.tsx`：两个入口等待目录判定后才执行。
- `packages/desktop/src/renderer/hooks/useSelectRecommendedAssistant.ts`：推荐入口等待目录，并固定显式 gatewayId。
- `packages/desktop/src/renderer/layouts/MainArea/index.tsx`：把创建流程起点的 gatewayId 传到底。
- `packages/desktop/test/requested-agent.test.ts`、`identity-center.test.tsx`、`use-select-recommended-assistant.test.tsx`：loading、刷新与网关漂移回归。

### Task 1: 设备身份严格限定 Ed25519

**Files:**

- Modify: `packages/desktop/test/device-identity-secure.test.ts`
- Modify: `packages/desktop/src/main/ws/device-identity.ts`

- [ ] **Step 1: 写 RSA/EC 失败测试**

在设备身份轮换 describe 中增加：

```ts
it.each([
  ['RSA', () => generateKeyPairSync('rsa', { modulusLength: 2048 })],
  ['EC', () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' })],
])('⭐ 匹配的 %s 密钥对也必须拒绝（设备身份只允许 Ed25519）', (_name, createPair) => {
  const { publicKey, privateKey } = createPair();
  expect(
    isUsableIdentityPair(
      privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    ),
  ).toBe(false);
});
```

- [ ] **Step 2: 验证 RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/device-identity-secure.test.ts -t "匹配的 RSA / EC"`

Expected: RSA 与 EC 断言得到 `true`，测试失败。

- [ ] **Step 3: 写最小算法守卫**

在创建 `KeyObject` 后、签名之前加入：

```ts
if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519') {
  return false;
}
```

- [ ] **Step 4: 验证 GREEN 与整文件回归**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/device-identity-secure.test.ts`

Expected: 全文件通过，RSA/EC 被拒，原有 Ed25519 配对仍通过。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/main/ws/device-identity.ts packages/desktop/test/device-identity-secure.test.ts
git commit -m "fix(device): require Ed25519 identity keys"
```

### Task 2: PPT 单消息累计页数预检

**Files:**

- Modify: `packages/shared/src/slidegen-failure.ts`
- Modify: `packages/desktop/src/main/slidegen/generate.ts`
- Modify: `packages/desktop/test/slidegen-page-budget.test.ts`
- Create: `packages/desktop/test/slidegen-message-budget.test.ts`

- [ ] **Step 1: 写累计预算纯函数 RED**

在 `slidegen-page-budget.test.ts` 增加：

```ts
expect(messagePageBudgetFailure([80, 120])).toBeNull();
expect(messagePageBudgetFailure([120, 81])).toEqual({
  code: 'slidegen-too-many-pages',
  max: SLIDEGEN_MAX_PAGES,
  got: 201,
});
```

同时删除“100K 恢复上限”的断言与注释；真实 `HISTORY_MAX_CHARS` 是 `500_000`，页数闸只按渲染成本解释。

- [ ] **Step 2: 验证 RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/slidegen-page-budget.test.ts`

Expected: `messagePageBudgetFailure` 尚不存在，测试失败。

- [ ] **Step 3: 实现累计纯判据**

在 shared 中增加并导出：

```ts
export function messagePageBudgetFailure(pageCounts: readonly number[]): SlidegenFailure | null {
  return pageBudgetFailure(pageCounts.reduce((total, count) => total + count, 0));
}
```

- [ ] **Step 4: 写生成链预检 RED**

新测试通过 `vi.mock` 替换 `evaluateSlide`、`emitPageShapes`、`writeSlidePptx`、`saveArtifactFromBuffer`：两份 deck 分别返回 120 与 81 个假页面，调用 `generateSlidesFromMessage`，断言：

```ts
expect(result.failed).toContainEqual({ code: 'slidegen-too-many-pages', max: 200, got: 201 });
expect(writeSlidePptx).not.toHaveBeenCalled();
expect(saveArtifactFromBuffer).not.toHaveBeenCalled();
```

- [ ] **Step 5: 验证生成链 RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/slidegen-message-budget.test.ts`

Expected: 当前逐 deck 检查会进入写文件路径，断言失败。

- [ ] **Step 6: 先求值、再累计、最后生成**

把 `generateSlidesFromMessage` 分成两个阶段：

```ts
const evaluated: Array<{ deck: SlidegenDeck; pages: ReturnType<typeof evaluateSlide> }> = [];
for (const deck of decks) {
  try {
    evaluated.push({ deck, pages: evaluateSlide(deck.source) });
  } catch (error) {
    result.failed.push(failureFromError(error));
  }
}
const messageBudget = messagePageBudgetFailure(evaluated.map(({ pages }) => pages.length));
if (messageBudget) {
  result.failed.push(messageBudget);
  return result;
}
for (const { deck, pages } of evaluated) {
  // 保留现有 emit、写临时文件、保存产物、日志与逐 deck catch。
}
```

任何累计超限都必须发生在 `writeSlidePptx` 之前；单 deck 错误继续不影响其他可求值 deck。

- [ ] **Step 7: 验证 GREEN**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/slidegen-page-budget.test.ts test/slidegen-message-budget.test.ts test/slidegen.test.ts`

Expected: 全部通过。

- [ ] **Step 8: 提交**

```bash
git add packages/shared/src/slidegen-failure.ts packages/desktop/src/main/slidegen/generate.ts packages/desktop/test/slidegen-page-budget.test.ts packages/desktop/test/slidegen-message-budget.test.ts
git commit -m "fix(slidegen): enforce a per-message page budget"
```

### Task 3: 技能探测不让最后一次失败抢先结算

**Files:**

- Modify: `packages/desktop/test/skill-market.test.tsx`
- Modify: `packages/desktop/src/renderer/layouts/SkillMarket/use-skill-verdicts.ts`

- [ ] **Step 1: 写两个反向竞态 RED**

用 deferred promise 控制三次 RPC：第 3 次先失败或先返回缺项，第 1 次随后返回完整报告。推进假时钟到 1500ms，先完成第三次，再完成第一次，断言最终 verdict 为 `usable`，而不是 `unknown`。

- [ ] **Step 2: 验证 RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/skill-market.test.tsx -t "早先请求后成功"`

Expected: 当前 `index === lastIndex` 会提前 `settled=true`，完整成功被丢弃，测试失败。

- [ ] **Step 3: 用在途计数与最佳报告替代 index 结算**

保留 epoch 与总超时，替换 `appliedIndex/lastIndex`：

```ts
let pendingAttempts = RETRY_DELAYS_MS.length;
let settled = false;
let bestReport: SkillStatusReport | null = null;
let bestSeenCount = -1;

const completeAttempt = (): void => {
  pendingAttempts -= 1;
  if (pendingAttempts === 0 && !settled) finish('rpc-failed');
};
```

每个 attempt 在 `finally` 调用 `completeAttempt`。合法报告按 `wanted` 命中数更新 `bestReport`；任一报告集齐时立即成功、取消未发 timer；失败/缺项不得提前结算，也不得覆盖命中更多的报告。`finish` 使用 `bestReport`（若有）并设置 `settled=true`。

- [ ] **Step 4: 验证 GREEN**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/skill-market.test.tsx`

Expected: 新竞态与既有安装延迟、超时、epoch 用例全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/desktop/src/renderer/layouts/SkillMarket/use-skill-verdicts.ts packages/desktop/test/skill-market.test.tsx
git commit -m "fix(skills): settle probes after in-flight attempts"
```

### Task 4: loading 目录必须刷新后再执行助手动作

**Files:**

- Modify: `packages/desktop/src/renderer/lib/requested-agent.ts`
- Modify: `packages/desktop/test/requested-agent.test.ts`
- Modify: `packages/desktop/src/renderer/layouts/IdentityCenter/index.tsx`
- Modify: `packages/desktop/test/identity-center.test.tsx`

- [ ] **Step 1: 写动作判据 RED**

在 `requested-agent.test.ts` 增加 `resolveRequestedAgentForAction` 用例：初始 loading、刷新后 ok；初始 loading、刷新后 missing；刷新抛错；刷新后仍 loading。后两种必须返回 `unavailable`，任何一种都不得把 loading 当 ok。

- [ ] **Step 2: 验证 RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/requested-agent.test.ts`

Expected: helper 尚不存在，测试失败。

- [ ] **Step 3: 实现共用动作判据**

```ts
export type RequestedAgentActionState = 'ok' | 'missing' | 'unavailable';

export async function resolveRequestedAgentForAction(input: {
  requestedAgentId: string;
  readCatalog: () => { agents: readonly { id: string }[] } | undefined;
  refresh: () => Promise<void>;
}): Promise<RequestedAgentActionState> {
  const first = resolveRequestedAgent(input.requestedAgentId, input.readCatalog());
  if (first !== 'loading') return first;
  try {
    await input.refresh();
  } catch {
    return 'unavailable';
  }
  const refreshed = resolveRequestedAgent(input.requestedAgentId, input.readCatalog());
  return refreshed === 'loading' ? 'unavailable' : refreshed;
}
```

- [ ] **Step 4: 把 IdentityCenter 的旧 loading 对照改成 RED**

目录为空时点击客群卡和“用它开任务”，断言 `selectAgentSpy` 未调用、`pendingNewTask` 为 null。另加刷新成功后才继续的正向用例；用 mock 的 `fetchAgentsForGateway` 在 resolve 前更新对应 gateway 目录。

- [ ] **Step 5: 验证 IdentityCenter RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/identity-center.test.tsx -t "目录还没拉回来"`

Expected: 当前两个入口仍立即切换/开任务，测试失败。

- [ ] **Step 6: IdentityCenter 消费异步判据**

导入 `fetchAgentsForGateway` 和 `resolveRequestedAgentForAction`。将统一守卫改成 async；读取目录必须通过 `useUiStore.getState()` 获取刷新后的值。`missing` 保留现有 notice；`unavailable` 使用现有 `errors.failed` toast；只有 `ok` 才调用 `selectAgent/startNewTask`。`applyPersona`、`chooseGroup`、`startTaskWithAgent`、`onApply` 和 `onSave` 对应地 await。

- [ ] **Step 7: 验证 GREEN**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/requested-agent.test.ts test/identity-center.test.tsx`

Expected: 全部通过，loading 路径无提前副作用。

- [ ] **Step 8: 提交**

```bash
git add packages/desktop/src/renderer/lib/requested-agent.ts packages/desktop/test/requested-agent.test.ts packages/desktop/src/renderer/layouts/IdentityCenter/index.tsx packages/desktop/test/identity-center.test.tsx
git commit -m "fix(agents): wait for the catalog before routing"
```

### Task 5: 推荐/创建流程固定原始网关

**Files:**

- Modify: `packages/desktop/src/renderer/hooks/useSelectRecommendedAssistant.ts`
- Modify: `packages/desktop/src/renderer/layouts/MainArea/index.tsx`
- Modify: `packages/desktop/test/use-select-recommended-assistant.test.tsx`

- [ ] **Step 1: 把 loading 与网关漂移写成 RED**

修改测试 Probe，让 handler 接受 `(agentId, gatewayId)`。增加：

```ts
const captured = pick;
useUiStore.setState({ defaultGatewayId: 'gw-2' });
await captured('brand-new-agent', 'gw-1');
expect(useUiStore.getState().selectedAgentByGateway['gw-1']).toBe('brand-new-agent');
expect(useTaskStore.getState().pendingNewTask?.gatewayId).toBe('gw-1');
```

另把原“loading 照常切”改成：刷新完成前不切；刷新后包含目标才切；刷新失败不切。

- [ ] **Step 2: 验证 RED**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/use-select-recommended-assistant.test.tsx`

Expected: 当前 handler 不接收固定 gatewayId，且 loading 会立即执行，测试失败。

- [ ] **Step 3: Hook 强制接收 gatewayId 并复用动作判据**

返回签名改成：

```ts
(agentId: string, gatewayId: string) => Promise<boolean>;
```

不再读取 `state.defaultGatewayId`。用 `resolveRequestedAgentForAction` + `fetchAgentsForGateway(gatewayId, { force: true })`；`missing` 显示现有缺失提示，`unavailable` 显示 `errors.failed`；只有 ok 才对显式 gatewayId 调 `setSelectedAgent` 与 `setPending`。

- [ ] **Step 4: MainArea 从流程起点把 gatewayId 传到底**

推荐面板包装为：

```ts
const handleSelectRecommendedAssistant = useCallback(
  (agentId: string) => void selectRecommendedAssistant(agentId, defaultGatewayId),
  [defaultGatewayId, selectRecommendedAssistant],
);
```

创建流程开头保存 `const actionGatewayId = defaultGatewayId`，创建、强制刷新与最终选择全部使用它；最终选择必须 `await selectRecommendedAssistant(agentId, actionGatewayId)`。

- [ ] **Step 5: 验证 GREEN**

Run: `pnpm --filter @clawwork/desktop exec vitest run test/use-select-recommended-assistant.test.tsx test/assistant-task-workbench-flow.test.tsx`

Expected: 全部通过，切换默认网关不改变在途流程归属。

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/src/renderer/hooks/useSelectRecommendedAssistant.ts packages/desktop/src/renderer/layouts/MainArea/index.tsx packages/desktop/test/use-select-recommended-assistant.test.tsx
git commit -m "fix(agents): pin recommendation routing to its gateway"
```

### Task 6: 全量门禁与最终复核

**Files:**

- Verify all files changed by Tasks 1–5

- [ ] **Step 1: 定向回归**

Run:

```bash
pnpm --filter @clawwork/desktop exec vitest run \
  test/device-identity-secure.test.ts \
  test/slidegen-page-budget.test.ts \
  test/slidegen-message-budget.test.ts \
  test/skill-market.test.tsx \
  test/requested-agent.test.ts \
  test/identity-center.test.tsx \
  test/use-select-recommended-assistant.test.tsx
```

Expected: 全部通过、零失败。

- [ ] **Step 2: 类型、格式、空白与全量测试**

Run: `pnpm typecheck && pnpm typecheck:tests && pnpm format:check && git diff --check && pnpm test`

Expected: 全部 exit 0。运行测试时若本 worktree 的 Electron 二进制未独立安装，显式设置 `ELECTRON_OVERRIDE_DIST_PATH` 指向已验证的 `integration-103` Electron 34.5.8 目录；这只是依赖定位，不改变源码。

- [ ] **Step 3: Go 门禁**

Run: `pnpm check`

Expected: exit 0。若仍报告 `go is not recognized`，记录为宿主工具链缺失，并单独运行 `pnpm check` 中除 `check:portable-launcher` 外的所有门禁；不得把环境缺失描述成代码通过。

- [ ] **Step 4: 独立审查**

逐项确认：RSA/EC 拒绝；累计 201 页在任何文件落盘前拒绝；技能任一完整成功胜出；loading 零提前副作用；在途流程始终使用起始 gatewayId。

- [ ] **Step 5: 最终状态**

Run: `git status --short && git log --oneline f4423526..HEAD`

Expected: 工作树干净，只包含规格、计划和五项修复提交；不包含图标之外的资源变化，不包含打包产物。
