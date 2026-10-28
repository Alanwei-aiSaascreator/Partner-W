# WorkBuddy 对话改造：Codex 独立审核与修订方案

审核结论：**REVISE BEFORE IMPLEMENTATION**。可以沿用 Claude 的任务拆分与现有组件，但不能按原计划直接实施。最重要的修改是：运行中的工作过程直接可见，完成后的成功过程才允许单层折叠。

本轮只分析产品源码、计划和本机安装产物；未修改产品代码、原计划、暂存区，未提交、构建、部署或发起模型请求。以下验收项是待实施要求，不是已通过的测试。

## 1. 核对对象与证据边界

- Partner-W源码工作树：`D:\Desktop\new project\partner-w\partner-w-desktop\.worktrees\codex-release-blockers`。
- HEAD：`5c3391e1b7d6235b32ef1daca226f4ce361c808d`；有未提交修复，分析包含当前工作区，不把它描述为纯提交快照。
- 现有修复批：43 个 tracked 修改 + 1 个 untracked 测试 = 44 个文件；原计划另计，不属于这 44 个。
- 审核计划：[Claude 原计划](<D:/Desktop/new project/partner-w/partner-w-desktop/.worktrees/codex-release-blockers/docs/superpowers/plans/2026-10-08-chat-revamp-workbuddy.md>)。
- 本机真实安装：`D:\workbuddy\WorkBuddy.exe`，FileVersion 5.7.6，ProductVersion 5.7.6.0，与截图一致。
- 安装包：[app.asar](/D:/workbuddy/resources/app.asar)，211,193,422 bytes，SHA256 `A0DF3628A73D65AFBCC6750B8FE5D98A19DFE7F0811687DBC6C1B9C4521B893A`。
- 复刻目录：[README](</D:/work Buddy data/2026-10-08-17-02-00/workbuddy-replica/README.md>) 是辅助参考；与安装包冲突时，以安装包及真实截图为准。

`app.asar` 内是编译压缩后的前端代码，可以核对组件行为和 CSS；它不是原始源码仓库，也不能据此认定 WorkBuddy 开源。本次没有操作 WorkBuddy 会话，没有读取其用户聊天、密钥或账户数据。用户提到的 Warp AI 在本次证据中对应的是 WorkBuddy，未混用另一款产品的实现。

## 2. 真实 WorkBuddy 的关键行为

| 项目     | 安装产物核实结果                                                    | 对Partner-W的适配要求                                              |
| -------- | ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 工具动作 | 直接文字行，14px / 1.75，gap 8px，tertiary 色，无工具大卡背景边框   | 运行时直接显示“读取资料”“列出目录”等具体动作                       |
| 思考标题 | reasoning converter 使用 `reasoning.title`；截图为“深度思考”        | 使用静态标题；仅展示模型实际返回的思考文本                         |
| 思考展开 | `expand = isLastContent`，`streaming/autoScroll = !isFinished`      | 跟最新内容及结束状态走，不用“工具数组曾否非空”猜阶段               |
| 时间     | `TurnStatusLine` 读取 processingStartedAt / completionDurationMs    | “已处理 6s”是回合处理时间，不是单独的思考时间                      |
| 收起     | 工具、思考可进入 summary/process 折叠；正文保留                     | 允许完成后单层收起成功过程；不能运行时先藏进三层按钮               |
| 等用户   | 提问、批准有专门呈现，不等同于后台持续执行                          | 静态等待提示，保留真实批准/回答入口                                |
| 失败     | 工具错误图标仍 tertiary；独立错误块为 danger，12px，padding 6px 8px | 本项目建议错误说明用现有 13px 档；不要把“整行变红”称为安装包实测值 |
| 动效     | 工具图标 1.2s；扫光 2.2s；折叠 .28s；支持 reduced-motion            | 只在有依据的运行状态使用动效，等待批准停止动效                     |

证据定位（以下 offset 为读取 UTF-8 后 JavaScript 字符串的 UTF-16 索引，不是文件字节或源码行号）：

