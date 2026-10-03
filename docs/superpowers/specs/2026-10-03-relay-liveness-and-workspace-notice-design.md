# relay 运行期可见性 + 工作区重建告知 —— 设计定案（2026-10-03）

状态：**已批准**（用户 2026-10-03 午后回「开工」）。
范围：D 树 `codex-release-blockers` 本地切片（混 codex 在途 WIP，不推远程）；两刀并入 10/5 候选重出。

## 0. 一句话

两条感知缺口各补一个最小闭环：

1. **relay 运行中断开** ⇒ 周期探活 + 命名横幅（**不锁输入框**）；
2. **工作区被就地重建（`recreated`）** ⇒ **非阻断告知**（就绪页 + 工作台），重建行为本身不动。

## 1. 背景与既有事实（读码核实）

**实测现象（2026-10-03 真机）**：

- relay(8791) 被杀 ⇒ 工作台**无感**、composer 仍可用；对照 gateway(18789) 被杀 ⇒ 已有命名横幅 + 离线只读（W05③）。
- 工作区目录缺失 ⇒ `workspace.startup.decision kind:"recreated"` ⇒ 静默重建空工作区，就绪页/工作台**零告知**。

**读码核实的既有事实**：

- relay **启动期**失败已有完整出口：`RelayBootstrapPublicState`（`idle|running|ready|blocked|retryable-error`）× `relayFailureFrom` → 面板文案 + 激活/重试按钮 + 输入框模型格（`startup-readiness.ts`）。⇒ 缺口精确范围 = **ready 之后运行途中无复检、无探活**。
- 状态通道已存在且纪律明确：shared 的 `relayBootstrapPublicStateStore`（`updatedAt` 严格单调）+ push IPC `onCommercialRelayBootstrapState` + invoke 初读；renderer **先订阅后补读**、按 `updatedAt` 取舍（`useStartupReadiness.ts`）。
- 重试出口已存在：`commercialRelayBootstrapRetry` IPC（`retryable` 档专用）。
- 探活端点：relay 有 `/v1/catalog`、`/v1/capabilities`（`relay-config.ts:599/632`，带 Bearer key）。本设计用**不带 key** 的 `GET /v1/catalog`：**2xx/4xx = 有应答 = 活；5xx / 超时 / 拒连 = 断**（401 是正常应答；502/504 是"服务死着"）。无计费、无副作用。
- 工作区决策在 main（`workspace/startup.ts`、`workspace/portable.ts`）：`decideWorkspaceStartup` 六个 kind；`recreated = 本机目录被删（卷还在、又不是盘上工作区）⇒ 就地重建，与旧行为一致`。**教义：刻意不弹框**（原话："不该因为多记了一条相对路径就变成'弹框让你选盘'"）。零命中且记过 relPath（盘没插）走 `ask-user` 对话框，是**另一条**分支，不在本设计范围。
- 就绪页（`EntryPreparation`）六项含 `workspace`；工作台 `MainArea:1025` 的就绪面板**仅 `!isReady` 渲染** ⇒ `recreated` 属 ready 态，天然没有告知位——这就是"零告知"的结构原因。

## 2. 缺口① 设计：relay 运行期可见性

### 2.1 判据与探活

主进程新模块 `main/commercial/relay-liveness.ts`：

- 跟随 `relayBootstrapPublicStateStore`：phase 到 `ready` 时启动周期探活；离开 `ready` ⇒ 相位回 `unknown` 并停探（启动态有既有表达，不重复说）。
- 探针：`GET ${activeRelayBaseUrl()}/v1/catalog`（无 Authorization），超时 5s。
- 节律：30s/次；**连续 2 次失败才判 `down`**（防单次抖动）；**1 次成功即回 `up`**（恢复要快）。
- 生命周期：随应用退出清理；账户切换（与 `resetRelayBootstrapPublicState` 同类边界）时一并复位。
- 探活失败**只吞错 + 记 debug 日志**（`relay.liveness.*`），绝不影响主流程。

### 2.2 状态与通道

- 新公开状态 `RelayLivenessPublicState`：`{ phase: 'unknown' | 'up' | 'down'; updatedAt: number }`，放 `@clawwork/shared`，完全镜像既有存储纪律（updatedAt 严格单调、单写者 = monitor、`createRelayLivenessPublicStateStore`）。
- 通道：push `onCommercialRelayLivenessState` + invoke `commercialRelayLivenessState()` 初读；renderer **先订阅后补读**、按 `updatedAt` 取舍。

