# 对话可视化改造（WorkBuddy 形态）实施计划 · v2（按 Codex 审核修订）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把长任务黑箱变成过程可见：**运行中的工作过程直接可见，完成后的成功过程才允许单层折叠**；思考可折叠、工具行轻量化、失败原因可读、正文 15px/1.75、产物卡真实登记可打开、等待（批准/提问）全链静态。

**Architecture:** 就地改造 renderer 呈现层——复用 `MessageBlock` 壳 / `tool-activity` 纯函数族 / 滚动锚点；**稳定父层（AssistantBlock 实例，跨 等待→流式→定稿 同一实例）放回合状态与计时**，子层放 `ThinkingCollapse`、平铺工具行、`MarkdownContent`、`ArtifactCard`。新增文件：`ThinkingCollapse.tsx`、`lib/tool-failure-explain.ts`、`hooks/useTaskArtifacts.ts`。全部新样式进 `typography.css` / `theme.css`（gate 豁免文件）。

**Tech Stack:** React 19 / Tailwind v4 / zustand / vitest + @testing-library/react / Electron 34（Chromium 132）。

**Spec:** `CHAT-REVAMP-SPEC-20261008.md`（deliverables\v1-commercial-closeout-20261006\）+ 复刻包 DEVELOPMENT.md；**冲突裁决：Codex 审核（对本机真实 WorkBuddy 5.7.6 app.asar 实测）> 复刻包文档**。

**执行位置（真源，不新建 worktree）:** `WT = D:\Desktop\new project\partner-w\partner-w-desktop\.worktrees\codex-release-blockers`（HEAD `5c3391e1`，含 44 个未提交修复）。路径均相对 `WT`。红线：禁 `git reset/checkout/clean`/整树覆盖。

## v2 修订记录（相对 v1，全部经本轮只读源码核实）

1. **工具过程**：v1 只改样式，保留「摘要折叠→分组折叠→单卡折叠」三层 ⇒ 运行期仍需点击才能看到过程。v2：运行/等待/失败未解决 **强制平铺可见**（`ToolCallSummary` 现默认 `expanded=false` 已核实）；分组行去折叠；仅「成功结束」允许单层折叠；参数/结果只留单条详情一层。
2. **删除「思考了约 N 秒」与文本键 Map**：真实 WorkBuddy 的思考标题是静态 `reasoning.title`（截图「深度思考」），时间是回合处理时长（`TurnStatusLine` / processingStartedAt）。文本键会跨任务串时长、定稿重挂载可覆写为 ≈0ms。v2：思考标题 = 静态「深度思考」；**回合处理时长**改在稳定父层实测（详见 Task 1）。另核实 `gateway-dispatcher.ts:1074`：首个正文 delta 即 `setProcessing(false)`（并清 `turnStartedAtBySession`）⇒ 该 store 计时**不可**用作完整回合计时。
3. **思考相位**：不再用「工具数组曾否非空」判阶段（工具后再次思考会被关死）。v2：按**最新活动顺序**（isLastContent 等价）判 live/done；最新段自动展开、结束自动收起、尊重用户手动折叠且同段不被新 delta 强行展开。
4. **产物同源**：v1 每条消息独立查询 + 先按 messageId 过滤再归并 ⇒ N 条历史消息 N 次同查询、跨消息同族旧版会被错认 current。v2：**任务级水合**（请求复用 + `workspaceEpoch` + 请求序号守卫，模式照 `MentionPicker.tsx:73-108` / `RightPanel`），**先对完整任务 `groupArtifactVersions`，再按 messageId 分发 current**。族键实测（`artifact-versions.ts:29`）：`报告-3f2a1b8c.pptx` 与 `报告-7c4d2a90.pptx` 同族；`报告.pptx`（无哈希）与二者**不同族**（无匹配时取含扩展名全名）——测试夹具按前者。
5. **失败说明**：v1 全锁 `tool-activity.ts` ⇒ 「缺少参数/工具不存在/配对节点」继续同句「这一步暂时无法完成」，`read` 继续显示「使用工具」。v2：新增**仅展示**的说明映射（不改 `classifyToolFailure` 与重试/降级语义），三类已知形态给具体中文，未知如实为未知（脱敏详情仍可展开）。
6. **fence 奇偶法废弃**：v1 计数法在 CommonMark 反例下错误（4 反引号开/3 反引号闭、```/~~~ 混用、内容含短 fence）。v2：按 CommonMark 开闭规则（同字符、闭 ≥ 开、≤3 缩进）扫描末块。
7. **Task 0 快照**：v1 `git add -u` 会收编全部 tracked 修改。v2：白名单逐文件显式暂存。
8. **验收**：v2 收口采用审核 §6 的 10 个真实场景（用户点名五面为其子集）。

## Global Constraints

- **门禁零例外**：新样式只写 `styles/typography.css` 与 `styles/theme.css`（ui-contract `EXCLUDED_FILES`）。TSX 禁 `text-[15px]`/`text-sm/base/...`/`max-w-3xl`/裸 `backdrop-blur`/任意布局值；宽度用 `--content-*`，密度用 `--density-*`。**新 CSS 变量不进 `@theme`**（避免生成不受门禁约束的 `text-*` 工具类）。
- **i18n ×9**：新键同时进 9 个 locale；调用形状只能字面量 `t('k')` 或 ``t(`prefix.${v}`)``；改前 `python D:\backup\i18n-lock.py acquire`，改后 `release`。
- **展示脱敏边界（审核修订）**：用户面 = 动作名 + 说明映射 + 脱敏参数/结果（`maskLocalPaths`/`sanitizeToolText`，详情展开可见）；原始载荷只进 console（`debugToolFailures`，不接任何 UI 出口）。**新增说明映射只走展示层**：不改 `classifyToolFailure`/重试/降级/计费/真实失败状态；`aggregateRepeatedToolFailures` 判据（原始文本）不动。
- **节点稳定**：`assistant-block` 壳 / 头像跨态不重建；不加/减 `assistant-block` 的 `parentElement` 层（`chat-scroll-anchor-viewport.test.tsx:396`）；memo 身份对象仍走 `useAssistantIdentityIndex`。
- **零假数据**：计时只报实测；测不到不显示；不搬复刻包演示数据；复刻包第 8 章接口名（推定）不得引入。
- **动效**：只在有依据的运行状态使用（thinking 流式、工具 running）；等待批准/等待回答停止动效；全部响应 `prefers-reduced-motion`（关闭后仍有图标+文案+颜色三重可辨）。
- **提交**：Conventional Commits；每 Task 一次提交。
- **测试命令**（单点）：`cd "$WT/packages/desktop" && pnpm vitest run test/<file>`；收口：`cd "$WT" && pnpm --filter @clawwork/desktop exec vitest run`。

## Review Focus（spec 隐含、最可能咬人的 5 类，均已落测试）

1. **历史/重启**：任何时间显示都有实测来源；重组/重挂载后不得出现编造或归零的时长（Task 1 钉住）。
2. **工具后再次思考**：相位按最新活动走，不因历史工具关死；用户手动折叠的同一段不被新 delta 强行展开（Task 2 钉住）。
3. **产物水合竞态与跨消息版本**：同任务多消息只查一次；迟到回包/切 workspace 不串；跨消息同族最新版胜出、missing 回退、unknown 不报成功（Task 8 钉住）。
4. **两类等待静止且互不污染**：批准（tool awaiting + ApprovalDialog）与提问（QuestionPanel）全链静态；另一任务的问题不得使本任务静止（Task 7 钉住）。
5. **fence 反例**：4/3 反引号、```/~~~ 混用、内容含短 fence、docgen/htmlgen 专用块不误套（Task 6 表格钉住）。