| ASAR 内资源                                | SHA256 / 定位                                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `renderer/assets/lib-chat-ui-B-axvvx6.css` | `62a137c2af0c442e2568822db97c93a00bf92650a785f46ed87a393a63303acf`；tool-head 746191，error 745829，reasoning 798140                                            |
| `renderer/assets/lib-chat-ui-CHONh1NB.js`  | `f57ef7b9be3d445ae54051b3b94b649266177e019e92ec4477352fc5bde64073`；reasoning converter `rHn` 4621835，TurnStatusLine `vBn` 4597250，summary fold `ekn` 4444784 |

## 3. 实施前必须修改的计划项

### P1：Task 4 只改样式，仍保留三层操作

计划 L287–288 改的是卡片和触发器外观，没有删除外层摘要折叠、分组折叠、单工具详情折叠。

源码：[ToolCallSummary](<D:/Desktop/new project/partner-w/partner-w-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/components/ToolCallSummary.tsx:144>) 默认 `expanded=false`，还有 `groupOpen/cardOpen`；L343 起才条件渲染工具组。

**修订：**保留既有统计、去重、状态判据，替换展示层。运行时按既有调用顺序平铺工具标题、状态和错误原因；只让参数/返回值进入单条工具的一个详情展开。成功结束的历史过程可放入一个总折叠。等待批准、仍运行、失败且未解决的行始终露出。不能通过三次点击才能看到失败原因。

### P1：Task 1 的文本计时 Map 应删除，Task 2/3 的阶段判定应重写

计划 L61–64 用思考全文作为 Map 键。不同任务相同文本会串时长；L142/L182 在文本 effect 无条件写入，定稿重新挂载可能覆盖为约 0ms。L247 的 `toolCalls.length === 0` 使工具后的再次思考被误判为完成。

源码：[AssistantBlock](<D:/Desktop/new project/partner-w/partner-w-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/components/AssistantBlock.tsx:254>) 在流式/定稿切换时替换 body；[message-store](<D:/Desktop/new project/partner-w/partner-w-desktop/.worktrees/codex-release-blockers/packages/core/src/stores/message-store.ts:501>) 保留本轮已结束工具。

**修订：**取消“思考了约 N 秒”及全文 Map，保留“深度思考”。计时归稳定的回合展示父组件，身份用 workspace/task/session/turn，已有 runId 时同时核对；不把昵称或思考文本当身份。历史没有可靠结束耗时就只显示“处理结束”，不估算秒数。思考段的展开状态分别处理自动收起与用户手动折叠，新 delta 不应强行展开用户刚收起的同一段。

特别注意：不能照搬 `useTurnActivity.active` 作为完整生成周期。源码 [gateway-dispatcher L1074](<D:/Desktop/new project/partner-w/partner-w-desktop/.worktrees/codex-release-blockers/packages/core/src/services/gateway-dispatcher.ts:1074>) 在首个正文 delta 即 `setProcessing(false)`，并删除等待起点。优先复用现有时间格式、状态工具；完整回合计时需在稳定父层保留本轮真实起点与终止边界。无法获得可靠边界时降级为静态状态，不伪造“正在思考”。流式正文不等于终止，模型终止不等于文件交付完成。

### P1：Task 7 尚未达到与右栏“同源”的要求

计划 L437/L453 每条消息独立查询完整任务，只有 mounted 守卫。缺失工作区切换后迟到 IPC 的归属校验；同时挂载 N 条历史消息会发 N 次相同查询。

源码：[RightPanel](<D:/Desktop/new project/partner-w/partner-w-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/layouts/RightPanel/index.tsx:46>) 已使用 scopeKey、实时 workspaceEpoch、request sequence 与渲染 scope 校验。

计划还先按 messageId 过滤，再归并版本。新版在 m2、旧版在 m1 时，这会让 m1 的旧版重新被叫作 current。右栏是在完整任务上先归并。L441 的 `报告-3f2a1b8c.pptx` 与 `报告.pptx` 在现有族规则下也并非同族，测试预期错误。

**修订：**在聊天任务层集中做一次任务水合，按 workspaceEpoch/task/gateway 复用请求与快照，消息层仅选择。先对完整任务调用现有 `groupArtifactVersions`，再按 messageId 分配 current。迟到成功、迟到失败与渲染快照均核对归属；`artifact:saved` 更新/失效走现有订阅，不因复用 Promise 永久冻结缓存。旧版本仍属于历史，不能以最新版卡片重新出现。

