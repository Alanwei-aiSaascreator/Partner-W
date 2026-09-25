# P0-4 只读地图：团队 / 助手的数据各在哪

**为什么要这张图**：团队这一块有**三个**数据源，两个跟着盘走、一个跟着机器走，
而它们用一个**字符串 id** 对上。不把这张图写下来，就会反复犯同一个错：
**把"花名册上有"当成"这台机器上有"**。

（只读调查，2026-09-25，B 分支。所有条目都读过源码，不是推断。）

---

## 三个数据源

| #   | 数据                     | 存在哪                                                                                                 | 跟着谁走 | 关键字段                                  |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------- |
| 1   | **团队花名册**           | 工作区库 `teams` / `team_agents` 两张表（`main/db/index.ts:91` = `join(workspacePath, DB_FILE_NAME)`） | **盘**   | 见下                                      |
| 2   | **这台机器上有哪些助手** | **网关**回的目录（`listAgents` RPC）                                                                   | **机器** | `AgentInfo.id` / `identity.name` / `name` |
| 3   | TeamHub 模板缓存         | `<userData>/teamshub-cache/<registryId>.json`（`teamshub/registry.ts`）                                | **机器** | 模板，不是运行数据                        |

### 表 1 的字段（`main/db/schema.ts:82` 起）

```
teams:        id / name / emoji / description / gatewayId / source / version / hubSlug / createdAt / updatedAt
team_agents:  teamId / agentId / role / isManager / skillsJson / position
```

## ⭐ 这张图上最容易犯的错

**`team_agents` 里只有 `agent_id`，没有名字。** 名字在**表 2**（网关目录）里 ——
界面上显示的那个名字（`agentLabel`，`LeftNav/AssistantSwitcher.tsx:28`）走的是
`identity?.name || name || id`。

⇒ **光有花名册，界面上连"缺的是谁"都说不出来**（id 是 `rongying-content` 这种 slug，
不是给人看的）。所以：

- 缺装时**不能**在文案里点名（说不出人话）；
- 要显示名字，就必须**先拿到目录**。

**另一个**：id 是**由创建名派生**的（同名重装 = 同 id）⇒
**id 相同不等于同一个助手**（换台机器装一个同名但不同提示词的，id 会撞）。
⇒ 任何"按 id 判等价"的逻辑都要带上这条。

## 判据（唯一出口）

**"这个团队能不能开聊"** 收在 `renderer/lib/team-chat-entry.ts` 的 `decideTeamChatEntry`，
它复用 `renderer/lib/requested-agent.ts` 的 `resolveRequestedAgent`（三态）：

| 目录状态                    | 结论                 | 为什么                                             |
| --------------------------- | -------------------- | -------------------------------------------------- |
| `ok`                        | 进会话               | 本机确实有                                         |
| `missing`                   | **不进**，当面说清楚 | 跳过去也只会被下一屏挡回来                         |
| `loading`（目录还没拉回来） | **照旧进**           | 判缺失就是**误报**，会把人赶去装一个已经装好的助手 |

## ⛔ 一条硬约束（改这块之前先读）

**团队跟随磁盘，但绝不把主机凭据 / 用户目录复制到盘上。**

背景：盘上**已经**带着凭据了（`per-account-vs-per-disk-survey` 查实）——
`clawwork-config.json` 里有 `commercial.licenseKey`、`commercial-session.json` 里有登录会话、
`device-identity.json` / `device-tokens.json`、以及网关 token。那是"盘带身份"这个既有设计，
**不是**本轮要动的。

⇒ 做团队同步 / 补齐时，**只同步团队定义与安全业务数据**，
⛔ 不许顺手把主机的凭据目录、用户目录、网关状态目录一起带过去。

## 已经做过的修复（别重做）

| 位置                 | 修了什么                                                                   | 什么时候                     |
| -------------------- | -------------------------------------------------------------------------- | ---------------------------- |
| `useGatewaySelector` | 目录里没有请求的助手时**拒绝而不是静默换成主助手**（原来会静默落到主罗盘） | 2026-09-24（在本分支基线里） |
| `team-chat-entry`    | 点团队"开始对话"时**判要进的那个助手在不在本机**，缺就**不跳**并当面说明   | `109afb9f`（2026-09-25）     |

## 还没做的（属于 C / integration）

- **卡片上直接标"需要安装"**（现在只在**点击时**拒绝）—— 呈现层，判据已经有了
  （把 `decideTeamChatEntry` 的结果渲染出来即可）。
- **跨机器补齐**（把缺的助手真正装到这台机器）：团队 agent 跨机器带这件事
  ⛔ 卡在一个前置事实上 —— 注册表在机器本地、**盘上没有名字**，见
  [[agent-registry-lives-on-the-machine-not-the-disk]]。**别静态推断,先做运行时核查。**
