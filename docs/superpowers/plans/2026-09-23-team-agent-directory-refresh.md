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
2. `runInstall` 收到 `done` 事件时调 **`finishTeamInstall`**（收尾三步的**唯一出口**）：
   **先 `await` 刷新 → 再 `setInstallStatus('done')` → 再 `onDone`**。
   - 顺序有含义：报"装完了"之前目录必须已新鲜，否则紧接着的「发起对话」照样会撞上陈旧目录。
   - ⚠️ 三步**只许出现在 `finishTeamInstall` 里** —— 内联回调用点的重排**现在测试能红了**（见下「P2」），但保持这个形状最省事。
   - ⚠️ 该缝的**隐含契约：注入的 `refresh` 不许抛**（容错住在 `refreshAgentCatalog` 的 catch 里，不在缝里）。

**刻意不做**：`runUpdate` 不加（它要求每个 agent 都已有 `existingAgentId` ⇒ 不会产生新目录项）；
层 2 的静默替换、D1/D2/D4 全部未动；核心安装器（`core/team-installer.ts`）不加 `refreshAgents` 注入点
（渲染层一处接线就够，且不必动 core 的公开形状）。

## 链子各环各自的钉子（这是"用户可见症状已修"的完整论证）

| 环                                      | 谁钉住                                                                                                                                       |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 装完**会去刷**（本刀新加）              | `test/use-team-install-refresh.test.tsx` 的 ⭐ 用例（断言 `fetchAgentsForGateway('gw-1', { force: true })` 被**恰好叫一次**）                |
| **刷完才算"装完了"**（顺序，复核者 I1） | 缝测试 `finishTeamInstall 的收尾顺序` + ⭐ `runInstall 必须等到刷新结束才返回`（M4'/M5' 各钉一半）**＋（见下「P2：调用点那一侧也钉住了」）** |
| `force: true` **真的换掉陈旧目录**      | `packages/core/test/gateway-dispatcher.test.ts:196`（既有）                                                                                  |
| 强刷**失败会抛**（所以必须 catch）      | `packages/core/test/gateway-dispatcher.test.ts:207`（既有）                                                                                  |

### ✅ P2：调用点那一侧**也钉住了**（我一度登记为"不可观测"，被复核者证伪）

**曾经的登记**：把 `finishTeamInstall(...)` 调用**内联回三步**（`setInstallStatus('done'); await refreshAgentCatalog(...); onDone?.();`）
⇒ 全套全绿（复核者实测、我复跑，**0 红**）⇒ 我当时登记成"已知边界：调用点这一侧不可观测"。

**⚠️ 那个"根因"是错的**（复核者用探针证伪）：**可观测**，只是要**在 `act` 作用域结束（= React 的 flush 点）之后**读
`installStatus`，而此时刷新仍被测试自己的 promise 握着。我两次失败的真实原因：
① 那次读**放在同一个 `await act(async () => …)` 作用域里** ⇒ 从头到尾**没发生过 flush**，读到的还是上一次渲染的对象（`idle`）；
② 用 effect 记顺序 ⇒ 两个顺序在日志里无法区分。

**现在**（promise 那条用例拆成两个作用域，作用域之间读一次）：

- 基线：`6 passed (6)`（**不假红**）
- **调用点内联重排** ⇒ `1 failed | 5 passed (6)`（**原来 0 红**）—— 只红那条
- `void` 化 ⇒ `1 failed | 5 passed (6)` —— 只红那条（同一条用例钉两件事，两条断言缺一不可）

⇒ **纪律**：React 里"飞行中的状态"不是读不到，是**要在 flush 边界之后读**；把读放在作用域里面 = 自欺。

## 账本

**测试名字级读数**（`cd packages/desktop && ./node_modules/.bin/vitest run test/use-team-install-refresh.test.tsx`）：
实现前 `1 failed | 2 passed (3)`（红：`⭐ 装完团队 ⇒ 强刷一次目录`，报文 `expected "spy" to be called 1 times, but got 0 times`）；
第三纪元（复核修复轮之后，最终）：**`6 passed (6)`**。加上既有工作区守卫文件：`2 files / 9 passed`。

### ⭐ 钉"顺序"这件事花了三次（全部实测，留档）

复核者 I1 指出"先 `await` 刷新再报成功"**没有任何测试钉住**（它自己的 `await`⇒`void` 变异 0 红）。我两次都钉错了：

1. **用 effect 把状态变化记进顺序账** ⇒ `setInstallStatus('done')` 挪到 `await` 之前，effect 仍晚于 `refresh:end` 才跑 ⇒ **假绿**（M5 第一版 0 红）。
2. **飞行中直接读 `api.installStatus`** ⇒ React 的 `act` 把更新攒到作用域结束 ⇒ 读到的是 `idle`（`expected 'idle' to be 'installing'`）。
3. ✅ **把收尾三步抽成可注入的 `finishTeamInstall`**（refresh / setStatus / onDone 全是参数）⇒ 缝测试用普通 spy 断定顺序，与 React 时序无关；
   再加一条**完全靠 promise** 的判据（"刷新还挂着 ⇒ `runInstall` 不许已返回"）。两条各有专属变异（M5' / M4'）。

