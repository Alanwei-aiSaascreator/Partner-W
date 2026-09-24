# 请求的助手不在本机时：拒绝并说明（层 2）

日期：2026-09-24 · 分支 `fix/portable-update-gaps` · 起点 `95556223`

## 1. 问题

用户建/装一个团队后**不重启**，打开团队点「发起对话」，落到的是**主罗盘**而不是团队那个助手，
全程没有任何提示。三次点击可复现，重启即消失（重启会强刷目录）。

机制（逐层复核，行号是当场重读的）：

1. `TeamsPanel/index.tsx:43-57` 调 `startNewTask({gatewayId, agentId, ensemble, teamId})` + `setMainView('chat')`。
   `task-store.ts:150-159` 的 `startNewTask` **原样保留**显式 `agentId`（`opts?.agentId || catalog.defaultId`）。
2. `MainArea/index.tsx:932-933` 于是挂出 `<WelcomeScreen key={pendingAgentId ?? '__new'}>`，
   `WelcomeScreen.tsx:49-53` 把 `pendingNewTask.agentId` 当 `initialAgentId` 传进 `useGatewaySelector`。
3. `useGatewaySelector.ts:42-45` 的 `effectiveAgentId`：**目录里没有就换成 `defaultAgentId`（= main）**，全程无提示。
4. `WelcomeScreen.tsx:64-83` 那个 effect 又把**替换后**的 id **写回** `pendingNewTask.agentId`（`:79`）。
5. 写回改变 `pendingAgentId` ⇒ `MainArea:933` 的 `key` 变 ⇒ `WelcomeScreen` 被重挂载。

第 4 步是「用户说主罗盘」这句话的由来：`resolveAssistantWorkspace('main')` ⇒ `COMPASS_WORKSPACE` ⇒「罗盘助手」。

同一个静默替换还有第二处：`LeftNav/index.tsx:93-94` 的
`currentAgentId = selectedAgentId || defaultAgentId || agentCatalog[0]?.id || ''`
—— 持久选择缺失时，左栏把默认助手显示成「当前选中」，并把它喂给「新建任务」按钮（`:144`）与切换器（`:173`）。

## 2. 已拍板的决定（2026-09-24，用户当场选）

| 编号 | 决定                                | 含义                                                                   |
| ---- | ----------------------------------- | ---------------------------------------------------------------------- |
| D1   | **(a) 拒绝并说明**                  | 不静默替换成别的助手；层 2 的静默换 main 要摘掉                        |
| —    | 落点 = **通用欢迎屏 + 说明 + 出口** | 不把罗盘助手假装成用户选的那个                                         |
| D3   | **三处都发**                        | LeftNav 切换器 + 身份中心 + 团队入口，行为一致；改现有夹具是有意的涟漪 |
| D4   | **本轮不做**                        | 「点某个成员单独聊」是缺功能不是缺陷，登记为已知限制                   |
| D5   | 带，但**排队**                      | 团队 agent 跨机器——卡在一个只有真运行能回答的事实上，见 §6             |
| 补充 | **发送洞堵在 core**                 | 拒绝之后不许再往一个不存在的助手发出去                                 |

## 3. 设计

### 3.1 唯一判据：一个纯函数

新增 `packages/desktop/src/renderer/lib/requested-agent.ts`：

```ts
export type RequestedAgentState = 'ok' | 'missing' | 'loading';
export function resolveRequestedAgent(
  requestedAgentId: string | undefined,
  catalog: { agents: { id: string }[] } | undefined,
): RequestedAgentState;
```

| 情况                                      | 判定          | 理由                   |
| ----------------------------------------- | ------------- | ---------------------- |
| `catalog === undefined`（目录还没拉回来） | `loading`     | **不许判缺失** —— 见下 |
| 目录已加载 · 请求为空                     | `ok`          | 没有请求，用默认助手   |
| 目录已加载 · 请求在里面                   | `ok`          |                        |
| 目录已加载 · 请求非空且不在里面           | **`missing`** | 拒绝                   |

