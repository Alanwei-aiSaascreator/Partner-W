# 电脑操控权限：两档开关（设计，2026-09-26）

**用户原话**：「开那个，加一个按钮提示用户如果用直接操控电脑，需要打开就行，表示同意我们 agent
操作电脑，就行 workbuddy 那样，允许操控访问所有文件与权限这个」→ 追问后拍板 **「2 档」**。

**一句话**：设置里加一个**默认关闭**的开关，打开前必须过一道**同意门**；打开后助手能碰整台电脑
（读工作区外的文件、跑命令且不问）。关掉就回到今天的样子。

---

## 一、先探针，后设计（真机读数，盘 E: 0.0.35 + 真模型）

⚠️ 这一步是**事前登记判据**那套规矩的延续：旋钮叫什么、有没有用，**不许靠猜**。

### 1.1 被否掉的方案：`tools.elevated`

先试了配置层那个看起来最像的旋钮。读数：

```
探针态 tools = {"elevated":{"enabled":true}, "exec":{"mode":"full"}, "fs":{"workspaceOnly":false}}
sandbox explain → Elevated: enabled: true / channel: (unknown) / allowedByConfig: false
```

运行时源码（`sandbox-cli-*.mjs:181`）：

```js
const elevatedAllowedByConfig =
  elevatedEnabled && Boolean(channel) && globalAllowTokens.length > 0 && (...)
```

`channel` 是 **Telegram / Discord 那种外部渠道**；桌面端没有 channel ⇒ 这个旋钮**结构性无效**。
`elevated` 保留在红线里（`enabled:false`）不动，也不参与本设计。

### 1.2 真正的旋钮：会话权限模式（四档 → 三条策略）

运行时源码 `session-permission-exec-mode-*.mjs`：

```js
const EXEC_MODE_BY_PERMISSION_MODE = { 'read-only': 'deny', guarded: 'ask', workspace: 'auto', full: 'full' };
function resolveSessionPermissionCoreToolPolicy(policy) {
  const workspaceOnly = policy.mode !== 'full'; // ← 关键一行
  return {
    workspaceOnly,
    readOnly: policy.mode === 'read-only',
    applyPatchWorkspaceOnly: workspaceOnly,
    execMode: EXEC_MODE_BY_PERMISSION_MODE[policy.mode],
    bypassHostApprovalFloors: policy.mode === 'full',
  };
}
```

合成规则（`agent-tools-*.mjs:375`）——**会话模式压过配置**：

```js
const workspaceOnly = ... || (sessionCoreToolPolicy?.workspaceOnly ?? fsConfig.workspaceOnly === true);
```

| 档位        | workspaceOnly | exec     | bypassHostApprovalFloors |
| ----------- | ------------- | -------- | ------------------------ |
| `read-only` | true          | deny     | false                    |
| `guarded`   | true          | ask      | false                    |
| `workspace` | true          | auto     | false                    |
| **`full`**  | **false**     | **full** | **true**                 |

### 1.3 治理：网关自己给「全权」加了一道 admin 门

`method-scopes-*.mjs`：

```js
function resolveSessionsPatchRequiredScope(params) {
  if (params.permissionMode === 'full') return 'operator.admin';
  ...
}
function resolveSessionsCreateRequiredScope(params) {
  if (... || params.permissionMode === 'full') return 'operator.admin';
  ...
}
```

⇒ **切全权要 `operator.admin`**，其它档位只要 `operator.write`。
我们客户端握手时**已经在申请** `operator.admin`（`ws/gateway-client.ts:483`），且已有
`patchSession`（`gateway-client.ts:1037`）+ 渲染层 IPC `ws:session-patch`（**整包透传**，
`main/ipc/ws-handlers.ts:653`）⇒ **不需要新管道、不需要动主进程**。

### 1.4 行为探针：同机同模型同提示词，两个会话对打

两条会话都由**应用自己的 IPC** 建（`ws:create-session`），只有档位不同。

| 判据                           | `permissionMode:"full"`       | 默认（无模式 + 配置 `workspaceOnly:true`）                                 |
| ------------------------------ | ----------------------------- | -------------------------------------------------------------------------- |
| 读 `C:\Windows\win.ini` 第一行 | ✅ `; for 16-bit app support` | ❌ `Path escapes sandbox root (~\...\workspace): C:\Windows\win.ini`       |
| `exec: cmd /c echo PROBE_OK`   | ✅ `PROBE_OK`                 | ❌ `exec denied: Headless runs cannot wait for interactive exec approval.` |

⭐ 第二行那条报错**正是用户早先贴给我的原话** ⇒ 全权档**顺手修掉了那条"headless 等不了审批"**。

**负对照**（没有它，"成功"可能只是字段被静默忽略）：

```
patch {permissionMode:'yolo'} → {"ok":false,"error":"invalid sessions.patch params:
  at /permissionMode: must be equal to constant; must match a schema in anyOf; must be null"}
```

⭐ 配置**全程没动**（探针结束已按备份还原成红线）而 full 会话照样读到了 `C:\Windows\win.ini`
⇒ 「会话模式压过配置」这条代码读法**被真机证实**。