---

### Task 0: 基线快照（条件任务——等用户拍板）

- [ ] **Step 1: 询问用户**：是否把 44 个未提交文件（1.0.1 修复批）先提交为批次快照。
- [ ] **Step 2: 若同意**（**白名单逐文件显式暂存**——不用 `git add -u`/`-A`；快照前先冻结清单，不得把后来出现的并行改动自动纳入）：

```bash
cd "$WT" && git status --porcelain   # 核对=当前 43 M + 1 ??；如有清单外变化，先停下报告
git add -- packages/core/src/capability/capability-registry.ts packages/core/src/index.ts \
  packages/core/src/services/gateway-dispatcher.ts packages/core/src/stores/message-store.ts \
  packages/core/test/capability-registry.test.ts packages/core/test/gateway-dispatcher.test.ts \
  packages/core/test/message-store-retryable.test.ts \
  packages/desktop/our-skills/presentation-deck-v2/layouts \
  packages/desktop/src/main/docgen/template-deck/input.ts \
  packages/desktop/src/main/runtime/gateway-breaker.ts packages/desktop/src/main/runtime/gateway-process.ts \
  packages/desktop/src/main/runtime/index.ts packages/desktop/src/main/runtime/portable-state-migration.ts \
  packages/desktop/src/main/runtime/state-config.ts packages/desktop/src/main/runtime/workflow-tools.ts \
  packages/desktop/src/renderer/hooks/useAutoRetryFailedTurn.ts packages/desktop/src/renderer/lib/preset-agents.ts \
  packages/desktop/test/auto-retry-failed-turn.test.tsx packages/desktop/test/capability-deny-surface.test.ts \
  packages/desktop/test/main-agent-contract.test.ts packages/desktop/test/our-skills-bundled.test.ts \
  packages/desktop/test/portable-state-migration.test.ts packages/desktop/test/preset-agent-delivery-contract.test.ts \
  packages/desktop/test/runtime-bootstrap-order.test.ts packages/desktop/test/runtime-gateway-breaker.test.ts \
  packages/desktop/test/runtime-gateway-ownership.test.ts packages/desktop/test/runtime-state-config.test.ts \
  packages/desktop/test/template-deck-aggregate.test.ts packages/desktop/test/template-deck-layout-examples.test.ts
git commit -m "chore(release): 1.0.1 修复批次快照（BUG-050/053/059/060/061 + 模板页序/布局示例）"
```