⚠️ **2026-09-24 补充（独立复核 M-6）**：请求还带有**自己的网关**，而 `useGatewaySelector`
在网关列表变化时会内部回落换网关。两者不一致时拿新网关的目录去判旧网关的请求，会把
「不在**这个**网关上」说成「不在**本机**」⇒ 判据前置一条**网关一致性闸门**，不一致时记 `loading`
（判不了就不判）—— 与下面第一行同一条纪律。
第一行是硬要求，守 `IdentityCenter/index.tsx:66-67` 那条既有注释：目录还没拉回来就断言
「这个助手不在目录里」会**误报失败**。判据收在纯函数里，是为了三处消费者共用一份实现、且能直接单测。

### 3.2 `useGatewaySelector` 的行为变更

- 结果新增 `missingRequestedAgentId: string | null`（仅 `missing` 时非空）。
- `effectiveAgentId` 在 `missing` 时返回 `''`，**不再回落 `defaultAgentId`**。

**不引入新闪烁的论证**：目录未加载时 `defaultAgentId = gwAgents?.defaultId ?? agentCatalog[0]?.id ?? ''` 本来就是 `''`，
而 `effectiveAgentId` 今天在这条路上也返回 `''` ⇒ 行为一字不变。变更只影响「目录已加载且请求缺失」这一种情况。

⚠️ **2026-09-24 补充（独立复核 I-1）**：hook 多收一个 `requestedAgentId` —— **只有它参与拒绝**。
`initialAgentId` 是"先选中哪个"（可以含引导画像的**推荐**）；把推荐也当成"用户点名要的"会造出
**误报**：新机器上预置助手正在装、目录里还没出现的那几十秒，界面会说「这个助手不在本机」，
而它马上就好。
`effectiveAgentId` 的消费者只有 `WelcomeScreen.tsx`（`:49`、`:62`、`:65`、`:79`、`:147`）一处，
其余四家（`LeftNav`、`TasksPanel`、`useTemplateInstall`、`useSelectAgent`）只取 `selectedGwId` / `agentCatalog` / `defaultAgentId`。

### 3.3 三处提示（D3）

共用展示组件 `components/AgentMissingNotice.tsx`，文案走 9 语言 key（de/en/es/fr/ja/ko/pt/zh-TW/zh），
**不许写字面量**（`scripts/check-renderer-copy.mjs` 扫 `LeftNav` 与 `MainArea`）。

| 入口                     | 请求从哪来                           | 表现                                                                                                                                                                                                                                   |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 团队「发起对话」/ 欢迎屏 | `pendingNewTask.agentId`             | 落**通用欢迎屏** + 提示 + 两条出口                                                                                                                                                                                                     |
| LeftNav 切换器           | `uiStore.selectedAgentByGateway[gw]` | 提示；切换器**没有任何一项是高亮态**（实现上是**把原样的 id 传下去**、由 `AssistantSwitcher` 在"非空但找不到"时落中性格子；`''` 是"没有选择"的语义、会被它退回第一个助手，所以**不能**用它表达拒绝），不再把默认助手冒充成「当前选中」 |
| 身份中心「应用此画像」   | `useSelectAgent` 的目标              | 提示（有了「已加载」闸门就能安全地查目录）                                                                                                                                                                                             |

⚠️ **2026-09-24 补充（独立复核 M-2）**：「换用罗盘助手」这条出口**只在罗盘确实在目录里时**渲染 ——
否则一边说"不在本机"、一边给一个指向同样不存在的助手的死胡同按钮。
三处都用 §3.1 那个纯函数判定 ⇒ 一份规则、三个调用点。

通用欢迎屏不是新造的东西：`WelcomeScreen.tsx:122-127` 在 `resolveAssistantWorkspace(...)` 返回 undefined 时就渲染它，
已有先例与测试（`welcome-screen.test.tsx:412-429`，自定义助手走这条路）。

