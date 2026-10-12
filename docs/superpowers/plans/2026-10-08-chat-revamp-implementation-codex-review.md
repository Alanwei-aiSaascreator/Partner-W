REVIEW STATUS: CHANGES REQUIRED

# 对话可视化改造：代码总审与闭环指令

审查日期：2026-10-08。审查对象为真实源码、提交 diff、未提交及未跟踪文件，未采用交付说明替代源码证据。

- 工作树：`D:\Desktop\new project\mofang-compass\mofang-compass-desktop\.worktrees\codex-release-blockers`
- HEAD：`409326d48a1be25fc301cc30a574bcce9326da16`
- UI 改造比较基线：`5bdb8ec8`；该提交是 44 文件的既有工作快照。
- 已核对六个提交，以及四路 worker 留在工作区的新文件和修改。
- 本轮只读审查产品代码；仅新增本报告。未构建制品、部署、操作生产账本或调用付费模型。
- T8 尚未接入 AssistantBlock、三条旧断言、unused groupCount 等是已申报的集成待办；下列缺陷另外列出。

## 1. 审查发现（含证据分级）

### R1 · P1：累计快照被当成最新活动，思考相位和段号失真

位置：

- `packages/core/src/stores/message-store.ts:611,626–627`，以及工具 upsert 的 activity 更新。
- `packages/core/src/services/gateway-dispatcher.ts:1073–1089`。
- 消费端：`packages/desktop/src/renderer/components/AssistantBlock.tsx:207–212`。

原因：dispatcher 固定按「正文 → 思考 → 工具」调用 store；快照中的旧内容也被无条件 bumpActivity。该顺序是函数执行顺序，不能代表快照中实际内容/活动的顺序。网关正文快照保留旧 thinking 时，最后一次思考写入即使没有改变思考文本，也把相位拨回 thinking。

实证：使用真实 dispatcher + 真实 message-store，esbuild 在内存打包，无 mock store、无文件写入。

| 输入序列                       | 应有状态             | 实际状态         |
| ------------------------------ | -------------------- | ---------------- |
| 首帧只有 thinking              | thinking，段 1       | thinking，段 1   |
| 快照 `[旧 thinking, 新 text]`  | output；思考段保持 1 | thinking；段变 2 |
| 同一旧 thinking，text 继续增长 | output；思考段保持 1 | thinking；段变 3 |
| 快照 `[toolCall, 新 thinking]` | thinking             | tools            |

影响：正文期间仍扫光、思考不能按真实相位收起；每帧伪造新段会复位用户手动折叠；工具之后真正的思考反而收起。

最小修正：内容合并继续走既有逻辑；在规范化事件入口确定本帧真正新增/变化的活动，再更新展示元数据。累计快照重复字段不能更新相位/段号；一帧有多项新内容时保留其实际顺序。真实增量/工具事件按事件顺序更新。thinkingSegment 只在真实进入新思考段时增加。

回归：真实 dispatcher 接真实 store，覆盖上述四例、重复快照、旧 run 迟到帧；UI 覆盖「手动收起 → 旧思考快照随正文更新 → 保持收起」与「工具后新思考 → 自动展开」。改写当前 `message-store-activity.test.ts` 中把固定调用顺序当正确语义的同帧用例。

### R2 · CONDITIONAL：产物指纹漏算 sourceKey；生产可达性待验证

位置：`packages/desktop/src/renderer/hooks/useTaskArtifacts.ts:86–105,121–126,253`。

生产路径证据：`packages/desktop/src/main/artifact/reconcile.ts:776–777` 的 sourceKey 包含文件身份、大小、mtime/ctime；`:912–922` 更新同路径产物时保留原 id 和 createdAt，并写入新 sourceKey。因此，同 ID、同 createdAt、等长文件覆盖是正式支持的路径。但 `:837,916` 同时写入本次 messageId，hook 的指纹包含 messageId；正常下一轮更新可以因此失效。`data-handlers.ts:842` 还阻止同消息重复收尾。尚未证明生产中可达「同 messageId、仅 sourceKey 更新」路径。

原因：taskSignature 包含大小/时间/路径等字段，却没有 sourceKey。新文件只有 sourceKey 变化时指纹不变，旧 rows 继续被判有效，同 ID 合并时 freshRows 又覆盖 storeRows。

独立审查对真实 hook/fileStore 的构造输入内存复现：`calls=1; store=rev2/available; rendered=rev1/missing`。在途旧响应也会被错误接受。这证明对该输入的 hook 行为，不证明同输入的生产可达性。经补查已从 P1 降为条件风险，不作为首要阻断或现场根因。

建议的防御修正：把 sourceKey 纳入修订判定；审视会改变身份/展示语义的字段。保留 epoch、序号和任务归属守卫。补生产路径测试，确认 messageId 变化的正常更新仍正确；不能把构造输入扩大为已证实生产故障。