预期：`git status` 仅剩未跟踪文档（含本计划）。不同意则跳过，后续 diff 与修复批混存，验收时按文件区分。

---

### Task 1: 回合处理时长（稳定父层实测；删除 v1 文本键方案）

**Files:**

- Modify: `packages/desktop/src/renderer/components/AssistantBlock.tsx`（壳组件 + 传 `processedMs` 给定稿 body）
- Modify: `packages/desktop/src/renderer/i18n/locales/*.json`（`chatMessage.turnProcessed`）
- Test: `packages/desktop/test/assistant-turn-timing.test.tsx`（新）

**Interfaces:**

- Produces：`AssistantBlock` 内部（不外泄）——`liveStartRef: useRef<number|null>`（首次渲染时 `state==='streaming'` ⇒ `Date.now()`，否则 null）；`processedMs: number | null`（state 翻 `'finalized'` 且 liveStartRef 非空 ⇒ 冻结 = 当时 now − start）。
- 展示：定稿 body 顶部一行 `<div data-testid="turn-processed" className="turn-processed type-support">{t('chatMessage.turnProcessed', { time: formatElapsed(ms) })}</div>`（复用 `lib/waiting-copy.formatElapsed`，输出如 `6.2s`）。
- **边界语义（写进代码注释）**：测得窗口 = 该助手块**在屏期间**（等待→定稿）；主路径 = 整轮全程；切任务重挂载等边缘情形为下限，不向上补。**历史（挂载即定稿，无实测来源）不显示**——不报秒、不归零。
- i18n：`chatMessage.turnProcessed` = zh「已处理 {{time}}」/ en「Processed in {{time}}」/ 其余 7 语。

- [ ] **Step 1: 写失败测试** `test/assistant-turn-timing.test.tsx`（真身 AssistantBlock，mock framer；参照 assistant-block-stability 的挂法）
  - ①流式渲染 → `vi.advanceTimersByTime(4200)` → 重渲染为 `state="finalized"` → `turn-processed` 文案含 `4.2s`。
  - ②直接以 `state="finalized"` 挂载（历史路径）→ **无** `turn-processed` 元素。
  - ③`state` 停在 streaming → 无 `turn-processed`（不预显）。

- [ ] **Step 2: 跑测试确认失败**：`cd "$WT/packages/desktop" && pnpm vitest run test/assistant-turn-timing.test.tsx` Expected: FAIL。

- [ ] **Step 3: 实现**（AssistantBlock 壳内 ref + 定稿 body 顶部行；`AssistantFinalizedBody` 增可选 `processedMs?: number | null` prop）。先取 i18n 锁加键 ×9 → release。

- [ ] **Step 4: 跑测试确认通过** + `pnpm vitest run test/assistant-block-stability.test.tsx` 回归。
- [ ] **Step 5: 提交**：`feat(chat): 回合处理时长（稳定父层实测，历史不报秒）`

---

### Task 2: ThinkingCollapse 组件 + 样式（静态标题 + 最新活动相位）

**Files:**

- Create: `packages/desktop/src/renderer/components/ThinkingCollapse.tsx`
- Modify: `packages/desktop/src/renderer/styles/theme.css`
- Modify: i18n ×9（`chatMessage.thinking.title`）
- Test: `packages/desktop/test/thinking-collapse.test.tsx`

**Interfaces:**

```ts
export interface ThinkingCollapseProps {
  text: string; // 推理正文（空串 ⇒ 返回 null）
  /** live = 思考是当前最新活动（流式进行中）；done = 已被更新的输出接续或回合定稿。 */
  phase: 'live' | 'done';
}
export default function ThinkingCollapse(props: ThinkingCollapseProps): JSX.Element | null;
```

