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
实现后 `3 passed`。加上既有工作区守卫文件：`2 files / 6 passed`。

**变异读数**（装置 `$TEMP/guard-mutate.mjs`，全部 `RESTORE_SHA256_EQUAL=true`）：

| #      | 变异                                 | 实跑读数                   | 红名单                |
| ------ | ------------------------------------ | -------------------------- | --------------------- |
| M1     | 删 `await refreshAgentCatalog(...)`  | `1 failed \| 2 passed (3)` | ⭐ 强刷那条           |
| M2     | `{ force: true }` ⇒ 默认（不强刷）   | `1 failed \| 2 passed (3)` | ⭐ 强刷那条           |
| M3     | 刷新失败改为 `throw err`（去掉容错） | `1 failed \| 2 passed (3)` | ⭐ 失败不许变成装失败 |
| M-CTRL | 只改日志文案（等价）                 | `3 passed`（0 红）         | —                     |

⚠️ **M1 第一次拒跑**（`ANCHOR_HITS=0`）：我把含 `\n` 的锚点用单引号传进 bash ⇒ 那是**字面反斜杠 n**，
不是换行。装置照规矩拒绝执行（这正是它该做的），换掉 `\n` 后才是真读数。

**门禁**：见下（`pnpm check`，重定向取 RC，不用管道）。

## 登记（本刀没做/没验）

- **层 2 仍在**：目录万一还是陈旧（例如刷新失败），用户得到的仍是"静默换成 main + 罗盘"，**没有任何提示**。
  要不要说出来 = 决定 D1（未拍）。
- **`runUpdate` 不刷**（理由见上）；若将来它开始创建 agent，这条接线要一起加。
- **本刀只证明"装完会强刷"**（三个环各自的钉子），**没有**跑真机三击复现 —— 真机验收留给插盘那次。