⇒ 纪律（已按 P2 更正）：**React 里"飞行中的状态"不是读不到，是要在 `act` 作用域结束（flush 边界）之后读**；抽成可注入的缝最省事，但不是唯一做法。

**变异读数**（装置 `$TEMP/guard-mutate.mjs`，全部 `RESTORE_SHA256_EQUAL=true`）：

| #       | 变异                                                 | 实跑读数                   | 红名单（按名 ⇔ 它钉住的守卫）                                     |
| ------- | ---------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| M1      | 删 `await finishTeamInstall({...})`                  | `3 failed \| 3 passed (6)` | 强刷 / 失败不许变失败 / 收尾等刷新（**缺了它就是整段没做**）      |
| M2      | `{ force: true }` ⇒ 默认（不强刷）                   | `1 failed \| 5 passed (6)` | ⭐ 强刷那条（目录已存在时不强刷＝空操作）                         |
| M3      | 刷新失败改为 `throw err`（去掉容错）                 | `1 failed \| 5 passed (6)` | ⭐ 失败不许变成装失败                                             |
| **M4'** | `await finishTeamInstall(...)` ⇒ `void`              | `1 failed \| 5 passed (6)` | **只有** ⭐ `runInstall` 必须等到刷新结束才返回                   |
| **M5'** | 收尾重排（先 `setStatus('done')` 再 `await` 刷新）   | `2 failed \| 4 passed (6)` | 缝测试 + ⭐ 刷新挂着那条（P2 钉子加上之后**覆盖变强**，不是变弱） |
| **M6**  | `error` 分支里也加一行刷新                           | `1 failed \| 5 passed (6)` | **只有** ⭐ 生成器报 error ⇒ 不刷（走的是 error 分支，非预检）    |
| **P1'** | 调用点删掉 `onDone` 透传（复核者提）                 | `1 failed \| 5 passed (6)` | **只有** ⭐ 刷新挂着那条（**加钉子之前 0 红**）                   |
| **P2a** | 调用点**内联重排**（把本刀要修的缺陷原样搬回调用点） | `1 failed \| 5 passed (6)` | **只有** ⭐ 刷新挂着那条（**加钉子之前 0 红**）                   |
| M-CTRL  | 只改日志文案（等价）                                 | `6 passed`（0 红）         | —                                                                 |

⚠️ **时代标注**：本表全部是第三纪元（套件 6 条）读数；第一/二纪元的阶段读数见 `git log` 里各提交时的测试条数（3 → 4）。
⚠️ **各变异的"只红哪一条"**（复核者逐条复跑）：M1=3 红、M2/M3=1 红、M4'（`void`）=1 红、M5'=2 红（P2 钉子加上之后）、M6=1 红、P1'=1 红、**P2a=1 红**、M-CTRL=0 红。
**四条新断言各有专属变异**（复核者用不同断言行验证）：`:174`（`void` ⇒ `expected true to be false`）、`:177`（`onDone` 提前 ⇒ orderLog 非空）、`:184`（**内联重排 ⇒ `expected 'done' to be 'installing'`**）、`:194`（丢 `onDone` 透传 ⇒ 结束后 orderLog 为空）。

**两条可忽略的残留（复核者登记，本刀不改）**：

- **尾两步的相对顺序没钉**：`await refresh; onDone?.(); setInstallStatus('done');` ⇒ `6 passed`（0 红）。影响可忽略 —— `onDone` 就是 `loadTeams`，而刷新已先发生，用户看不到差别。
- `:185` 那条 `expect(finished).toBe(false)` 与 `:174` 同义重复（没有变异能区分）；留着不碍事。

⚠️ **M1 第一次拒跑**（`ANCHOR_HITS=0`）：我把含 `\n` 的锚点用单引号传进 bash ⇒ 那是**字面反斜杠 n**，
不是换行。装置照规矩拒绝执行（这正是它该做的），换掉 `\n` 后才是真读数。

**门禁**（`export PATH="/d/go-toolchain/go/bin:$PATH"`；重定向取 RC，**不用管道**）：

