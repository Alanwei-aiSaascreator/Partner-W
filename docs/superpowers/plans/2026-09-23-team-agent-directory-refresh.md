# 团队安装后刷新助手目录（层 3）——实施与账本

**日期**：2026-09-23 · **分支**：`fix/team-agent-directory-refresh`（基线 `608882ff` = 发布线 `fix/local-credential-exposure` 当前指针）

## 症状与机制（沿用 2026-09-22 只读复核，line 当场重读过）

**用户可见**：建/装一个团队 → **不重启** → 打开团队点「发起对话」⇒ 出的是**主罗盘**。**重启就消失**。

**机制（层 3 = 本刀的病灶）**：全渲染层只有 **3 处** `force: true` 强刷助手目录
（[`useStartupReadiness.ts:30`](../src/renderer/hooks/useStartupReadiness.ts)、
[`MainArea/index.tsx:730`](../src/renderer/layouts/MainArea/index.tsx)、
[`useTemplateInstall.ts:44`](../src/renderer/layouts/MarketPanel/useTemplateInstall.ts)），
**团队安装路径一个都不在名单上** ⇒ 新 agent 只进了网关，客户端目录仍是陈旧的。

**下一层（层 2）是"静默换成 main"**：[`useGatewaySelector.ts:41-45`](../src/renderer/hooks/useGatewaySelector.ts)
把不在目录里的 id 换成默认值，用户**全程看不到提示**（那是另一个决定 D1/D2，**本刀不动**）。

## 改动（一处接线）

[`useTeamInstall.ts`](../src/renderer/layouts/TeamsPanel/useTeamInstall.ts)：

1. 新增模块级 `refreshAgentCatalog(gatewayId)`：**动态** `import('@/hooks/useGatewayDispatcherSetup')`
   - `fetchAgentsForGateway(gatewayId, { force: true })` + **catch 掉失败**。
   * ⚠️ 动态 import **照 `useTemplateInstall` 的先例**：静态引入会把整条网关链拖进每个 importer
     （那边注释里记着实测：两个只 mock 了 core/platform 的既有测试会直接加载失败）。
   * ⚠️ 失败**不许**把"装完了"变成"装失败"：目录最多陈旧，重启会补。
2. `runInstall` 收到 `done` 事件时**先 `await refreshAgentCatalog(...)`、再 `setInstallStatus('done')`**。
   - 顺序有含义：报"装完了"之前目录必须已新鲜，否则紧接着的「发起对话」照样会撞上陈旧目录。

**刻意不做**：`runUpdate` 不加（它要求每个 agent 都已有 `existingAgentId` ⇒ 不会产生新目录项）；
层 2 的静默替换、D1/D2/D4 全部未动；核心安装器（`core/team-installer.ts`）不加 `refreshAgents` 注入点
（渲染层一处接线就够，且不必动 core 的公开形状）。

## 链子三个环各自的钉子（这是"用户可见症状已修"的完整论证）

| 环                                 | 谁钉住                                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 装完**会去刷**（本刀新加）         | `test/use-team-install-refresh.test.tsx` 的 ⭐ 用例（断言 `fetchAgentsForGateway('gw-1', { force: true })` 被**恰好叫一次**） |
| `force: true` **真的换掉陈旧目录** | `packages/core/test/gateway-dispatcher.test.ts:196`（既有）                                                                   |
| 强刷**失败会抛**（所以必须 catch） | `packages/core/test/gateway-dispatcher.test.ts:207`（既有）                                                                   |

## 账本

**测试名字级读数**（`cd packages/desktop && ./node_modules/.bin/vitest run test/use-team-install-refresh.test.tsx`）：
实现前 `1 failed | 2 passed (3)`（红：`⭐ 装完团队 ⇒ 强刷一次目录`，报文 `expected "spy" to be called 1 times, but got 0 times`）；
实现后 `3 passed`；补了顺序那条之后 **`4 passed (4)`**。加上既有工作区守卫文件：`2 files / 7 passed`。