回归：同 ID/同 createdAt/同大小、仅 sourceKey 更新，分别覆盖「已有核验快照」和「查询在途」；必须重新核验，旧修订不能发布或覆盖新修订。

### R3 · P2：已核验快照永久有效，切回任务仍显示旧磁盘状态

位置：`useTaskArtifacts.ts:121–126,256,332`。

原因：fetchedAt 写入却未参与有效期判断；重挂载只比较 store 指纹；定时核验仅针对 unknown。磁盘文件被删除或恢复、而 store/epoch 没变时，available/missing 快照可永久复用。

独立内存复现：available → 卸载 → 磁盘删除 → 同 epoch 重挂载，及反方向 missing → 恢复文件；均 `calls=1; rendered≠disk; pending=false; timers=0`。

最小修正：给已核验快照定义明确时效，过期重挂载共享重查；也可在最后一个订阅者离开时失效，按实际请求量选择。别把过期快照当新核验成功证据。

回归：available→missing、missing→available；时效内共享请求、时效外重新核验；仍为 unknown 时卸载必须真正清理定时器。当前先变 available 再卸载的测试不证明 unknown 清理。

### R4 · P2：在途查询失败会吞掉保存事件的跟进刷新

位置：`useTaskArtifacts.ts:251–275`。

原因：保存事件触发的刷新复用在途 Promise；只有成功响应分支比较起点指纹并设置 invalidated。旧请求 !ok 或 rejection 后，保存所要求的新核验不会执行。

独立内存复现：查询在途 → 保存导致指纹改变 → 加入旧 Promise → 旧查询非 ok；最终 `calls=1; pending=false; timers=0`，没有跟进核验。

最小修正：在成功、非 ok、异常三条路径都检查请求期间是否发生了本任务修订；归属仍有效时合并一次跟进刷新。单纯失败不能自行无限重试。

回归：非 ok/rejection × 在途保存，断言恰好一次跟进；无保存变化的失败不得形成重试循环。

### R5 · P2：具名失败说明被宽泛分类短路

位置：`packages/desktop/src/renderer/lib/tool-activity.ts:243–251`；详情类标签还在 `ToolCallCard.tsx:108–110`。

实证输入：`Missing required parameter: timeout (received: action, name).`

实际产品文案：`这一步等待超时，可重试`。真实原因是缺少 timeout 参数；新 explainToolFailure 尚未执行，就被既有 timeout 分类提前返回。工具名/参数名包含 network 等分类词也须覆盖。

最小修正：具名协议错误优先于宽泛文本分类；详情类标签也不能再追加相矛盾的「超时/网络」类别。只修展示解释，保留执行、重试、计费判据。

回归：缺参 timeout/network、`Tool network_status not found`、真实网络/超时/限流对照；summary/card 两处说明一致。

### R6 · P2：混合成功/失败没有确认入口，工具列表永久不可收起

位置：`packages/desktop/src/renderer/components/ToolCallSummary.tsx:116,139,274–297`。

原因：`hasFailures && !acknowledged` 强制展开；但确认入口仅在 stopped 分支，成功步骤会使 softened=true、stopped=false。于是「成功 + 失败 + 已结束」永远没有设置 acknowledged 的入口。

独立 React/jsdom 内存复现：`ls done → exec error → settled=true`，点击前后均 `header=DIV; cards=2; confirm=0`；全失败对照 confirm=1。

最小修正：所有 settled 且未确认的失败提供确认入口；是否提供重试继续沿用既有条件。确认后允许单层收起，再展开仍保留失败事实。新失败到来时确认状态应重新失效，不能由旧确认遮住新失败。

回归：混合结果、全失败、确认后重开、新增失败、未收到结果；运行/等待期不能被确认操作隐藏。

### R7 · P2：代码块闭合检测仍不遵守实际容器语义

位置：`packages/desktop/src/renderer/lib/markdown-code-pending.ts:28–37`。

主审使用实际 remark-parse 节点 offsets 调用真实 helper，两个反例均实跑：

````text
反例 A：已闭合的有序列表代码块
1. item

    ```js
    const x=1;
    ```
expected pending=false; actual=true

反例 B：根级代码正文里的引用形状，不是容器
```txt
> ```
more
expected pending=true; actual=false
````

原因：源位置让 opener 从围栏起始处开始，但后续原文行仍有列表缩进；固定 ≤3 空格无法还原列表相对缩进。反过来无条件剥 `> ` 会把代码正文中的字面量引用标记删掉，伪造闭合符。

最小修正：复用解析器的 fenced-code token/闭合信息，或按解析器给出的真实容器上下文规范化，不能对任意代码正文无条件剥引用标记。DOM 组件身份稳定要求继续保留。