- 行为（依据：真实 WorkBuddy `expand=isLastContent`、`streaming/autoScroll=!isFinished`；复刻包实测参数）：
  - 标题**静态**「深度思考」（`chatMessage.thinking.title`）；`phase==='live'` 时标题扫光、`done` 停动画。
  - 展开态：`live` ⇒ 自动展开 + 正文随流自动滚底；`done` ⇒ 自动收起。**用户手动折叠后，同一段 live 期间新 delta 不强行展开**（记录 `userCollapsed`，仅在新一段（`done→live` 翻转）时复位）。
  - 正文区：左 4px 竖线 `var(--border-subtle)`、`max-height:200px` 内部滚动、15px/20px `var(--text-secondary)`。
  - 定稿态惰性正文：**展开前不渲染正文节点**（长 CoT 不入 DOM；非为迁就旧断言——旧断言按新语义改写，见 Task 3）。
  - CSS（theme.css 新增，值=复刻包实测）：`thinking-collapse`、`--live/--collapsed/--done` 修饰类、`__header`（button + `aria-expanded`）、`__icon`（12px ChevronRight；收起态 `opacity:0; rotate(-90deg)`，悬停/完成显形；`.24s cubic-bezier(.2,.8,.2,1)`）、`__title`（省略号）、`__content`（`interpolate-size:allow-keywords; height:auto; overflow:hidden; contain:layout paint; .28s cubic-bezier(.33,1,.68,1)`）、`__content-inner`、`.text-shimmer`（含 `@supports not (color: color-mix(...))` 与 `prefers-reduced-motion` 双降级为静态 tertiary）。v1 的 chip/秒数/`thinking-timing.ts` **全部删除**。

- [ ] **Step 1: i18n**：acquire → `chatMessage.thinking.title`（zh 深度思考 / en Deep thinking / 其余 7 语）→ release → `node scripts/sort-i18n.mjs`。
- [ ] **Step 2: 写失败测试** `test/thinking-collapse.test.tsx`
  - ①`phase='live'`：根含 `--live`；标题为「深度思考」且类含 `text-shimmer`；正文在 DOM 且含文本。
  - ②`done`（从 live 重渲染）：根含 `--done --collapsed`；正文不在 DOM；标题**不含** `text-shimmer`。
  - ③点击头部展开 → 正文出现、`aria-expanded` 往返；**收起后再收新 delta（仍 live）不自动展开**。
  - ④`done→live`（新一段）→ 自动重新展开、`userCollapsed` 复位。
  - ⑤空文本 ⇒ null。
- [ ] **Step 3: 跑测试确认失败**（组件不存在）。
- [ ] **Step 4: 实现组件 + theme.css 样式块**。
- [ ] **Step 5: 跑测试确认通过** + `pnpm check:ui-contract && pnpm check:i18n` RC0。
- [ ] **Step 6: 提交**：`feat(chat): ThinkingCollapse（静态深度思考/最新活动相位/扫光宽容降级）`

---

### Task 3: 接线 AssistantBlock（流式 + 定稿 + 最新活动判据）+ 三条旧断言按新语义改写

**Files:**

- Modify: `packages/desktop/src/renderer/components/AssistantBlock.tsx`
- Modify: `packages/desktop/test/assistant-block-stability.test.tsx`、`test/chat-send-stability.test.tsx`（**有意改写**）

**Interfaces:**

- 流式 body：`lastActivityRef: 'thinking' | 'other'`（useEffect：thinkingContent 增长 ⇒ 'thinking'；content/toolCalls 变化且同帧 thinking 未变 ⇒ 'other'）；`phase = !settledByActivity ? 'live' : 'done'`，即**最新活动是思考 ⇒ live**（工具/正文后来居上 ⇒ done；思考再次增长 ⇒ 自动回 live —— **不是**"工具数组曾否非空"）。
- 定稿 body：`phase='done'`；`thinkingText = (message.thinkingContent ?? '').trim()`。
- 渲染顺序（两态一致）：ThinkingCollapse → 等待行（仅 `!thinkingText && !content && 无工具`）→ 工具区 → 正文。`hasVisibleAnswer` 保持不含 thinking（"思考不是最终回答"，重试块语义保留）。

- [ ] **Step 1: 改写旧断言（先红后绿；改写理由=产品新验收，不是为保断言藏文本）**
  - assistant-block-stability 流式块：`rawThinking` **应可见**（collapse 正文）；等待态（无思考文本）`thinking-indicator` 判据保留。
  - assistant-block-stability 定稿块 + chat-send-stability:789-808：`assistant-no-visible-answer` + `assistant-empty-retry` **必须在**；`thinking-collapse` 存在；收起态 `textContent` 不含 rawThinking（**惰性渲染**）；点击展开后含 rawThinking。注释标注「2026-10-08 有意反转：思考可折叠可见；惰性渲染=性能取舍」。
- [ ] **Step 2: 跑测试确认 RED**。
- [ ] **Step 3: 实现接线**（最小 diff；不加包裹层）。
- [ ] **Step 4: 跑测试确认 GREEN** + `pnpm vitest run test/chat-scroll-anchor-viewport.test.tsx test/chat-scroll-anchor.test.ts test/chat-message-copy.test.tsx test/chat-message-model-badge.test.tsx`。
- [ ] **Step 5: 提交**：`feat(chat): 思考折叠接入两态（最新活动相位）；旧'思考不上屏'断言按新验收改写`