---

## 二、设计

### 2.1 两档

| 档位                 | 内部值                      | 对用户的意思                                               |
| -------------------- | --------------------------- | ---------------------------------------------------------- |
| **默认安全**（默认） | 不下发任何 `permissionMode` | 和今天**一字不差**：助手只在自己工作区里读写、跑命令要先问 |
| **全权**             | `permissionMode: 'full'`    | 助手能读/写整台电脑上的文件、跑命令不再问                  |

⚠️ **默认档不下发任何东西**（而不是下发 `guarded`）：这样"没开开关"与 0.0.35 的行为**逐字节相同**，
也让"默认必须收紧"这条测试有确定的对象（断言：没同意之前**一次 patch 都不发**）。

⚠️ **红线一个字不动**：`state-config.ts` 里 `TOOL_GUARD_FS_WORKSPACE_ONLY=true` /
`TOOL_GUARD_EXEC_MODE='ask'` / `MEMORY_TOOLS_DENIED` 全部保留 —— 本设计走的是**会话模式**
（运行时里它按设计压过配置），不是去改配置。**"全权"是一个显式的、每次都要经过同意的会话级授权，
不是把产品的安全底线拆了。**

### 2.2 开关的作用域（写清楚，免得界面说谎）

- 开关是**应用级设置**，持久化，默认关。
- **打开** = ① 立即把**当前任务**的会话切 `full`；② **之后新建/首发的任务**自动带 `full`。
- **关闭** = ① 立即把**当前任务**的会话切回默认；② 之后不再对新任务生效。
- **已存在的其它任务不受影响**。它们自己的档位**按真实读数常显**（见 2.4）——
  所以"设置里关了、那个任务里还开着"这件事**看得见**，不会骗人。

### 2.3 同意门（用户点名要的"提示"）

打开开关**不是**静默切换：弹一个对话框，写清代价（助手可读写工作区外的文件、可运行命令且不再逐条询问），
**勾选**「我已了解并同意」后确认按钮才可用。形状照抄已上线的 `PrivacySection` 的二次确认弹层
（勾选 + 明确的后果描述），但**不设"输入确认词"**——本动作可随时撤销，重量不该等同删除账号。

### 2.4 常显状态 + 可撤销 + 审计

- **常显**：任务界面显示当前任务的档位徽章，值来自 `sessions.list` 读回的
  `permissionMode`（**不是**本地开关的猜测）⇒ 关了开关但某个旧任务仍是全权时，徽章如实说「全权」。
- **可撤销**：随时关；关的瞬间当前任务切回默认。
- **审计**：每次真正的切换（开关、以及发送时为保证档位而补的那一刀）记一条调试日志
  （会话键、从什么到什么、触发源）。

### 2.5 发送时的兜底（唯一一处"隐式"动作，规则写死）

每次**非 @ 群发**发送前，与 model / thinkingLevel 同一条链上：

```
want = tier === 'full' ? 'full' : null      // null = 不下发
if (want === applied[sessionKey])  → 不 patch
else if (want === null && 该会话没被我们设过 full) → 不 patch（保持零改动）
else → patch { permissionMode: want ?? 'guarded' }，记入 applied[sessionKey]
```

三句话：**开着的档位必须在你说得上话的每个会话里都成立；关着的档位不去动历史状态；
补刀只补一次（进程内记账）。**

判定抽成**纯函数** `decidePermissionPatch(...)`，好测、不带 IO。

### 2.6 失败必须说话

`patchSession` 失败（网关拒、掉线）**不能静默**：开关的打开动作要**回滚并报错**
（否则界面显示"全权已开"而实际没有 —— 这正是本项目反复栽的"界面在说谎"）。
发送兜底那一刀失败则**不许拦住发送**（照 `task.model` 那条的成例：尽力而为 + 警告日志）。

---

## 三、判据（实现完要逐条拿读数）

| #   | 判据                                                       | 怎么算过                                                                  |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | 默认档**一次 patch 都不发**                                | 单测：tier 默认时 `decidePermissionPatch` 恒回 `null`                     |
| 2   | 没同意之前切不成全权                                       | 组件测：不勾选 ⇒ 确认按钮 disabled；点了也不调 IPC                        |
| 3   | 同意后**当前任务**真的变全权                               | 真机：徽章变「全权」+ `sessions.list` 读回 `permissionMode:"full"`        |
| 4   | 全权档真能出工作区                                         | 真机：助手读到工作区外文件 / 跑通命令（已在探针里验过一次，验收再验一次） |
| 5   | 关掉后**当前任务**真的回到默认                             | 真机：徽章变回 + 读回不是 `full`                                          |
| 6   | 全权写失败 ⇒ 界面**不**显示已开                            | 单测：patch 回 `ok:false` ⇒ 开关回滚 + 报错                               |
| 7   | 「全权」文案里**不出现**"允许访问所有文件"这种没边界的空话 | 文案评审（写清具体后果）                                                  |