### 2.3 渲染层

- 纯判据函数 `deriveRelayConnectionNotice(...)`（新文件 `renderer/lib/relay-connection-notice.ts`，带单测）：输入 liveness + bootstrap phase，输出"要不要显示横幅"与文案键。
- 横幅组件挂 `MainArea` 的 `ConnectionBanner` 同槽（`:1388` 区域）：仅 `down` 时显示 warning 条：
  - zh：「商业服务连接异常 —— 模型调用可能失败，正在自动重试…」＋ [立即重试]（= 立即探一次）。
- **不锁输入框**：缺口在"无感"，不在"可用"——本地功能（历史/文件）照用；发送失败时既有错误路径照旧。
- 恢复：静默消失（与 gateway 横幅同做派）。
- i18n：9 语言新增键。

### 2.4 明确不做（YAGNI）

- 不动 bootstrap 相位闭集（**不**新增 phase）；不改输入框模型格文案（那是目录/启动语义）；不做"已恢复"提示；首版不给重试计数。

## 3. 缺口② 设计：工作区重建告知

### 3.1 主进程

- 启动应用决策时落一条模块级记录：**仅** `kind === 'recreated'` ⇒ `{ kind: 'recreated'; path: string; at: number }`；其余 kind 一律 `null`。
- 清空边界：用户切换/重选工作区后清掉（避免旧通知挂在新工作区上）。
- 新 IPC invoke `workspace:startup-notice`（`workspace-handlers.ts` + preload + d.ts）。

### 3.2 渲染层

- 共享组件 `WorkspaceRecreatedNotice`（`InlineNotice` tone=warning）：
  - zh：「原工作区目录不存在（可能已被移动或删除），已在本机新建空工作区。如需找回旧数据：请检查原目录，或切换工作区。」＋ [打开工作区设置]（`setSettingsSection('system')`）＋ [知道了]（**会话内**关闭，不落盘）。
- 挂**两处**：`EntryPreparation`（就绪页，清单下状态行区）+ `MainArea` 欢迎屏（`:1024` 区，就绪面板同区）。
- **行为不动**：重建照旧、不阻断、绝不改成选盘对话框（教义）。

### 3.3 明确不做

- 不给 `healed` / `ask-user` / `default` 加任何提示（语义不同）；不落盘持久化（条件天然只存活一轮启动）；不动便携"盘没插"对话框路径。

## 4. 边界与失败面

- 探针失败不得影响主流程；不放宽任何既有守卫；只访问本配置的 baseUrl，不外发。
- 所有新增用户文案走 i18n（9 语言）；注释里不写会被检查器扫中的违禁字面量（已有教训：检查器连注释一起扫）。

## 5. 测试计划

- 单测（新）：
  - `relay-liveness`：假定时器——ready 才探、两败判 down、一胜即 up、离 ready 停探 + unknown、destroy 清理；
  - 探针判据（注入 fetch 桩）：2xx/4xx 活、5xx/超时/拒连 断；
  - `deriveRelayConnectionNotice`：档位矩阵（unknown/up/down × bootstrap 各相位）；
  - startup-notice：仅 recreated 出值、其余 null、切工作区清空；
  - `WorkspaceRecreatedNotice`：渲染 / 关闭 / 按钮动作；
  - IPC handler：形状（只读、无权限面）。
- 回归：relay 家族、startup-readiness 家族、workspace 家族、entry-preparation 家族全绿；typecheck ×2；prettier / eslint；四检查器 RC=0。

## 6. 实施切片与验收

**切片 1**（缺口①）：main 模块 + shared 状态 + IPC + preload + renderer 钩子/判据/横幅 + i18n + 测试。
**切片 2**（缺口②）：main 记录 + IPC + preload + renderer 读取/组件/两挂点 + i18n + 测试。

纪律：每刀 typecheck(+tests) / prettier / eslint / 四检查器 RC=0；**只 add 本刀文件**；提交后逐文件 sha 复议；不推远程（混 codex WIP）。

**真机验收（候选上）**：

- ①：启动 → 杀 relay(8791) → ≤90s 内工作台出现命名横幅；恢复 relay → 横幅静默消失；期间 composer 可用；
- ②：删除工作区目录（可逆演练）→ 重启 → 就绪页出现告知；进工作台欢迎屏仍在；[打开工作区设置] 可用；[知道了] 关闭；全程零花费、原目录可还原。