---

### Task 4: 工具过程平铺（运行期可见，成功结束才单层折叠）

**Files:**

- Modify: `packages/desktop/src/renderer/components/ToolCallSummary.tsx`（:50-118 分组行 + :140-260 展开逻辑）
- Modify: `packages/desktop/src/renderer/components/ToolCallCard.tsx`（行/错误块拆分 + StatusIcon）
- Modify: `packages/desktop/src/renderer/styles/theme.css`（`.tool-row*`/`.tool-summary__trigger`/`.tool-icon-loading`）
- Test: `packages/desktop/test/tool-call-row-appearance.test.tsx`（新）+ 既有 4 套件（**含有意改写**）

**Interfaces:**

- `ToolCallSummary` 展开判据（**运行期强制平铺**）：
  - `forcedOpen = !settled || stopped || hasUnreported`（`stopped` 已有定义：settled 且失败未解决）；
  - `open = forcedOpen ? true : expanded`（forcedOpen 时触发器不提供收起）；
  - 默认 `expanded=false` 仅当「settled 且无未解决失败」⇒ 成功/弱化过程折叠为**一层**「查看处理过程 N 步」。
- 列表：**按原始调用顺序平铺**（不再按 kind 分组折叠）；分组行消失；重复失败聚合保留（代表行 + 详情内 `tool-failure-repeats`）。
- `ToolCallCard`：行 = 图标 + 动作名 + 状态（tertiary，14px/1.75，gap 8，无边框/背景/彩条/glow）；**错误说明块 = 行的同级兄弟节点**（行下方，`color: var(--danger); font-size: 13px; padding: 6px 8px;` 可换行，**行本身不转红**）；参数/结果仅单条详情一层（脱敏沿用）。
- 动效：running 图标 `.tool-icon-loading`（1.2s ease-in-out 半转+呼吸，reduced-motion 静态）；running 状态文字 `.text-shimmer`；awaiting 图标 Clock 静态（`tool-call-waiting-time` 保留）；done=耗时（保留）。
- 动作名显示映射（仅展示）：`classifyToolActivity` 返回 `'other'` 时查小表（`read`→`readFile`、`ls`→`listDirectory`、`browser`→`browseWeb` 等，逐一测试）；不改 `classifyToolActivity` 本身。

- [ ] **Step 1: 写失败测试** `test/tool-call-row-appearance.test.tsx`
  - ①`settled=false`（运行中）→ **不点击**即可看到工具行（`tool-call-card` 在 DOM、含行内动作名/状态）。
  - ②`settled=true` 全成功 → 默认折叠；展开一层后所有行可见（不再有第二层分组折叠）。
  - ③`stopped`（settled 有失败且未解决）→ 强制可见，错误说明块在行下方、非行内、可换行、含 `tool-call-error`。
  - ④running 行：无 `glass-card`/`glow-running`/`tool-scan`/彩条；图标 `tool-icon-loading`（无 `animate-spin`）；状态文字 `text-shimmer`。
  - ⑤awaiting：Clock 静态、无 `text-shimmer`、`awaiting-approval-label` 保留。
  - ⑥`read` 工具（无 title）→ 行显示 `toolActivity.actions.readFile` 文案，不是「使用工具」。
- [ ] **Step 2: 跑测试确认 RED**。
- [ ] **Step 3: 实现**（ToolCallSummary 展开判据 + 平铺重排 + ToolCallCard 行/错误块拆分 + theme.css）。
- [ ] **Step 4: 新测试 GREEN + 既有回归**：`pnpm vitest run test/tool-call-summary.test.tsx test/tool-call-card-error.test.tsx test/tool-call-card-awaiting-approval.test.tsx test/tool-call-elapsed.test.tsx test/tool-call-slide-progress.test.tsx`（分组折叠/开合态提升断言按平铺语义**有意改写**并注释）。
- [ ] **Step 5: 提交**：`feat(chat): 工具过程运行期平铺可见；成功结束单层折叠；行轻量化+错误块独立`

---

### Task 5: 失败说明展示映射（仅展示层；未知如实为未知）

**Files:**

- Create: `packages/desktop/src/renderer/lib/tool-failure-explain.ts`
- Modify: `packages/desktop/src/renderer/lib/tool-activity.ts`（**只在 `productizedToolFailure` 兜底分支之前插入一次调用**，其余一字不动）
- Modify: i18n ×9（3 个新键）
- Test: `packages/desktop/test/tool-failure-explain.test.ts`（新）

**Interfaces:**

```ts
/** 仅展示：已知形态 → 具体说明；认不出的返回 null（交给既有兜底链）。不改任何执行语义。 */
export function explainToolFailure(cleanedReason: string, t: Translate): string | null;
```

