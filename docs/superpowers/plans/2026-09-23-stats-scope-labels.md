# 统计页口径标注（split-brain）——实施与账本

**日期**：2026-09-23 · **分支**：`fix/stats-scope-labels`（基线 `608882ff` = 发布线 `fix/local-credential-exposure` 当前指针）

## 症状与判据

**用户可见**：在**同一块盘**上换账号之后，统计页的上半（额度/积分）说的是**新账号**，下半（任务/消息/文件/助手排行）说的是**上一个账号**在该盘上的活动 ⇒ **一页描述两个人**。
[[per-account-vs-per-disk-survey]] 的原话：这是**唯一**用户看得见"App 不知道自己是谁"的地方，且**便宜且独立**。

**判据不是我发明的，是代码自己写的**（`main/stats/aggregate.ts:15-23` 头注释）：

> ⚠️ 这里有**两个口径**，别混：任务数/活跃天数/消息数/文件数/网关排行/Agent 排行 ⇒ **本机** SQLite；
> `modelUsage` 与 `last30d` ⇒ **账号级**，来自服务端计费表。**两者数量级和含义都不同，界面上必须标出来**
> （否则用户会以为数字对不上）。

两条链各自的来源（当场重读）：

| 页面上半                               | IPC                           | 实现                                                                    | 口径             |
| -------------------------------------- | ----------------------------- | ----------------------------------------------------------------------- | ---------------- |
| 额度/积分/模型消耗/最近 30 天          | `commercial:account-overview` | `main/commercial/auth.ts:422`（读 session 的 org → 服务端）             | **账号**         |
| 任务数/活跃天数/消息数/文件数/助手排行 | `stats:get-dashboard`         | `main/ipc/stats-handlers.ts:6` → `getSqlite()` + `collectDashboardData` | **本机（按盘）** |

## 缺口（实测，非推断）

页面上**大部分**数字已经带口径（`Tile` 的 `hint`、`SectionHeader` 的 `scope`），但有两处**没有**：

1. 🔴 **「账户积分」卡底部那行 `totalMessages · totalArtifacts` 无口径** —— 而它是**本机**数字，坐在一张**账号**的卡里
   ⇒ 换号后同一张卡上下两半是两个人的数。**这是最重的一处**（卡片的标题就在说"账号"）。
   2 「**助手排行**」（`data.breakdowns.agents`，本机）那张 breakdown 无口径，且与旁边的"账号"卡并排。

## 改动（只标口径，不动数据）

[`layouts/Dashboard/index.tsx`](../src/renderer/layouts/Dashboard/index.tsx)：

1. `BreakdownTile` 增加可选 `scope?: string` —— **沿用 `SectionHeader` 同一个样式**（`type-meta` + 描边小标签），不发明新控件。
2. 「助手排行」传 `scope={t('dashboard.localScope')}`。
3. 「账户积分」卡底部那行改成 `本机 · 消息 N · 文件 M`（前缀 `dashboard.localScope`）。

**刻意不做**：更深的修法（换号时把本机那半清空 / 按账号分区 / 让本机数也按账号过滤）**是承重决定**
（[[per-account-vs-per-disk-survey]] 的 D1：一块盘是私人物件还是共享物）⇒ 本刀只把口径标清楚，不猜产品语义。

## 账本

**测试名字级读数**（`cd packages/desktop && ./node_modules/.bin/vitest run test/dashboard-overview.test.tsx`）：

- 实现前：`1 failed | 3 passed (4)`（红：`⭐ 每个数字都标出它是「本机（这块盘）」还是「账号」—— 换号后这页不许同时描述两个人`）
- 实现后：**`4 passed (4)`**

**变异读数**（装置 `$TEMP/guard-mutate.mjs`，全部 `RESTORE_SHA256_EQUAL=true`）：

| #      | 变异                                        | 实跑读数               | 红名单                     |
| ------ | ------------------------------------------- | ---------------------- | -------------------------- |
| M1     | 去掉「助手排行」的 `scope`                  | `1 failed \| 3 passed` | ⭐ 口径那条（断言 ②）      |
| M2     | 去掉消息/文件行的 `本机 ·` 前缀             | `1 failed \| 3 passed` | ⭐ 口径那条（断言 ①）      |
| M3     | 把「模型消耗」的 `accountScope` 改成本机    | `1 failed \| 3 passed` | ⭐ 口径那条（断言 ③ 反向） |
| M-CTRL | 只改一处无关文案（`dashboard.actualModel`） | `4 passed`（0 红）     | —                          |

⚠️ **M3 第一次拒跑**（`ANCHOR_HITS=2`）：`scope={t('dashboard.accountScope')}` 在页面里**有两处**
（模型消耗、最近 30 天）—— 装置照规矩拒绝执行；换成含 `text={t('dashboard.modelUsage')}` 的更长锚点后才是真读数。
⚠️ **时代标注**：三条 M 的读数都在套件 4 条时取的。

**三条断言为什么不是空转**：M1/M2/M3 各只红同一条用例、但**红在不同的断言上**（各缺一处时只有对应断言失败）；
对照 0 红 ⇒ 这批红不是"什么都红"。

**门禁**：见下（`pnpm check`，重定向取 RC，不用管道）。

## 测试自身踩的两个坑（留档，都与"读到的不是你以为的那个东西"同族）

1. **`byContaining()` 最初用 `find`（文档序第一个）** ⇒ 拿到的是**包裹整页的祖先节点**，它的 `textContent` 天然包含别处的口径 key
   ⇒ **断言会假绿**。改成取**最深**的那个（`.filter(...).at(-1)`）才指到那一行。
   ⚠️ 我在这条测试的注释里刚写完"`textContent` 包含会因为别处也有而假绿"，转头就犯了同一个错。
2. **`SectionHeader` 的标题是 `<span>` 不是 `<div>`** ⇒ 只查 `div` 时取到 `undefined`，报"arguments invalid"。
   选择器要写成 `'div, span'`。

## 登记（本刀没做）

- **更深的修法**（换号清空 / 按账号分区 / 本机数也按账号过滤）= D1 承重决定，未拍 ⇒ 不做。
- 本刀**没有**动数据层（`aggregate.ts` 的聚合与两条 IPC 一律照旧）。
- 「运营后台」mock 那一件**不在本刀**（它需要用户给出真控制台地址，见另一条线）。
