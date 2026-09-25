# 切回助手时回到它最近那次对话 —— 实施记录

**Goal:** 从 A 切到 B 再切回 A，主区**回到你上次跟 A 说到哪**，而不是一片欢迎屏。

**依据（真机复核 2026-09-25）**：同事四条反馈里的 **②「来回切换管家内容会丢失（不知道在哪里找到）」**。
当日**定性**：**内容没丢** —— 三个任务都在「最近任务」里；丢的是**回去的路**。
见 `2026-09-25-real-machine-acceptance.md` 的三·五节。

**参考**：WorkBuddy 5.6.2（本机 `F:\edge doenloads\WorkBuddy`，读的是它的 asar 结构，没抄代码）。
它的信息架构是**项目 → 会话**，而且会话是**可寻址的**（`conversation-route-redirect`、
`task-deeplink-coordinator`）⇒ "回到某段对话"在别人那里是**一等公民**，不是靠用户自己翻列表。
我们这边**原语早就有了**（`setActiveTask(id)`，点任务行就是它），差的只是**切换时不去调它**。

---

## 改了什么

| 层     | 文件                                                                                | 内容                                                                                      |
| ------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 纯函数 | `src/renderer/lib/task-sort.ts`                                                     | 新增 `mostRecentTaskIdForAgent(tasks, agentId)` —— 该助手**最近更新过**的那条（归档不算） |
| 接线   | `src/renderer/hooks/useSelectAgent.ts`                                              | 第 3 步：`setActiveTask(null)` → `setActiveTask(该助手最近那次对话)`                      |
| 测试   | `test/task-visibility.test.ts`（+10）/ `test/use-select-agent.test.tsx`（+1、改 1） | 见下                                                                                      |

**归属判定复用 `resolveTaskAgentId`**（显式 `agentId` 优先，否则从 `session_key` 推断）——
和 `visibleTasksForAgent` 是**同一个坑**：`tasks` 表没有 `agent_id` 列，库里读回来的任务是 `undefined`，
只认 `agentId` 会一条都匹配不上。

**没有新文案、没有新 UI、没有新表** —— 只是把已有的"打开某段对话"原语在切换时用上。

---

## 读数（本机实跑）

- 新增/改动测试：`task-visibility.test.ts` **17** 条（原 8 + 新 10，含 1 条网关口径）、
  `use-select-agent.test.tsx` **4** 条（+1、改 1）⇒ 两个文件合计 **22** 条基线
- TDD 两段红：
  1. 纯函数先红：`mostRecentTaskIdForAgent is not a function`，9 条新用例全红、8 条既有全绿；
  2. 接线再红：**断言级** `expected null to be 'office-新'`（证明测的是行为，不是"函数存在"）。
- **变异电池 11 条 = 9 杀 + 2 对照，RC=0**（`switchrestore-mutation.mjs`），
  收集数 **22/22** 全程不变、锚点全唯一、还原逐字。杀掉的改法：
  不看归档 / 不看归属 / 归属只认 `agentId` / 取最旧 / 取"第一条匹配的" / 去掉 null 兜底 /
  退回无条件清空 / 拿到手随便给一条 / 只恢复会话不走对话页。
- `pnpm check` **RC=0**（19 步全跑完，日志 0 个失败标记）：desktop **3253 passed / 2 skipped**（3255）、
  core 673、shared 124、pwa 61。
  ⚠️ 首轮门禁**栽在本文件自己的 `format:check`**（我一边跑门禁一边写文档）——
  本工作树 `format:check` 是真信号，见 `[[format-check-windows-false-red]]`。

## 执行期发现

1. ⭐ **一条"等价变异"如实存活**（C2）：去掉 `if (!agentId) return null;` 这条守卫，
   测试**全绿** —— 因为空串永远匹配不上 `resolveTaskAgentId` 的结果（它至少回 `'main'`）。
   ⇒ 这条守卫**是防御性的**，不是行为。**留着**：它把"空串不是谁都要"写成了代码，
   比藏在注释里强；但它**不可被测试证伪**，所以别拿"有守卫"当验证过的证据。
   —— 与 `[[stale-green-tests]]`、`[[verify-your-own-verifier]]` 同族。
2. ⚠️ **上一条报告里我说"「最近任务」不按助手过滤"是可疑的 —— 撤回，那是设计。**
   `LeftNav/index.tsx:35` 写明它被**有意**做成"全量、可搜、可筛、**跨助手**"。
   ⇒ **不加过滤**。要改的是"切回来自动站在哪"，不是"列表里有什么"。
3. ⚠️ **刻意没按网关过滤**（有测试钉住口径）。理由：任务列表本来就不按网关过滤
   （`filterTasksForPanel` 只看状态与标题），而 `tasks.gateway_id` 有 `DEFAULT ''` ——
   拿它当判据会**重演**「43 个任务没有 agentId ⇒ 整片失配」那次。多网关是例外形态；
   真要收紧，先想清楚老行怎么办。
4. ⭐ **置顶刻意不参与**（有测试钉住）：这里问的是"上次跟它说话说到哪"，是**时间**问题；
   置顶是"这条我想随手够得着"，是**收藏**问题。混起来会出怪事 —— 刚跟它聊完 A、切走再切回，
   却因为 B 是置顶而撞进 B。⇒ **别改用 `compareTasksForSidebar`**（虽然列表用的是它）。
5. ℹ️ **"想开新的"不用靠切助手**：`startNewTask` 现成（左栏「新建任务」、快捷键、命令面板同一个），
   所以自动恢复会话**不会**把用户困在旧对话里。这也是敢做这一刀的前提。

## 边界（没做的）

- **不碰** `layout/TasksPanel` 的过滤（见发现 2）。
- **不碰**网关维度（见发现 3）。
- **不发版**：这一刀只在 `fix/portable-update-gaps` 上，盘上的 0.0.27 还是老行为。