- 具名形态（按**运行时原文**匹配，禁止按截图硬编码）：
  | 判据（清洗后） | 键 | zh |
  |---|---|---|
  | `missing required parameter[:：]\s*(name)?` / `(received: …)` | `toolActivity.failure.missingParam` | 缺少必要参数（{{param}}） |
  | `tool .* not found` / `unknown tool` | `toolActivity.failure.toolUnavailable` | 这个工具在当前环境中不可用 |
  | `no paired nodes?/paired node/file-transfer tools` | `toolActivity.failure.localTransfer` | 本地文件不能用这种方式传输（当前没有配对设备），请改用本地读写 |
- 插入点：`productizedToolFailure` 中 `isOpaqueToolFailure` 兜底**之前**：`const explained = explainToolFailure(cleaned, t); if (explained) return explained;`（family 三态分支优先于它，保持不变）。
- 未知（不含以上且认不出）→ 维持既有 `cannotContinue` + **详情展开可见脱敏原文**（已是现状，测试钉住"有诊断入口"）。
- **纪律**：不改 `classifyToolFailure`/`isOpaqueToolFailure`/`aggregateRepeatedToolFailures`/重试/降级；原始载荷仍只进 console。

- [ ] **Step 1: i18n ×9**（3 键）。
- [ ] **Step 2: 写失败测试**：三类形态各一命中（含 `Missing required parameter: path (received: action, name).` 真实句式）；含中文的未知原样保留；未知英文 ⇒ `cannotContinue`；断言**不含**任何路径/凭据（脱敏）；`aggregateRepeatedToolFailures` 计数不变（同因重复仍聚合成 ×N）。
- [ ] **Step 3: RED → 实现 → GREEN**；回归 `pnpm vitest run test/tool-call-card-error.test.tsx test/tool-call-summary.test.tsx`。
- [ ] **Step 4: 提交**：`feat(chat): 已知工具失败的具名说明（仅展示层，未知如实+脱敏详情）`

---

### Task 6: 正文 15px/1.75 + 流式光标 + 代码块未闭合占位（CommonMark 规则）

**Files:**

- Create: `packages/desktop/src/renderer/lib/markdown-fence.ts`
- Modify: `styles/typography.css`、`styles/theme.css`、`components/MarkdownContent.tsx`、`components/AssistantBlock.tsx`（两处包装 `leading-relaxed`→`type-chat-body`）
- Test: `test/markdown-fence.test.ts`、`test/markdown-streaming-chrome.test.tsx`

**Interfaces:**

- `hasUnclosedCodeFence(content: string): boolean` —— **CommonMark 开闭规则**扫描：围栏行 = ≤3 前导空格 + 连续 ``` 或 ~~~（≥3）；开启记录字符与长度；关闭 = 同字符、长度 ≥ 开启、行内仅余空白；反引号围栏的 info string 不得含反引号。返回"扫描结束时处于开启态"。
- CSS：`.type-chat-body`（15px/1.75 + `.type-chat-body .prose-chat{line-height:1.75}`；`--type-chat-size/--type-chat-line-height` 放 typography.css `:root`，**不进 @theme**）；`.stream-cursor`（2px×15px `var(--accent)`、`1s step-end` 闪烁；删死代码 `.animate-stream-cursor`/`stream-pulse`）。
- 占位：`codePending = showCursor && hasUnclosedCodeFence(content)` ⇒ 根 `.prose-chat` 加 `data-code-pending`；CSS `[data-code-pending] > :last-child:has(pre) pre { border:1px dashed var(--accent) }`（**只命中真代码块**，docgen/htmlgen 卡不误套）。

- [ ] **Step 1: 写失败测试**：fence 表 —— 无围栏 / 已闭合 / 未闭合 / ~~~ 对 / **4 反引号开+3 闭（未闭合）** / \*\*``` 开+~~~ 闭（未闭合）** / **4 开+内容含 ```+4 闭（已闭合）** / 缩进 4 空格（非围栏）/ `\`\`\`docgen` 未闭合；渲染侧：光标类、`data-code-pending` 三态（流式未闭合 true / 已闭合 false / 非流式 false）。
- [ ] **Step 2: RED → 实现 → GREEN**；回归 `pnpm vitest run test/markdown-docgen-block.test.tsx`。
- [ ] **Step 3: 提交**：`feat(chat): 正文 15px/1.75、流式光标、代码块未闭合占位（CommonMark 规则）`

---

### Task 7: 等待双静态（批准 + 提问）+ ComposerActivity 第三/四态

**Files:**

- Modify: `packages/desktop/src/renderer/hooks/useTurnActivity.ts`（浮出 `awaitingApproval` 派生布尔；判定仍走 `latestAwaitingApproval` 唯一出口）
- Modify: `components/ComposerActivity.tsx`（:53-65）、`components/TurnActivityRow.tsx`、`components/ToolCallSummary.tsx`（:28 图标）
- Modify: `styles/theme.css`（`.turn-activity-row*`）
- Test: `test/composer-activity.test.tsx`（扩展）、`test/turn-activity-row.test.tsx`（helper 改 testid + 新用例）

