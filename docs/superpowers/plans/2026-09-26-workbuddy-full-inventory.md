# WorkBuddy 全量功能盘点 × 我们的家底（2026-09-26）

**怎么来的**：WorkBuddy 5.6.2 装在本机，renderer 有 **831 个懒加载 chunk**；去掉 shiki 的语法高亮包与
语言包，剩下 **756 个真模块名**。**chunk 名就是功能名** ⇒ 一份完整的产品功能地图。
⚠️ 只读；它的中文文案在远端下发，**结构拿得到、行文拿不到**。

---

## 一、它有什么（按域分组）

| 域                    | 它的模块                                                                                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **文档预览**          | `pdf-preview` · `docx-preview` · `pptx-preview` · `sheet-preview` · `excalidraw-preview` · `miora-preview` · `PreviewIframe`（**每种一份独立组件**）                                                                                                                                             |
| **上传**              | `document-upload-dock` · `document-upload-runner` · `upload-queue-store` · `use-upload-queue` · `use-describe-upload-error` · `library-upload-cache-controller`                                                                                                                                  |
| **文件**              | `my-files` · `file-open` · `file-save` · `folder-picker-modal` · `directory-open` · `use-file-search` · `netdrive-selector-modal`（网盘）                                                                                                                                                        |
| **云文档**            | `tencent-docs` · `tencent-docs-panel` · `office-cloud-upload-host` · `lexiang` · `doc-selector-modal` · `local-docs-facade`                                                                                                                                                                      |
| **编辑器**            | `editor.main` / `editor.api` / `lspLanguageFeatures`（**Monaco 全能编辑器 + LSP**）                                                                                                                                                                                                              |
| **图表与公式**        | `mermaid` · `vendor-katex` · `equation-plugin` · `footnote-plugin` · `gantt` · `treemap` · `radar` · `wardley` · `treeView`                                                                                                                                                                      |
| **项目与视图**        | `project` · `projects` · `project-list-page` · `project-detail-page` · `kanban` / `kanban-todo` · `calendar` · `task-preview` · `task-transfer-popover`                                                                                                                                          |
| **会话与深链**        | `conversation` · `conversation-route` · `deeplink` · `deeplink-landing` · `task-deeplink-coordinator` · `stale-conversation-status-writeback`                                                                                                                                                    |
| **专家 / 技能**       | `expert` / `expert-picker` / `use-market-experts` · `skills-market` · `skill-picker` · `skill-selector` · `skill-scan-result-dialog` · `standalone-skill-detail-modal` · `use-try-skill`                                                                                                         |
| **记忆 / 知识**       | `MemorySettingsPanel` · `knowledge-base-panel` · `local-skills-memory`                                                                                                                                                                                                                           |
| **设置（14 个面板）** | `Account` · `Claw` · `DataManagement` · `Extensions` · `Models` · `Personalization` · `SecurityCenter` · `SoftwareConfig` · `SubscriptionUsage` · `SystemPermissions` · `BuddyApps` · `GetHelp` · `HelpFeedback` · `keyboard-shortcuts`                                                          |
| **连接器 / 授权**     | `connector-capsule` · `connector-device-code-modal` · `connector-token-config-gate` · `mcp-token-config-host` · `McpPoiConsentCard` · `oauth` · `oneid-activation-guide`                                                                                                                         |
| **团队 / 协作**       | `colleagues` · `colleagues-panel` · `colleague-artifact-detail-panel` · `members-store` · `teams-invite-body` · `teams-join-request-actions` · `share-task-dialog` · `agent-mail` · `agent-share`                                                                                                |
| **健壮性**            | ⭐ `main-thread-dead-monitor-worker`（**主线程卡死监控**）· `resource-monitor-modal-host` · `database-recovery-modal` · `network-check` · `network-error-state` · `self-check` · `quota-toast` · `storage-quota-exceeded-dialog-host` · `credits-insufficient-bar`                               |
| **窗口**              | `app-home` · `app-shell` · `independent-window` · `settings-window-app` · `builtin-window-apps` · `main-window-navigator`                                                                                                                                                                        |
| **其它**              | `automation-panel` · `desktop-terminal-view` · `emoji-picker` · `lightbox` · `image-blob-reduce` / `browser-image-compression` / `pica`（**图片压缩三件套**）· `zoom-controls` · `miniprogram-qr-button` · `wechat-chat-history-input-intent-bridge` · `use-poi-map-feature` · `industry-config` |