### 3.4 两条出口

都走既有动作，**不新造机制**：

- 「切换助手」⇒ `useSelectAgent('main')`（`lib/agent-switch.ts` 那条四步：改选择 + 改待发任务 + 离开旧会话 + 回对话）。
- 「去团队页」⇒ `setMainView('teams')`（`ui-store.ts:13` 已有该视图）。

### 3.5 写回效应自愈（不需额外代码）

`WelcomeScreen.tsx:65` 是 `if (!selectedGwId || !effectiveAgentId) return;` —— 拒绝态下 `effectiveAgentId === ''`，
effect 直接早返回 ⇒ **不再把 pending 改写成 `main`**，`MainArea:933` 的 `key` 也就不变、**不重挂载**。
先前记录的「提示会被自己销毁」的二阶效应随之消失，所以提示可以就地渲染，不必绕 toast。

### 3.6 发送洞堵在 core（原为"保守形式"，已精确化）

**洞**：拒绝之后 `pendingNewTask.agentId` 仍指向那个不存在的助手，而
`useChatSend.ts:267-275` 在无活动任务时直接 `commitPendingTask()`，
`task-store.ts:161-166` 只校验 `agentId` 非空 ⇒ 会建出一个指向幽灵助手的任务。

> ⚠️ **2026-09-24 独立复核后被推翻（I-2）**：下面这段"必须保守"是**权宜之计**，因为当时
> `getAgentCatalog` 把"没加载"与"空"塌成同一形状。复核指出这让**渲染层与 core 对同一状态给出
> 相反结论**（界面说"不在本机"、发送侧却不拒）。现在 `getAgentCatalog` 的返回类型加了 `| undefined`
> （desktop 与 pwa 两个适配点各一行），判据写成**精确版**：
> `requestedAgentId && catalog && !catalog.agents.some(a => a.id === requestedAgentId)` ⇒ 拒绝。
> 下面这段保留为历史，**不要再按它写代码**。

**（历史）为什么当时必须保守**：**为什么必须保守**：`platform/index.ts:83-86` 与 `pwa/stores/index.ts:84-87` 的 `getAgentCatalog`
把「目录没加载」与「目录为空」**塌成同一个形状** `{agents: [], defaultId: null}` —— core 里分不出这两者。
所以判据写成：

```
pending.agentId 非空  且  catalog.agents.length > 0  且  catalog 里没有该 id  ⇒ 拒绝
```

`agents.length > 0` 是「已加载」的保守代理：目录为空时（可能只是还没加载）**行为与今天一字不变**。
桌面与 core 的既有测试桩都塞了 `[{id:'main'}]`，新判据对它们无损。

**错误要可区分**：抛一个带稳定 code `unknown-agent` 的错误，
`useChatSend.ts:271-273` 那个 `catch` 现在把所有异常都压成 `errors.agentNotResponding`（「助手无响应」），
要按 code 分开——「不在本机」与「无响应」是两句不同的话，且各有自己的下一步。

**拒绝态下 `pendingNewTask` 保持原样**（仍指向那个不存在的 id）：不由拒绝逻辑去改它，
发不出去由上面这条闸门保证；用户点任一条出口（§3.4）之后它才改变。
这样 `MainArea:933` 的 `key` 始终稳定，提示不会被自己销毁（§3.5）。

## 4. 非目标

- **D4 不做**：团队详情里「点成员单独聊」。登记为已知限制。
- **D5 不在本刀内**：见 §6，它需要先做一次运行时核查。
- 不动 `stable` / `latest.yml` / `/updates` 下其他文件；不发版、不打包、不换密钥。
- ✅ **2026-09-24 修订**：网关回落那条 effect **加了一条判据**（网关一致性闸门，见 §3.1 补充）——
  复核 M-6 指出不改就会误报。仍然**不重构**它的其余部分。