真实族规则：[artifact-versions](<D:/Desktop/new project/partner-w/partner-w-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/lib/artifact-versions.ts:29>)。测试用 `报告-3f2a1b8c.pptx` 和 `报告-7c4d2a90.pptx`，并覆盖跨消息新版胜出、missing 新版回退及 unknown 状态。unknown 只能显示待核对，不能报交付成功。

### P1：错误“可见”仍不等于用户知道为什么失败

原计划 L19/L272 将 `tool-activity.ts` 完全锁定，Task 4 仅去掉 truncate。现有 [productizedToolFailure](<D:/Desktop/new project/partner-w/partner-w-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/lib/tool-activity.ts:242>) 对无法分类的英文仍返回统一兜底。“文件路径缺失”“本地文件误走节点传输”“工具不存在”可能继续显示相同的“这一步暂时无法完成”。核心工具 `read` 也没有被当前 EXACT_KINDS 识别，继续叫“使用工具”。

**修订：**允许增加小范围展示映射：对有错误原文依据的已知形态给具体中文说明，未知错误明确为未知并提供脱敏诊断入口。若分类函数也影响重试/降级，则不扩展其执行语义，单独添加仅展示的说明映射。禁止猜测截图中那三次错误的实际原因。

普通用户默认看动作、原因与可行动提示；详情看真实工具名、脱敏参数、脱敏结果。现有 [ToolCallCard L239](<D:/Desktop/new project/partner-w/partner-w-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/components/ToolCallCard.tsx:239>) 已展示 sanitizedResult，计划“原始载荷只进 console”应改为明确的脱敏展示边界。自动重试证据、计费与真实失败状态不能被 UI 映射改掉。

### P2：Task 5 fence 奇偶法有实证反例；Task 0 暂存命令范围过大