**Interfaces:**

- 静态判据（**两类分开、不混用**）：`awaitingApproval = latestAwaitingApproval(本会话 toolCalls) != null`；`awaitingAnswer = questionStore.pendingQuestions.some(q => q.taskId === activeTaskId)`（**按任务过滤——别的任务的问题不得使本任务静止**；QuestionPanel:37-40 已同款过滤）。
- `ComposerActivity`：`data-status = awaitingApproval ? 'awaiting-approval' : awaitingAnswer ? 'awaiting-answer' : running ? 'running-tool' : 'working'`；前两态图标 = Clock 静态（`var(--text-muted)`），其余 Loader2 + 补 `motion-reduce:animate-none`。
- `TurnActivityRow`：awaiting 两态 ⇒ 静态 Clock（替换 ActivityBars）、headline 不加扫光；其余不变。headline span 加 `data-testid="turn-activity-row-headline"`（**测试 helper 从"取第一个 span"改按 testid**——插入图标会断旧取法，属有意修正）。
- `ToolCallSummary` 头部图标：`!currentCall && latestAwaitingApproval(shown)` ⇒ Clock 静态（`data-status` 语义不变）。
- ApprovalDialog（既有 deny/allow-always/allow-once/倒计时）**不动**；本任务只保证「等待期无动效、入口还在」。

- [ ] **Step 1: 扩展测试**：批准态 / 提问态（含"另一任务有 pending question ⇒ 本任务仍 running"反例）/ 两既有态不回归；Turn 行 awaiting 静态 + helper 改 testid；Summary awaiting-only 无 `.animate-spin`。
- [ ] **Step 2: RED → 实现 → GREEN**；回归 `pnpm vitest run test/auto-retry-failed-turn.test.tsx`（BUG-050 快照链只读）。
- [ ] **Step 3: 提交**：`feat(chat): 等待批准/等待回答全链静态（Composer 双新态/ Turn 行 / Summary 图标）`

---

### Task 8: 产物卡同源（任务级水合 + 完整任务先归并后分发）

**Files:**

- Create: `packages/desktop/src/renderer/hooks/useTaskArtifacts.ts`
- Modify: `components/AssistantBlock.tsx`（:53-56 / :109-115 定稿区）
- Test: `packages/desktop/test/assistant-message-artifacts.test.tsx`（新）

**Interfaces:**

```ts
/** 任务级产物（右栏真源同款）：共享请求 + epoch/序号守卫。pending=首水合未回。 */
export function useTaskArtifacts(taskId: string | undefined): { artifacts: Artifact[]; pending: boolean };
/** 完整任务先 groupArtifactVersions，再取 current 中属于该消息的部分（跨消息最新版胜出）。 */
export function selectCurrentArtifactsForMessage(all: readonly Artifact[], messageId: string): Artifact[];
```

- 水合（照 `MentionPicker.tsx:73-108` 模式）：模块级 `Map<taskId, {rows, epoch, seq, inFlight}>`；`useFileStore(s=>s.artifacts)` 过滤 taskId 与缓存 rows 合并（按 id 去重，store 行胜出 ⇒ `artifact:saved` 更新即时反映，**不冻结缓存**）；命中缓存不重复请求；**同任务多消息只发一次** `listArtifacts(taskId)`；迟到回包校验 `useTaskStore.getState().workspaceEpoch` 与本地 seq 后才提交；epoch 变化清缓存。`window.clawwork?.listArtifacts` 缺失时静默跳过（测试守卫）。
- 消息侧：`const { artifacts: taskArtifacts, pending } = useTaskArtifacts(message.taskId)`；`displayArtifacts = selectCurrentArtifactsForMessage(taskArtifacts, message.id)`；`hasVisibleAnswer = ... || displayArtifacts.length || pending`（**水合未回不闪「无回答→重新尝试」**，pending 与"无回答"分开显示）。
- 打开链 = 既有 `ArtifactCard`（`openArtifactFile(id, taskId)`）；`unknown` 只显示待核对状态；流式 turn 不渲染产物区（产物在消息落库后才有 messageId —— 定稿即呈现）。

- [ ] **Step 1: 写失败测试**：①跨消息同族（`报告-3f2a1b8c.pptx`@m1 / `报告-7c4d2a90.pptx`@m2）⇒ 仅 m2 显示 current；②missing 新版回退到可用旧版（current=旧版，落在旧版消息）；③unknown 无可用 ⇒ current=unknown，卡片为待核对、无成功态；④两条消息同任务 ⇒ `listArtifacts` 仅 1 次；⑤迟到回包（epoch 变更后 resolve）⇒ 不更新；⑥无产物 + pending ⇒ 不出现 `assistant-no-visible-answer`；⑦打开调 `openArtifactFile(id, taskId)`。
- [ ] **Step 2: RED → 实现 → GREEN**；回归 `pnpm vitest run test/assistant-block-stability.test.tsx test/chat-send-stability.test.tsx`（`window.clawwork` 守卫）。
- [ ] **Step 3: 提交**：`feat(chat): 产物卡同源（任务级水合+epoch 守卫；完整任务先归并后按消息分发）`

