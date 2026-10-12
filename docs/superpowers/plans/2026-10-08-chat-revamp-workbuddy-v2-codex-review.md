# WorkBuddy 对话改造 D:\workbuddy\（版本 37.10.3-24，从 D:\workbuddy\version 读取）

添加到对话
路径 内容 大小
D:\workbuddy\WorkBuddy.exe 主程序可执行文件 约 204 MB
D:\workbuddy\resources\app.asar 应用主体代码（打包归档） 约 211 MB
D:\workbuddy\resources\app.asar.unpacked\ 无法打包进 asar 的部分（原生模块、CLI） —
D:\workbuddy\resources\install-manifest.json 安装清单 8.4 KB
D:\workbuddy\Uninstall WorkBuddy.exe 卸载程序 —
D:\workbuddy\RepairApp.exe 修复工具 —
D:\workbuddy\locales\、Assets\、share-target\ 语言包、资源、分享目标 —v2：Codex 复审

**REVIEW STATUS: CHANGES REQUIRED**。v2 已解决上一轮主要展示结构问题；仍有 4 项 P1 接线/判据问题及少量必须补齐的边界。按下列规则补入计划后进入 Native 实施，无需重写整个方案。此状态是计划审核结果，不是产品 release 状态。

审核对象：[实施计划 v2](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/docs/superpowers/plans/2026-10-08-chat-revamp-workbuddy.md>)，326 行，SHA256 `1AC3D21CF2EE92D09C9D57CD920D210B480A4810275CE5DBD5A25A4FE52BFD92`。桌面工作树 HEAD 仍为 `5c3391e1b7d6235b32ef1daca226f4ce361c808d`，修复 WIP 为 43 个 tracked 修改 + 1 个 untracked 测试，文档另计。当前事实源已读 `D:\claude\mofang\DELIVERY_STATE.md`，本审核不改变交付状态。

本轮只读源码、计划及运行内存对照；只新增本审核文档。没有修改产品代码、原计划、Git 暂存区或提交，也没有构建、部署、生产操作、付费模型调用或运行产品全量测试。

## 已接受，不再要求反复改稿

- 运行过程平铺，取消分组折叠，单条参数/结果只留一个详情入口。
- 静态“深度思考”标题；删除以思考文本为键的计时 Map。
- 保留定稿正文惰性挂载：理由是长思考内容性能；测试按流式可见/展开可见的新语义改写。
- 工具主行 tertiary、独立 danger 错误块、明细采用现有 13px 档。
- 完整任务先归并版本，再按 messageId 分配；两组 hash 夹具已修正；无 hash 名称的族键行为维持现状。
- 仅展示的错误说明映射，不改重试、计费、真实失败与降级判据。
- Native 单 owner；针对性测试后统一收口；本批不打包。

## P1-1：Task 3 L150 仍无法得到可靠的最新活动