计划 L351 的 fence 计数不能分辨开闭符号和长度。用项目现有 ReactMarkdown 依赖的 remark parser 做只读内存对照：四个反引号开头、三个结尾被计划误判为已关闭；反引号开头、波浪线结尾也误判关闭；合法关闭但内容含短 fence 会误判未关闭。符合 [CommonMark fenced code blocks 规范](https://spec.commonmark.org/0.31.2/#fenced-code-blocks)。

**修订：**利用现有 Markdown 解析链中 code 节点位置和对应原文核对最终 fence，不新造通用 Markdown 引擎。确认真实 pre/code wrapper 后增加生成状态，docgen/htmlgen 专用块不应被通用 CSS 错套。

计划 L44 的 `git add -u` 会收编全部 tracked 修改，不是 44 文件白名单。快照前由修复 owner 冻结已知清单，再逐个显式暂存；原计划和本审核文档分别管理。不得将后来出现的并行工作自动纳入。

## 4. 建议最终界面与状态规则

以下是方案示意，时间、动作和文件仅为示例，不代表已有任务验收结果：

```text
主罗盘
已处理 6s

⌄ 深度思考                    ← 当前思考段，可手动收起
  [模型实际返回的思考文本]
✓ 读取推广资料                ← 动作直接看见
✓ 列出目标文件夹内容
◌ 正在生成推广方案

等待模型响应                  ← 与工具状态分开
```

失败时直接出现“读取资料失败：缺少文件路径”，仅在实际返回 missing path 时使用这句话。批准时直接出现“等待你允许读取文件夹”及真实授权入口，图标与文字静止。成功结束后可显示一个“查看处理过程”，其下正文、可用文件卡保持直接可见。

稳定组件结构建议：复用 MessageBlock 与 AssistantBlock；在稳定父层放回合状态和计时，在子层放 ThinkingCollapse、平铺工具行、MarkdownContent、ArtifactCard。无需为每个工具加新的 Mini UI 或二级分组按钮。Tools 很多时可将较早的已成功动作收成一层，当前动作、待批准动作及未解决失败保持露出。

状态数据由已有源导出，不新建 runtime/store/IPC：

- 工具事实：已有 ToolCall status / 时间 / 去重与归并函数。
- 等批准：`latestAwaitingApproval`；等回答：现有 questionStore 的当前 task/session 请求。两类不混用，另一任务的问题不得使本任务静止。
- 生成阶段：已有流式内容、本轮身份及真实终止边界；`processing` 不能独自判终止。
- 交付阶段：现有 ArtifactDeliveryActivity、产物校验/登记与 availability，不使用模型自称“生成成功”。
- 显示金额只接真实计费来源；没有真实值就省略，不仿造截图的 0.03 或估算扣款。
- 工具失败后若已有替代路径成功，保留失败事实，可标明已恢复；不能把整个任务永远挂成红色失败，也不能删除原错误伪装全程成功。

## 5. 对原 Task 0–8 的具体修订

| Task   | 执行要求                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------- |
| 0 基线 | 建议先由 Claude owner 对 44 文件做独立批次快照；使用固定白名单，保留修复证据，本轮未代执行        |
| 1 计时 | 删除思考文本 Map；改稳定回合父层的真实计时，不能在首个正文出现时结束完整回合计时                  |
| 2 思考 | 静态“深度思考”；最新段自动展开、结束自动收起、尊重用户操作；只显示实际思考文本                    |
| 3 接线 | 保留稳定头像/父节点/key；流式和定稿共用同一个过程展示规则；工具后再次思考不得因历史工具存在被关死 |
| 4 工具 | 平铺运行过程；只保留单条详情；收尾可单层折叠；补准确动作名和依据充分的错误说明                    |
| 5 正文 | 15px/1.75 可沿用；光标只在实际正文流式；代码状态依解析结果核对，不用 fence 奇偶法                 |
| 6 等待 | 批准与 ask_user 两类等待都静态；提交/取消复用现有通道；批准拒绝、过期与恢复均需覆盖               |
| 7 文件 | 任务级水合/请求复用/epoch 守卫；完整任务先归并后按 messageId 分发；未就绪与无回答分开显示         |
| 8 收口 | 单 owner 完成后独立 review；定向测试齐全后跑一次完整 gate；真实 UI 验收不能只断言 class 名        |

旧的三条“思考内容绝不上屏”测试允许有意改写，因为用户明确要求可折叠思考；保留“思考不是最终回答”“未产出不能假成功”两条语义。不要为了让 textContent 断言保持旧样子而把用户要求的思考正文永远藏掉。

**执行方式推荐 Native，单 owner 按依赖顺序实施。** AssistantBlock、theme.css 与工具布局耦合，多个实现者改相同文件只会增加合并风险；只读审查可并行。独立 review 后修完再统一验证。

## 6. 必须补入验收的真实场景

1. 无任何输出的等待 → 思考 → 工具 → 再次思考 → 正文 → 结束；当前工具和思考无三层点击，头像/正文不重新挂载。
2. 同文本不同 task/run 不串时长；切任务、定稿重挂载、重启历史不编秒数；首个正文出现后仍生成时，状态不得提前完成。
3. 等批准与 ask_user：没有转圈扫光；真实按钮有效；拒绝/取消/过期可退出；另一任务请求不污染当前任务。
4. 三个不同真实工具错误产生可区分的准确说明；未知原因如实；重复错误次数正确；脱敏路径和凭据不泄漏。
5. 工具失败后替代路径成功：错误事实保留、恢复状态准确；不新增会再次收费的假“单工具重试”按钮。
6. 同任务多条消息同时挂载只进行一次初始整任务水合；artifact:saved 后刷新；切 workspace 复用同 ID，旧成功/失败回包均不得更新当前展示。
7. 跨消息同族新版胜出、缺失新版回退、unknown 未核对状态；聊天 current 与右栏一致；水合/交付中不得闪出“无回答→重新尝试”误导按钮。
8. 文件仅在 generate → write → validate → register → 可重新打开后报交付成功；模型结束但文件尚未登记时继续展示交付状态。
9. 长代码流、四反引号、混合 fence、引用/列表中的代码与 docgen/htmlgen 专用块；光标、复制按钮和生成状态均正确。
10. 亮色/暗色、窄窗口、滚动离底后新输出、展开历史、键盘操作及 reduced-motion；录屏对照用户截图与真实 WorkBuddy。

本次执行的验证是：Git/安装版本/ASAR hash 实读、压缩组件和 CSS 核对、项目源码审阅，以及 fence 方案与现有 parser 的 3 个内存反例。两个真实只读审查员分别复核思考生命周期与产物接线，均未修改代码。未运行产品测试套件；本审核不能替代实施后的 UI/gate 结果。
