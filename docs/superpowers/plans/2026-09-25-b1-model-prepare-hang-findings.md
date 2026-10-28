# B1：「正在准备模型」卡住 —— 复现证据与根因（2026-09-25）

**状态**：证据已到手（真日志、带时间戳）；**修复未开始**（下一步 TDD）。

## 证据来源

`%APPDATA%\@clawwork\desktop\logs\debug-2026-09-25.ndjson`（本机开发实例，2026-09-25 11:01 那次运行）。
抽取脚本：`%TEMP%\readiness-timeline.mjs`（按 `ts` 排序，打相位变化与 >1 秒的空档）。

## 时间线（相对第一条就绪相关日志）

```
   0.0s  gateway.runtime.deploy.skipped     deploymentKey=2026.9.3-win32-x64-…
   1.8s  gateway.runtime.bootstrap.failed   code=runtime.gateway-port-occupied
   1.9s  gateway.gateway.connect.start
   2.5s  commercial.relay.bootstrap.unauthenticated
   2.8s  gateway.gateway.connect.failed     AUTH_TOKEN_MISMATCH · rejected=true
                                            hint="网关明确拒绝 ⇒ 停止重连（会在状态里报 gaveUp）"
 293.6s  gateway.runtime.deploy.skipped     ← 中间约 290 秒**没有任何与就绪相关的日志**
 339.0s  gateway.runtime.gateway.output
 357.8s  gateway.runtime.bootstrap.ok       ← 到 357.8 秒（≈6 分钟）网关才起来
```

## 根因（两层，都要修）

### ① 第一次失败**极快**（1.8 秒），失败原因**明确**

```json
{"code":"runtime.gateway-port-occupied",
 "reason":"端口 18789 被另一个 OpenClaw 网关占用：端口上的网关用本 state 的 token 认证失败
            —— 不是我们的。为避免破坏它，装载器不会强制启动、也不会结束它
            —— 请先停掉那个网关，或改用其它端口。"}
```

⇒ 主进程**清清楚楚知道**是"端口被另一个网关占了、而且不是我们的"。这条信息**已经存在**，只是没有到界面。

### ② 失败之后**没有任何自动重试**，界面于是永远停在"正在准备"

- 调用点只有一处：`packages/desktop/src/main/index.ts:463`（启动时 `await bootstrapLocalGatewayRuntime(...)`），
  **不重试、不排期**；失败只落一条日志（外加"端口被占"那一路弹一个 `MessageBox`，易被忽略）。
- 连接层随后 `AUTH_TOKEN_MISMATCH · rejected=true` ⇒ 明确**停止重连**（`gaveUp`）。
- 渲染层的就绪推导（`renderer/lib/startup-readiness.ts`）只看
  `gatewayStatus !== 'connected'` ⇒ `assistantPhase='waiting'`、`ai.phase='starting'`
  ⇒ `composerBlocked=true`，文案「正在准备模型 / 启动 AI 服务」**一直转圈**。
  ⇒ **判据里没有"连接层已经放弃"这一档**，所以"明确拒绝"被说成了"还在准备"。

这两层合起来就是用户报的「超过合理时间」：**不是慢，是永远不会好，而且不告诉你为什么。**

## 与 C 线的边界（按章程：B 管行为、C 管呈现）

- **B1（本线）**：让状态**有结论** —— 连接层已 `gaveUp` / 主进程已知端口被占时，
  就绪推导**不得**再停在"正在准备"；并按章程给**有限自动重试**（例如端口被占之外的失败退避重试几次），
  而不是"失败即终止"。
- **C2（C 线）**：这些失败**说什么话、摆什么按钮**（文案与 UI 走 i18n）。

⚠️ 两边都会碰 `startup-readiness.ts` 的**消费面**：B 只动**推导**（判据多一档），C 只动**文案与呈现**。
改之前先看这条边界。

## 还没证伪/还没做的

- **干净启动的正常耗时没有量过**（上面这次是"端口被占"的病态运行，不能拿来当基线）。
  下一步要在**没有外来网关**的情况下量一次正常启动：`runtime.bootstrap.ok` 用了几秒。
- 触发第二次尝试（293.6s 那次）的**是谁**还没查（用户点重试？渲染层轮询？）——
  它决定了"①手动重试 ②自动重试"哪个更该先做。
- 复现方式要固定下来（可重复、不依赖本机残留）：**先起一个占着 18789 的网关，再起客户端**。
