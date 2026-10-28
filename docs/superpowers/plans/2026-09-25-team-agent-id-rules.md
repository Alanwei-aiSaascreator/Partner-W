# 团队 agent 的 id 是怎么来的（D5 前置核查之一）—— 只读调查记录

**为什么查**：D5（团队 agent 跨机器，已拍"带但排队"）卡在一句"**必须先做真实运行时核查**：
团队目录是否按 agent 分目录 / **中文名派生出什么 id**；别静态推断"。

**这次查到什么**：id **不是我们派生的** —— 客户端只送 `name`，**id 由网关（运行时）派生**。
而派生的规则是**读到了实现**的（不是推断）。证据来源：出厂归档内的
`node_modules/openclaw/dist/`（与三处已解包副本**逐字节比对一致**）。

## 链路（客户端侧）

`packages/core/src/services/team-installer.ts:151`：

```ts
const res = await deps.createAgent({ name: agent.name, workspace });
…
const agentId = res.result.agentId;      // ← id 是**运行时回的**
```

⇒ 我们**不**参与 id 生成；`agentSlug: agent.id` 只是团队清单里的 slug（用于报进度），
与最终 agentId 是两回事。

## 链路（运行时侧）

`dist/agents-Cvmqx4x8.mjs:445`（`agents.create` handler）→
`dist/agent-create-BSK3Nvv3.mjs:106`（`createAgent`）：

```js
const rawName = (params.entry?.name?.trim() || params.entry?.id || params.name || '').trim();
if (!rawName) return createError('invalid-name', 'agent name is required');
const validation = validateAgentIdInput(params.entry?.id ?? rawName, { displayName: rawName });
if (!validation.ok) return createError(validation.reason, validation.message, validation.agentId);
const agentId = validation.agentId;
```

`validateAgentIdInput`（同文件 `:36`）→ `normalizeAgentIdStrict`
（`dist/agent-id-GA8mwdTG.mjs:15`），规则**全在这三行**：

```js
const VALID_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const INVALID_CHARS_RE = /[^a-z0-9_-]+/g;
// 先原样试 VALID_ID_RE；不匹配就：小写 → 把"非法字符的连续段"整体换成一个 '-' → 去掉首尾 '-' → 截到 64
// 结果为空 ⇒ err("unrepresentable")
```

失败文案（`agent-create-BSK3Nvv3.mjs:40-44`）：

> `Agent name "X" has no valid id characters. Use at least one letter a-z or digit.`

## ⇒ 两条硬结论（对 D5 直接相关）

1. ⛔ **纯中文名（或任何不含 `a-z0-9` 的名字）根本建不出来**：
   规范化后是空串 ⇒ `unrepresentable` ⇒ handler 回 `invalid-name`。
   ⇒ 团队清单里若有 `name: "内容助手"` 这样的 agent，**安装时那一个会被跳掉**
   （installer 只记一条 warning：`Failed to create agent "…"`）。
2. ⚠️ **混合名只保留 ASCII 部分**：`"内容助手 A1"` ⇒ 小写 ⇒ 非法段整体换成 `-`
   ⇒ `"-a1"` ⇒ 去首 dash ⇒ **`a1`**。
   ⇒ 两个不同的中文名只要**共享同一段 ASCII**（都带 `A1`），派生出的 id 就**相同**
   ⇒ 第二个会撞 duplicate，而不是拿到一个新 id。
   ⇒ 反过来说：**同名重装 = 同 id**（与旧记忆一致）——这是"靠名字找回 agent"的前提。

## ⚠️ 这份结论的力度

- 它是**实现的朴素读法**（那几个函数就是 handler 直接调用的），比"看文档猜"强；
- ⛔ 但**还没有真跑一次**（真起网关、真发 `agents.create`）⇒
  按纪律**不当成已验证**：真机/真网关那一次仍要补。
- 也**没核**：`params.entry?.id` 存在时优先用它（团队清单里若显式给 id，上面第 2 条就不适用）；
  以及 duplicate 的具体错误码/文案。

## 对 D5 方案的影响（还没拍，先记着）

"跨机器补装"要靠**名字找回同一个 agent**（同名 ⇒ 同 id）。上面第 1 条意味着：
**中文名团队 agent 既装不上、也带不走** ⇒ D5 要落地，**先得决定**：
是要求团队清单用 ASCII 名（或在 id 里补 ASCII），还是我们在安装时给中文名**兜一个稳定的 ASCII slug**
（那就得改客户端：把 `name` 换成"名 + 派生 slug"一起送，或显式送 `entry.id`）。