---

### Task 9: 批次收口（全量 + 门禁 + 独立 review + 真机移交）

- [ ] **Step 1: 全量**：`cd "$WT" && pnpm --filter @clawwork/desktop exec vitest run` Expected: 0 failed。
- [ ] **Step 2: 四门禁 + 双 typecheck + core/shared**：`pnpm check:ui-contract && pnpm check:architecture && pnpm check:renderer-copy && pnpm check:i18n && pnpm typecheck && pnpm typecheck:tests && pnpm --filter @clawwork/core exec vitest run && pnpm --filter @clawwork/shared exec vitest run` Expected: 全 RC0。
- [ ] **Step 3: prettier** 本批触及文件 → `prettier --check` 0 差异。
- [ ] **Step 4: 独立 review**（release-reviewer / 子代理只读）：对照本计划逐 Task 验收，重点 Review Focus 5 条；**真实 UI 验收不能只断言 class 名**。
- [ ] **Step 5: 交接**：更新 `D:\claude\partner-w\DELIVERY_STATE.md`（Open #6 进展，**不在 WT git 仓内**）+ `D:\backup\pre19-20261008\LEDGER.md`。不含构建/打包。
- [ ] **Step 6: 真机验收移交（审核 §6 十场景；用户点名五面为其子集）**：
  1. 无输出等待 → 思考 → 工具 → 再次思考 → 正文 → 结束：**当前工具与思考无三层点击**；头像/正文不重挂载。
  2. 同文本不同 task/run 不串时长；切任务、定稿重挂载、重启历史**不编秒数**；首个正文出现后仍生成时状态不得提前完成。
  3. 批准与 ask_user：无转圈扫光；真实按钮有效；**拒绝/取消/过期可退出**；另一任务请求不污染。
  4. 三个不同真实工具错误 → 可区分且准确的说明；未知如实；重复计数正确；路径/凭据不泄漏。
  5. 工具失败后替代路径成功：失败事实保留、恢复状态准确；不新增会再次收费的假「单工具重试」。
  6. 同任务多消息只一次初始整任务水合；`artifact:saved` 后刷新；切 workspace 复用同 ID，**旧成功/失败回包不得更新当前展示**。
  7. 跨消息同族新版胜出、missing 回退、unknown 待核对；聊天 current 与右栏一致；水合/交付中不闪「无回答→重新尝试」。
  8. 文件仅 `generate→write→validate→register→可重新打开` 后报交付成功；模型结束但未登记时继续展示交付状态。
  9. 长代码流、四反引号、混合 fence、引用/列表中的代码、docgen/htmlgen 专用块；光标、复制按钮、生成状态正确。
  10. 亮/暗色、窄窗、滚动离底后新输出、展开历史、键盘、reduced-motion；对照用户截图与真实 WorkBuddy 录屏。
- [ ] **Step 7: 提交**（若 WT 内文档有改动）：`docs(chat): 对话可视化改造批次收口（计划 v2 存档）`

---

## 回滚

改动集中在 renderer 呈现层 + 3 个新文件；按提交级 `git revert`。业务语义面（tool-activity 执行判据 / message-store / 重试链 / artifact 归并判据 / 计费）零改动。

## 已知取舍（供复审裁决）

1. **回合时长边界** = 该助手块「在屏区间」（等待→定稿），主路径=整轮全程；切任务重挂载为下限，不向上补；历史不显示。若复审不接受此边界，可整条移除（Task 1 独立可回退）。
2. **明细区字号**：真实工作台 12px；本仓最近档 13px（不新开档）；如须严格 12px，加档一行。
3. **思考流式正文默认可见**（真实工作台 autoScroll=!isFinished 等价行为）；若产品要"运行中也默认折叠"，改 Task 2 初值一处。
4. **惰性正文**（定稿收起时不入 DOM）理由=长 CoT 性能 + 定稿不闪重排；旧断言按新语义**诚实改写**（非为保断言藏文本）。
5. **`useTurnActivity` 浮出 `awaitingApproval`**：派生值，判定仍走唯一出口；`awaitingAnswer` 在 ComposerActivity 内联（questionStore 按 activeTaskId 过滤）。
6. **族键既有行为记录**（不改归并判据）：`报告.pptx`（无哈希）与 `报告-3f2a1b8c.pptx` 不同族（无匹配时全名含扩展名参与比较）。