回归：实际解析器生成 offsets，覆盖已闭合有序/嵌套列表、根代码正文含 `> ``` `、引用容器、多种围栏；增加同一个 MarkdownContent 实例从未闭合流式更新到闭合的 DOM 用例。

## 2. 低优先级映射边界，不能写成现场根因

位置：`tool-activity.ts:244,250`、`tool-failure-explain.ts:67`、`test/tool-failure-explain.test.ts:93`。

人为边界输入 `Missing required parameter: C:\Users\secret\report.docx (received: action, name).` 原文解析返回 null，但遮路径后变为 report.docx，被说成「缺少必要参数（report.docx）」。现有测试反而断言这个误解释。

尚无已核实的常见合法生产来源，因此不列首要阻断。与 R5 一并修正：从剥样板但未遮路径的原文提取并严格校验参数名，最终展示仍脱敏；未命中就保留诚实兜底。不能把脱敏后的文件名反推成原始参数名。

## 3. 本轮真实验证结果

| 检查                                              | 结果                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| core：message-store-activity + gateway-dispatcher | 284/284 PASS                                                                                                                 |
| desktop：14 个相关测试文件                        | 243 PASS，3 FAIL；12 文件 PASS，2 文件 FAIL                                                                                  |
| 三条失败                                          | tool-activity.test.ts:272、287；tool-failure-aggregation.test.tsx:297；均是 localTransfer 新文案与旧 cannotContinue 断言冲突 |
| ui-contract                                       | PASS                                                                                                                         |
| architecture                                      | PASS（4 rules / 0 violations）                                                                                               |
| renderer-copy                                     | PASS                                                                                                                         |
| i18n                                              | FAIL：toolActivity.groupCount 未使用                                                                                         |
| core / desktop 类型检查                           | PASS；`tsc -p tsconfig.json --noEmit --incremental false --composite false`                                                  |
| 新反例                                            | R1、R7 主审真实源码内存复现；R3–R6 两路独立审查真实 hook/函数/组件内存复现，并由主审复核源码；R2 为构造输入条件风险          |
| 全量套件、制品构建、真实 UI 黄金路径              | 本轮未运行；需完成集成后执行，当前不能声明 UI_CLOSED                                                                         |

桌面定向命令：

```powershell
pnpm vitest run test/thinking-collapse.test.tsx test/assistant-block-stability.test.tsx test/chat-send-stability.test.tsx test/markdown-code-pending.test.ts test/markdown-streaming-chrome.test.tsx test/tool-call-row-appearance.test.tsx test/tool-call-summary.test.tsx test/tool-call-card-error.test.tsx test/tool-failure-explain.test.ts test/tool-activity.test.ts test/tool-failure-aggregation.test.tsx test/composer-activity.test.tsx test/turn-activity-row.test.tsx test/use-task-artifacts.test.tsx
```

Core 定向命令：

```powershell
pnpm vitest run test/message-store-activity.test.ts test/gateway-dispatcher.test.ts
```

## 4. 已申报但必须完成的集成项

1. T8 接入 AssistantBlock：任务级共享水合；先完整任务归并，再按 messageId 分发；同源卡片，不再依赖恒空 message.artifacts。
2. pending/文件交付期间不能先闪出「无结果/重试」；查询失败也不能冒充文件交付核验成功。
3. 在 R5 的分类顺序修正后更新三条旧断言；保留未知错误的兜底测试。
4. 九种语言移除 unused groupCount；已新增键保持 parity。
5. 静态强制展开表头采用静态鼠标语义；清理确实未使用的 getToolFamily。
6. 四路未提交成果完成集成，文档状态从旧 HEAD/待实施更新为磁盘真实状态。

## 5. 给实施方的闭环指令

按以下顺序完成当前批次，不再重写整份方案：

1. 先给 R1 加会失败的真实入口回归，再修活动元数据。共享 core/AssistantBlock 单 owner。
2. 产物 owner 一次修完 R3/R4，并完成 T8 接线及 pending/交付态联动；R2 同批补修订防御和生产路径验证，证据仍按条件风险记录；不能只交一个未使用 hook。
3. 工具 owner 一次修完 R5/R6 和参数名边界；Markdown owner 修 R7。各跑 affected tests，其他 owner 不碰共享文件。
4. 合并后更新已申报旧断言和 i18n 清理；重新跑本报告定向集合，必须零失败。
5. 所有实现完成后跑一次项目完整门禁、全量测试与构建；失败按真实结果修，修后只重复受影响检查，不能用删断言换通过。
6. 在真实 UI 执行 v2 的十个场景，必须额外包含本报告反例：正文中的旧思考快照、工具后新思考、用户手动收起、混合失败确认、新文件版本、删除/恢复后切回、在途核验失败、代码块流式闭合、批准/提问静态态、切任务隔离。截图/日志/实际文件打开保留证据。
7. 最后更新 DELIVERY_STATE / DELIVERY_HISTORY / 必要 BUGS 记录，明确 HEAD、dirty state、测试和真实 UI 证据。全部通过才标本批闭环；当前状态保持未闭环。

此次审查不提供生产部署、生产 SQL、账本清理的新授权。