- 不重构 `useGatewaySelector` 的其余部分（网关回落那条 `:47-55` 与本次无关）。

## 5. 测试计划

**核心一条（必须不用 `vi.mock`）**：跑**真 hook**，目录里只有 `main`，
`pendingNewTask.agentId = 'team-agent-x'`，断言**用户可见的结果**：

1. 提示出现；
2. 罗盘助手**没有**被当成所选助手静默呈现（`assistantWorkspaces.compass.*` 不出现）；
3. `pendingNewTask.agentId` **没有被改写成 `main`**。

`welcome-screen.test.tsx:64-79` 那个假 hook 把缺陷抄进了夹具
（`const effectiveAgentId = …some(id) ? … : 'main'`），**必须拆掉**——这是 D3 说的"有意的涟漪"。

其余：

- 纯函数：四态各一条（含「目录未加载不判缺失」）。
- `commitPendingTask`：三个方向各一条（目录空不拒 / 目录有但不含该 id 拒 / 目录含该 id 放行），
  且拒绝时**不许**建出任务。
- LeftNav 与身份中心：各一条按名的断言。
- 文案：9 语言 key 齐全；`check:i18n` 与 `check-renderer-copy` 绿。
- 变异电池：每条新断言至少一个能把它变红的变异，含对照 0 红。
- `export PATH="/d/go-toolchain/go/bin:$PATH"` 后 `pnpm check`（本工作树是 `attr/text=auto eol=lf`，
  `format:check` 在这里是**真信号**）。

## 6. 已核事实与未核事实（D5 排队的原因）

**已核**（本次只读调查，都有证据）：

1. 注册表 = `<机器 userData>/state/<sha256(token)[:24]>/openclaw.json` 的 `agents.entries.<id>`，
   每条存 `name` + `workspace`（指向**盘**）+ `agentDir`（指向**机器**）+ `identity`。
   换机器 ⇒ 这张表是空的 ⇒ 预置助手靠硬编码清单（`PRESET_AGENT_IDS`）补装回来，**团队没有清单**。⑤ 的全部就是这个。
2. agent id 由 `agents.create` 的 **`name` 参数派生**：`preset-agents.ts:39` 的 `creationName === id`，
   安装器 `preset-agent-installer.ts:151-158` 断言返回 id 与之一致（不一致就回滚）；模板同理（`rongying-tpl-<hash>`）。
3. 团队成员名单**能从盘上恢复**：`<工作区>/.clawwork.db` 的 `teams` + `team_agents`（`main/db/schema.ts:82-110`）。
4. ⚠️ **成员的「名字」盘上没有**：两张表都没有 name 列；名字只活在**机器本地的注册表**里。
5. 一个团队的 agent **每团队共用一个目录** `<工作区>/<团队slug>`（`workspace-handlers.ts:129-140`），
   不是每 agent 一个；`toSlug` 对中文名走 FNV-1a ⇒ `agent-<hash>`，**单向不可逆**。

**未核（只能从真实运行时读到）**：网关在 `<工作区>/<团队slug>` 下**是否按 agent 分目录**、以及
`agents.create({name: <中文名>})` 派生出的 id 长什么样。这决定 D5 能否**拿回同一个 id**
（拿不回 ⇒ `team_agents` 行、历史会话 session key、网关 `agents/<旧id>/` 全部失联，那就不是"带过去"而是"带过去但断了历史"）。

本机三处现场（E: 那次便携运行、安装态 `openclaw-state`、9-23 新现场）**都没有团队 agent**，E: 现在也没插 ⇒ 读不出来。
⇒ D5 单独立项，先做「第一小时运行时核查」；**不拿推断写 D5 的代码**。

相关：`docs/superpowers/plans/2026-09-23-team-agent-directory-refresh.md`（层 3，已修未合，
分支 `fix/team-agent-directory-refresh` @ `57c665f6`）—— 层 3 降低层 2 被触发的频率，但**不替代**层 2。