- 第一次（提交 `74ec54af`）：`GATE_EXIT=0`；`packages/desktop` **282 files / 2911 passed + 2 skipped (2913)**。
- 第二次（提交 `a6d11fc5`）：`GATE_EXIT=0`；`packages/desktop` **282 files / 2912 passed + 2 skipped (2914)**。
- 第三次（提交 `a93ea419`）：**`GATE_EXIT=1`** —— 见下。
- 第四次（提交 `2a5fb780`）：`GATE_EXIT=0`；`packages/desktop` **282 files / 2914 passed + 2 skipped (2916)**。
- 第五次（提交 `c8ebee31`）：`GATE_EXIT=0`；`packages/desktop` **282 files / 2914 passed + 2 skipped (2916)**。
- 第六、七、八次（补 P1/P2 钉子与注释修正）都是 `GATE_EXIT=0`；
  **定稿读数 = 第八次（提交 `ce439676`）**：`packages/desktop` **282 files / 2914 passed + 2 skipped (2916)**。

### ⭐ 第三次门禁红了，红在 `typecheck:tests`（"聚焦全绿 ≠ 门禁会绿"的实例）

```
test/use-team-install-refresh.test.tsx(150,9): error TS2322:
  Type 'Promise<void>' is not assignable to type 'Promise<undefined>'.
```

hoisted mock 写的是 `async () => undefined`（⇒ `Promise<undefined>`），而 deferred 那条用例给它 `new Promise<void>`。
**vitest 不做类型检查**（esbuild 只剥类型）⇒ 聚焦测试 + 7 条变异全绿，**只有全量门禁的 `typecheck:tests` 抓得到**。
修法：把 mock 按**真实签名**标注 `vi.fn<(gatewayId: string, options?: { force?: boolean }) => Promise<void>>(...)`。

⇒ 纪律：**"聚焦测试全绿"不能替代全量门禁** —— 本刀这条缺陷只有 `pnpm check` 能发现。

## 登记（本刀没做/没验）

- **层 2 仍在**：目录万一还是陈旧（例如刷新失败），用户得到的仍是"静默换成 main + 罗盘"，**没有任何提示**。
  要不要说出来 = 决定 D1（未拍）。
- **`runUpdate` 不刷**（理由见上）；若将来它开始创建 agent，这条接线要一起加。
- **本刀只证明"装完会强刷"**（各环各自的钉子），**没有**跑真机三击复现 —— 真机验收留给插盘那次。
- **"刷新"没有正典，而且有四种写法**（规格复核者偏差 3）：`force:true` 三处 + `Settings/sections/AgentsSection.tsx:682-689`
  直连 `listAgents` IPC + `setAgentCatalogForGateway`。**没有哪份文档说哪条是正典** ⇒ 将来接线的人可能选错，
  而**选错不报错、只静默陈旧**（本刀这类的症状）。登记。
- **一条"靠约定"的软边**：`components/AgentBuilderDialog/index.tsx:103` 的 `onCreated` 是**可选** props，
  刷新全靠调用方（`AgentsSection.tsx:1250`）记得传 —— 新增不传的调用方会静默复现同族缺陷。登记。
- **动态 import 的真实收益（规格复核者要求改口径，已改）**：它只买"**加载期**解耦"（不装团队的 importer 不必加载那条重链）；
  **走到 `done` 时整条链照样会加载**，代价只是从"模块加载失败"挪进 catch —— 既有 `use-team-install-workspace.test.tsx`
  正是这样吞掉一个 `TypeError`（~70ms → ~470ms）。要恢复原耗时，让该用例 mock `@/hooks/useGatewayDispatcherSetup`
  （照本刀测试的做法）。登记。
- **复核者对我这个变异装置的两条提醒（都是假绿入口，供后人）**：
  ① 装置的**第 4 个参数（测试文件）有默认值** `test/runtime-state-config.test.ts` ⇒ **漏传会去跑一个无关套件**、很可能报"全绿"；
  ② 测试文件路径写成了**仓库根相对**（而装置 `cwd: 'packages/desktop'`）⇒ `MUTATION_RC=1` + `READING=(空)` + `RED=(空)`，
  **看起来像"变异被杀"，其实是 "No test files found"** ⇒ 有效读数必须**同时**有非空 `READING`（failed 数非零）与非空 `RED`。

### 覆盖面（规格复核者穷举，供后人省一次考古）

渲染层能建 agent 的原语只有 **3 个** `window.clawwork.createAgent` 调用点
（`useTeamInstall.ts`、`lib/agent-builder.ts`、`lib/preset-agent-installer.ts`）；把全部入口映射到这三条上之后：

- **团队侧没有第二个入口**：`installTeam` 全仓只有 `useTeamInstall.ts:185` 一个调用点；
  `TeamBuilderDialog` / `CreateTeamWizard` / `useTeamHubInstall` 全部经过 `runInstall` ⇒ **继承本刀的刷新**。
- **非团队侧无一漏刷**：预置助手（装前/装后各一次）、市场模板、设置里新建、`MainArea` 目标路由建助手 —— 都有刷新。
- **装失败 ⇒ 不刷是安全的**：core 的三条 `error` 出口都先 rollback（`team-installer.ts:247/:254/:278`），
  报 error 时不会留下新 agent；而"部分成功"（有的 agent 建失败只是 warning）仍走 `done` ⇒ **覆盖到了**。