`useEffect` 修改 `lastActivityRef` 不会自行触发渲染。已有 A/live，增加工具后再无新 delta，ref 可变成 other，但 UI 仍停在 live。[React useRef 官方说明](https://react.dev/reference/react/useRef#caveats) 明确该更新不会触发重渲染。

更深的问题是信息丢失：同一次 React 提交中，`thinking→tool` 与 `tool→thinking` 可以产生完全相同的最终 thinking 文本和 toolCalls 数组。“同帧 thinking 改变就优先”无法区分这两种顺序；把 ref 换为 state 也不能恢复已经丢失的顺序。`live→tool→新思考` 被批量提交后，还可能没有 done→live 翻转，无法按新段复位用户折叠选择。

源码：[MainArea L1201](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/layouts/MainArea/index.tsx:1201>) 只传文本/工具数组；[message-store L583](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/packages/core/src/stores/message-store.ts:583>) 合并思考文本，不保留可用于此判定的活动顺序。

**最小修订：**在现有事件处理/写入入口同步保留少量响应式展示元数据：所属 session/run、最新活动类型、活动修订号、思考段修订号。按真实事件到达顺序更新；原 payload 有顺序时保留其顺序，无可靠顺序时静态降级，不通过 props 变化猜测。通过现有 store/props 接给 body，新段复位按段身份，终止后历史不再 live。

这需要在“纯 renderer 修改”范围里显式列出一个最小例外：允许现有事件入口/ActiveTurn 增加仅展示的瞬态字段；内容合并、落库、重试证据、计费与执行判据保持原规则。无需新 runtime、新 store 或另一套事件系统。

**新增定向验收：**单个工具更新后无新帧也立即 done；批量提交中分别测试 thinking→tool、tool→thinking；批量 live→tool→新段能复位；同段 delta 尊重手动折叠；旧 run 迟到事件不更新新 run。

## P1-2：Task 4 L174 用 stopped 代替“未解决失败”不成立

现有 [ToolCallSummary L184](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/components/ToolCallSummary.tsx:184>) 的 softened 在“settled 且任意工具成功”时成立，因此 stopped=false。该判据用于既有弱化/操作反馈，不能证明某次失败已有替代路径恢复。

**内存反例：**ls 成功，render 失败，settled=true，用户未确认。使用真实 `summarizeToolActivity` 得到 doneCount=1、errorCount=1；继而 softened=true、stopped=false、hasUnreported=false，v2 forcedOpen=false。渲染失败又被默认折叠。

**最小修订：**保留原 stopped/softened 执行与反馈判据，在展示层单独保证未确认失败露出。当前数据缺乏可靠失败恢复关联时，保守使用“有失败且用户未明确确认”作为强制可见条件；任意其他步骤成功不能清除此条件。可核实的替代成功也保留原失败事实，明确展示恢复状态。

**新增定向验收：**列目录成功+渲染失败仍不点击可见；无关成功不当恢复；确有替代成功仍能直接读到失败与恢复说明；用户确认/历史成功过程才允许单层收起。继续沿用原重试入口，不新增假单工具重试。

## P1-3：Task 7 L255/257 提问静态状态未贯通，且 task 不能替代 session

v2 仅在 Composer 内联 awaitingAnswer；[TurnActivityRow L27](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/components/TurnActivityRow.tsx:27>) 只消费共享 hook，拿不到该值。[useTurnActivity L131](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/hooks/useTurnActivity.ts:131>) 也没有“等待回答”headline 分支。即使把图标改成 Clock，文案仍可能说“正在处理”。

questionStore 实际保留 request.sessionKey。只按 activeTaskId 过滤，不能区别同任务中提问的 S1 和仍工作的 S2。

**最小修订：**统一在 `useTurnActivity` 中按其实际 resolved session 查询 pending question，返回 awaitingAnswer，生成“等待你回答”headline；Composer 与 TurnActivityRow 共同消费。批准与回答各走真实来源。任务级 Composer 在多个会话同时活动时明确哪一个会话的操作需要用户，不把所有执行都冻结；未知归属不广播给其他会话。

**新增定向验收：**S1 有问题时 S1 消息与对应 Composer 都静止且文案准确；同任务 S2 仍工作不被判等待；另一任务问题不影响；答复/取消/过期后两个展示出口一致恢复。

## P1-4：Task 8 L283 无条件 store 胜出会覆盖最新文件核验

保存事件经 [App L236](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/App.tsx:236>) 写入 fileStore；其中 availability 是登记时状态。[artifact:list L112](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/packages/desktop/src/main/ipc/artifact-handlers.ts:112>) 才重新检查当前文件。

**真实函数内存对照：**store 有 a1@m1=available、a2@m2=available；本次查询返回 a1=available、a2=missing。查询结果归并选 a1；按“store 行胜出”合并，a2 又变回 available 并被选为 current。旧 unknown 也会压掉查询新得到的 available。这里只使用内存夹具，没有删除真实文件。

**最小修订：**取消无条件来源优先级。请求开始记录当前任务产物快照/修订；期间无该任务更新时，新核验的 availability/filePath 胜出；期间发生新保存/修改时使本次快照失效，并合并触发新的核验，不能静默拿登记时状态覆盖核验结果。延用现有合并刷新模式，不无限即时重查。

**新增定向验收：**store 的旧 available 不能压掉 fresh missing；旧 unknown 不能压掉 fresh available；请求期间有新保存不会丢；聊天与右栏选择同一可用 current。

## Task 8 必补：unknown 缓存不能只等 epoch 变化

本节是实现与验收补充，不另计为确定的 P1 缺陷。模块 Map 尚未实现，可通过正确的失效和逐消费者更新补齐。

v2 命中缓存永不重查，冷启动 gateway 不在线得到 unknown 后，重连并不一定改变 workspaceEpoch。主进程助手根失败缓存只有 20 秒，而 renderer Map 可能一直留下 unknown，ArtifactCard 因而一直不能打开。右栏的局部刷新也不会自动更新这个 Map。

源码：[agent-workspace L48](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/packages/desktop/src/main/artifact/agent-workspace.ts:48>)；[ArtifactCard L47](<D:/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/codex-release-blockers/packages/desktop/src/renderer/components/ArtifactCard.tsx:47>)。

**最小修订：**明确 unknown 的短期有效期、所属 gateway 恢复后的失效、显式刷新及 artifact:saved 的重新核验；考虑主进程 20 秒负缓存，使用有界/按需再查。共享请求成功、失败和失效须通知所有挂载消费者。可以每个 hook 等待同一 Promise 并各自更新有归属守卫的状态，不必再建全局 store；不能只修改普通 Map 期待 UI 自动刷新。

**新增定向验收：**同 epoch gateway 恢复后 unknown 能再核验为 available；两消费者都收到结果并退出 pending；发起者先卸载不使另一消费者卡死；失败后重试可用；旧 workspace 的失败回包不更新新展示。

## Task 6 必补：裸文本围栏扫描仍不等于 CommonMark

v2 修正了围栏字符/长度规则，但没有容器解析，计划 L236/L238 无法覆盖收口第 9 场景。

按 v2 扫描规则与项目现有 remark parser 做内存对照：

| 输入                                             | v2 扫描 | 现有解析结果/问题                                           |
| ------------------------------------------------ | ------- | ----------------------------------------------------------- |
| `> ```js` 后继续引用中的代码，没有 closing fence | false   | 当前 blockquote 内确有 code，未识别当前围栏                 |
| 有序列表项下缩进 4 空格的 fenced code，尚未闭合  | false   | listItem 内确有 fenced code；原始行缩进不是去掉容器后的缩进 |
| 列表 fenced code 随容器结束，后面是普通缩进代码  | true    | 最后一个 code 是缩进代码，却会被根级 pending 判据误套       |

容器结束会结束其中的 code；规则依据 [CommonMark fenced code blocks](https://spec.commonmark.org/0.31.2/#fenced-code-blocks)。此外，`:last-child:has(pre) pre` 在最后一项是含多个代码块的引用/列表时会同时匹配多个 pre，不能只标当前块。

**最小修订：**沿用现有 Markdown 解析链的 token/AST 和源位置核对当前 code，向对应代码节点附加生成标识；不另造裸文本 CommonMark 扫描器。标识落到实际的那个 pre/code wrapper，docgen/htmlgen 不套通用代码生成样式。以上容器反例及同一容器多个 code 块加入测试。

## Task 5 必补：具名错误匹配必须有反例

L216 中裸 `paired node` / `file-transfer tools` 都可能出现在认证失败或传输中断里，不能据此说“当前没有配对设备”。缺参匹配中的 received 也不能独立代表参数缺失。

**最小修订：**具名说明仅匹配已核实的完整缺参/unknown tool/no paired nodes available 形态；“本地文件请改本地读写”需该错误确有本地读写提示或参数证据，否则只说已证明的设备不可用。提取 param 必须准确且脱敏。加入“paired node disconnected”“authentication failed + file-transfer tools”“参数类型错误含 received”反例，不得误归为设备不存在或参数缺失。

## 对两个取舍与 Task 0 的明确建议

1. **惰性正文：接受。** 保留流式可见、展开可见、性能理由及诚实的测试语义。它不影响本轮审核通过与否。
2. **Task 1 在屏区间时长：建议本批移除。** 切任务重挂载后测得的是观察窗口，不是完整回合；UI 仍写“已处理”且没有揭示下限，代码注释不能修正用户理解。无需为了避免每秒渲染而牺牲时间含义。后续有可靠 run 起止元数据时再恢复真实耗时；本批保留既有明确的等待计时与具体工作状态。
3. **Task 0：建议执行独立修复批快照；本轮未代提交。** L58 仍是 `git add .../layouts` 目录级暂存，换成已核实 layout-01.md 至 layout-16.md 的逐文件白名单。L53 应分别核对 44 文件修复清单与允许的未跟踪文档；当前已存在原计划/审核文档，不能要求整个 status 只有 43 M + 1 ??。commit 前核对 cached names 恰为修复清单，无其他来源文件；不使用 reset/clean。
4. **执行方式：Native 单 owner。** 前面的活动元数据例外一并由该 owner 实施，避免与 BUG-050 所在共享文件并行写。审查可并行。

建议实施顺序：修正文中明确的规则 → 固定 44 文件基线 → Native 定向实现/测试 → 独立 review 并完成修正 → 一次完整 gate → 真实 UI 验收。失败/取消/授权/重连/文件交付未验前，不将 UI 或产品交付写成已完成。

## 本轮验证口径

主审核对 v2 相关任务、现有工具弱化判据、Markdown wrapper 与静态文件清单；使用现有 parser 和真实工具统计函数做内存反例。两个真实只读审查员分别核对活动/等待接线、产物缓存及当前可用性，并运行相应内存对照。未重新审计整个项目、重查安装包、运行全量 gate 或付费 E2E。

以上是针对未实施计划的缺陷与验收条件，不能描述成已发现这些 UI 改造代码的线上故障，也不能把定向内存验证当作产品实现已通过。