## 二、我们有什么

**19 个面板**：社区 / 定时任务 / 仪表盘 / 文件浏览 / 成长 / 身份中心 / 资料库 / 左栏 / 登录 /
主区 / 市场 / 引导 / 右栏 / 设置 / 安装 / 技能市场 / 启动就绪 / 任务 / 团队
**40+ 组件**：审批 / 提问 / 命令面板 / 斜杠命令 / @提及 / 图片灯箱 / 思考区 / 工具卡 /
产物卡 / 文件预览 / 连接横幅 / 网关选择 / 错误边界 …

⭐ **我们有而它没有（或明显不如我们）的**：

- **生成 Word / Excel / PPT**（`docgen`）—— 它偏"看别人的文档"，我们**能造**
- **积分计费与卡密激活**（它有自己的额度体系，但我们的**按次计费 + 组织绑定**更完整）
- **U 盘便携形态 + 整目录远程更新**（它没有这个概念）
- **资料库本地嵌入召回**（我们的 `kb` 走本地 ONNX，它更像云端）

---

## 三、⭐ 值得学的（按"用户碰得到 × 代价"排）

### 第一梯队 · 这次 8 小时就做

| #   | 学什么                                                 | 我们有吗              | 代价                                                             |
| --- | ------------------------------------------------------ | --------------------- | ---------------------------------------------------------------- |
| 1   | **文档预览四件套**（PDF / Word / PPT / 表格）          | ❌ 只有图片/MD/代码   | 中（已有方案：PDF 零依赖、XLSX 用现成 exceljs、PPTX 解包抽文字） |
| 2   | **拖拽上传**（把文件拖进窗口就加进对话）               | ❌                    | 小                                                               |
| 3   | **上传队列 + 失败原因**（`use-describe-upload-error`） | ❌ 现在是"一次一个"   | 小                                                               |
| 4   | **联网开关**（我们功能有、够不着）                     | ⚠️ 有但默认模型用不了 | 小                                                               |

### 第二梯队 · 下一版，但**强烈建议**

| #   | 学什么                                                                  | 为什么值得                                                                           |
| --- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 5   | ⭐ **主线程卡死监控**（`main-thread-dead-monitor-worker`）              | 用户报"卡住"时我们能**自己发现**，不必等截图。我们栽过好几次"界面不动但没人知道"     |
| 6   | ⭐ **数据库恢复对话框**（`database-recovery-modal`）                    | 我们的工作区库（`.clawwork.db`）坏了现在是**直接起不来**。它有一个"修/换/重建"的出口 |
| 7   | **网络检查 + 配额提示**（`network-check` / `credits-insufficient-bar`） | 积分不够、网断了，现在用户看不出是哪一种                                             |
| 8   | **项目 / 看板视图**                                                     | 我们的"最近任务"是**平铺列表**；它是**项目 → 会话**，会话可寻址                      |
| 9   | **图表与公式**（mermaid / katex）                                       | 助手回答里的图和公式现在只能看源码                                                   |
| 10  | **文件搜索**（`use-file-search` / `my-files`）                          | 我们"产物"只能按任务翻                                                               |

### 第三梯队 · 记下来，将来再说

- **编辑器 + LSP**（Monaco）：能做，但**我们的定位不是 IDE**，别跟
- **连接器 / MCP 同意卡**：走 MCP 联网时才需要（[[bailian-enable-search-facts]] 的方案 C）
- **键盘快捷键面板**、**图片压缩三件套**、**分享任务/深链**、**日历/甘特**
- **多窗口**（独立窗口 + 设置窗口）

### ⛔ 明确**不学**

`automation-panel`（自动化）· `desktop-terminal-view`（终端）· `colleagues`（同事协作）·
`tencent-docs` / `lexiang` / `smartsheet`（它的生态绑定）· `oneid` / `wechat-chat-history`（它的账号体系）·
`use-poi-map-feature`（地图）· `miniprogram`（小程序）

---

## 四、这份盘点怎么用

- **这次 8 小时**：只做第一梯队（4 项）+ 记忆一期 + UI 收口 + 发 0.0.34。
- **第二梯队**：登记进队列，是 0.0.35 的候选。其中 **5（卡死监控）与 6（库恢复）是"防掉坑"**，
  不是锦上添花 —— 下次用户报"卡住/起不来"，有它们就能少绕一大圈。
- ⛔ **不因为竞品有就跟着做**：终端、自动化、协作都不在我们的定位里。