### 确认轮（2026-09-23，代码质量复核第二遍）

**结论：可交付**（I1/I2 经它独立复现确实各钉一半；`typecheck:tests` 那一刀它用同一条命令验到 `TSC_RC=0`）。
它另外加了三条自己的变异，其中两条打穿了我的钉子：

| 它的变异                         | 实跑读数                                           | 处置                                                                                                                                          |
| -------------------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **P3** 默认 `refresh` 换成 no-op | `2 failed \| 4 passed` ⇒ 强刷那条 + promise 那条红 | **好消息**：证明"默认走真强刷"这一支是活的（不是测试专用死分支），无需改                                                                      |
| **P1** 调用点删掉 `onDone` 透传  | `6 passed`（0 红）                                 | **已修**：promise 那条加了「刷新还挂着时 `orderLog` 必须为空」+「结束后等于 `['onDone']`」；现在该变异 **`1 failed \| 5 passed`**（只红那条） |
| **P2** 调用点内联重排            | `6 passed`（0 红）                                 | **登记为已知边界**（见上），调用点加硬注释                                                                                                    |

它同时确认：`finishTeamInstall` 全仓只有 1 个生产调用点 + 1 个测试 import（无 barrel、无死代码风险）；
新 mock 的注解与被 mock 的真实导出**逐字一致**（`useGatewayDispatcherSetup.ts:170`）。

⚠️ **它提的一条流程风险（值得记）**：两个复核者**同时在同一个 worktree 上跑变异**（各自会改写并还原同一个源文件）——
本次靠"跑前跑后哈希 + `RESTORE_SHA256_EQUAL` + `git status` 干净"自保、结果一致，但**并行跑变异是真实风险**。
⇒ 纪律：**复核者之间要串行**（或各用自己的 worktree 副本）。

### 代码质量复核（2026-09-23 第一遍）的处置

**已修（两条 Important）**：I1（顺序没被钉住）与 I2（"失败不刷"只走了预检、error 分支无钉子）——见上面两张表与「钉顺序花了三次」。

**登记（本刀不改）**：

- **I3（别处）**：`MarketPanel/useTemplateInstall.ts:39-45` 的 `refreshAgents` **没有 catch** ⇒ agent 已建好之后强刷失败，
  错误沿 `lib/template-install.ts:91` → `MarketTab.tsx:93`（无 try/catch）冒出去 ⇒ 用户**既看不到成功也看不到失败**。
  本刀只借用了它的**动态 import 写法**，容错做得比它好。收口是一行 try/catch（登记，不塞进本刀）。
- **M1**：刷新失败只落 renderer console（`useTeamInstall.ts:36`），**进不了真机取证用的 ndjson**；
  项目更可取的通道是 `window.clawwork.reportDebugEvent`（先例 `AboutSection.tsx:176`）。
  另有实测：把 `console.error` 整行删掉（空 catch）**没有任何用例变红** ⇒ 新 catch 的**诊断**那半边没有钉子。
- **M2**：`rollback()` 容忍删除失败（`team-installer.ts:287-295` 只 warning）⇒ 极窄窗口里网关留下 agent、客户端目录里没有它
  （**重启自愈**）。触发条件窄，登记。
- **M3**：`done` 现在被一次网关往返顶住（最坏 `REQ_TIMEOUT_MS = 15s`），期间向导只有一个禁用按钮 —— **不是回归**
  （前面几步本来就是同一量级），但代价要记下来。
- **M4**：`runUpdate` 的"不会创建 agent"守卫在 `CreateTeamWizard.tsx:144`（`agents.every(existingAgentId)`；`:145` 才是那次调用），
  **不在 hook 里**；hook 内部用的是 `a.existingAgentId!`。将来出现第二个调用方要同时看这两处。
- **M5（已就地修）**：账本里 M-CTRL 的版本戳、以及"链子"表缺顺序那一环，本轮都已补齐。
- **动态 import 的真实代价（复核者实测）**：既有用例 `use-team-install-workspace.test.tsx` 现在也会**加载整条网关链**
  （该例耗时 ~70ms → 541ms，并静默吞掉 `deps.gateway.listAgents is not a function`）——
  注释里"静态引入会让既有测试**加载失败**"属实，但动态引入**不能**避免它在测试里被加载，只是把失败搬进了 catch。登记。
- **理论竞态（复核者"没找到但值得记"）**：`fetchCatalogs`（网关重连时）与本刀强刷并发时，前者响应可能后到并覆盖（窗口≈一次 `agents.list` 往返）。
  既有那 3 处 `force:true` 同样暴露，无序列号可依赖 —— **不处理**，登记。