**变异读数**（装置 `$TEMP/guard-mutate.mjs`，全部 `RESTORE_SHA256_EQUAL=true`）：

| #      | 变异                                                                | 实跑读数                   | 红名单                                |
| ------ | ------------------------------------------------------------------- | -------------------------- | ------------------------------------- |
| M1     | 删 `await refreshAgentCatalog(...)`                                 | `1 failed \| 2 passed (3)` | ⭐ 强刷那条                           |
| M2     | `{ force: true }` ⇒ 默认（不强刷）                                  | `1 failed \| 2 passed (3)` | ⭐ 强刷那条                           |
| M3     | 刷新失败改为 `throw err`（去掉容错）                                | `1 failed \| 2 passed (3)` | ⭐ 失败不许变成装失败                 |
| **M4** | `await refreshAgentCatalog(...)` ⇒ `void`（调用还在、只是**不等**） | `1 failed \| 3 passed (4)` | **只有** ⭐ 顺序那条 ⇒ 这条测试非空转 |
| M-CTRL | 只改日志文案（等价）                                                | `3 passed`（0 红）         | —                                     |

⚠️ **M4 的由来**：规格复核者发现"先 `await` 再报成功"这半句**没有任何测试钉住**（它自己跑 `await`⇒`void` 得到 **0 红**）⇒ 补了顺序那条用例 + 这条变异，现在它按名点住。

⚠️ **M1 第一次拒跑**（`ANCHOR_HITS=0`）：我把含 `\n` 的锚点用单引号传进 bash ⇒ 那是**字面反斜杠 n**，
不是换行。装置照规矩拒绝执行（这正是它该做的），换掉 `\n` 后才是真读数。

**门禁**：见下（`pnpm check`，重定向取 RC，不用管道）。

## 登记（本刀没做/没验）

- **层 2 仍在**：目录万一还是陈旧（例如刷新失败），用户得到的仍是"静默换成 main + 罗盘"，**没有任何提示**。
  要不要说出来 = 决定 D1（未拍）。
- **`runUpdate` 不刷**（理由见上）；若将来它开始创建 agent，这条接线要一起加。
- **本刀只证明"装完会强刷"**（三个环各自的钉子），**没有**跑真机三击复现 —— 真机验收留给插盘那次。
- **"刷新"没有正典，而且有四种写法**（规格复核者偏差 3）：`force:true` 三处 + `Settings/sections/AgentsSection.tsx:682-689`
  直连 `listAgents` IPC + `setAgentCatalogForGateway`。**没有哪份文档说哪条是正典** ⇒ 将来接线的人可能选错，
  而**选错不报错、只静默陈旧**（本刀这类的症状）。登记。
- **一条"靠约定"的软边**：`components/AgentBuilderDialog/index.tsx:103` 的 `onCreated` 是**可选** props，
  刷新全靠调用方（`AgentsSection.tsx:1250`）记得传 —— 新增不传的调用方会静默复现同族缺陷。登记。

### 覆盖面（规格复核者穷举，供后人省一次考古）

渲染层能建 agent 的原语只有 **3 个** `window.clawwork.createAgent` 调用点
（`useTeamInstall.ts`、`lib/agent-builder.ts`、`lib/preset-agent-installer.ts`）；把全部入口映射到这三条上之后：

- **团队侧没有第二个入口**：`installTeam` 全仓只有 `useTeamInstall.ts:185` 一个调用点；
  `TeamBuilderDialog` / `CreateTeamWizard` / `useTeamHubInstall` 全部经过 `runInstall` ⇒ **继承本刀的刷新**。
- **非团队侧无一漏刷**：预置助手（装前/装后各一次）、市场模板、设置里新建、`MainArea` 目标路由建助手 —— 都有刷新。
- **装失败 ⇒ 不刷是安全的**：core 的三条 `error` 出口都先 rollback（`team-installer.ts:247/:254/:278`），
  报 error 时不会留下新 agent；而"部分成功"（有的 agent 建失败只是 warning）仍走 `done` ⇒ **覆盖到了**。
