# P2（助手市场 + 创作者中心）上生产记录

**日期：** 2026-09-17
**分支：** 外层 `feat/p2-market-creator`（从 `feat/p1-community-team` 切出）；
内层 worktree 沿用其建时的分支名 `feat/assistant-task-workbench`（客户端这一批的提交都在它上面，
`e59bf8f` 起为 P2 部分）
**设计 / 计划：** `docs/superpowers/specs|plans/2026-09-17-p2-market-creator*.md`（外层仓库）

## 这一批做了什么

把内测中心里「助手市场」「创作者中心」两个 localStorage 假模块做成真功能。
**"安装"是真安装** —— 在本地网关真的建出一个助手（复用 `installPresetAgentPack`，
它本来就是幂等 + 多文件 + 失败回滚），而不是本机记个 id。

| 迁移             | 内容                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `20260917000039` | `agent_templates` + `agent_template_installs` 两张表；`install_count` 由 **definer** 触发器维护（P1 的教训）；RLS |
| `20260917000040` | 8 个 RPC（市场 3 + 创作者 5）+ 2 个内部工具函数（可见性 `can_see_template`、字段校验 `validate_template_fields`） |
| `20260917000041` | 3 条官方预置模板（`org_id`/`author_id` 为 null ⇒ 所有人可见）                                                     |

可见范围（用户拍板）：**官方 + 本组织**；**发布即上架**（不审核，管理员可下架）；
模板**含提示词**，装完即用。

## 生产验证（已做）

推送：`supabase db push --linked`，**只应用了 39–41**（先 `--dry-run` 确认过清单）。

| 探针（anon，只读）                                                                  | 结果                                                                            |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `GET /rest/v1/agent_templates?select=id&limit=1`                                    | 200 —— ⚠️ 当时我判成「符合设计」，**判错了**：这是 RLS 漏了「必须已登录」，见下 |
| `GET /rest/v1/agent_template_installs?select=…`                                     | 200 `[]`                                                                        |
| `GET /rest/v1/agent_templates?select=name&limit=5`                                  | **三条官方模板都在**（爆款内容教练 / 电商增长参谋 / 深度研究助手）              |
| **负对照**：不存在的表                                                              | 404 `PGRST205` ⇒ 上面的读不是假象                                               |
| anon 调 `market_templates` / `creator_templates_mine` / `market_template_installed` | **401 `42501 permission denied`** ⇒ 授权面只给 authenticated                    |

自动化证据：SQL **34 条断言**（`scripts/tests/agent_templates.sql`，含两种变异验证 ——
§见下）；客户端全量 **1349 passed**（2 skipped）；`typecheck` / `typecheck:tests` /
`typecheck:e2e` / lint / i18n / architecture / ui-contract / renderer-copy / ci-bot-security 全通过。

## 待人工验收（单账号即可）

用本 worktree 的 `pnpm dev` 起客户端：

1. 全局栏最底下新入口「助手市场」→ 市场里看到 **3 条官方模板**；
2. 点**安装** ⇒ **左侧助手栏立刻出现新助手**（这就是"真安装"）、卡片变「已安装」、安装数 +1；
3. **重启客户端** ⇒ 助手还在、仍显示「已安装」（服务端记账 + 本地幂等）；
4. 切到「我的模板」→ 新建一条（名字/描述/分类/emoji/提示词）→ **发布** → 回市场能看到并安装它；
5. 把它**下架** ⇒ 市场里消失（已装的那个助手不受影响）；删除按钮应从"已有人装过"起**禁用**并说明原因；
6. 顺手验收创建向导：点「创建智能体」走到写身份文件那步故意失败（例如断网）⇒ **助手列表里不留半成品**。

## 执行中发现的问题（都已在代码/计划里更正）

1. **我的 SQL 测试出现过假绿灯**：CHECK 断言用 `exception when others` 会把"表不存在"（42P01）
   也当成"约束拦住了" ⇒ 改成只认 `SQLSTATE = 23514`。
2. **计划里的变异说明是错的**：把计数触发器改成非 definer，**行为断言看不见**它
   （安装那条 INSERT 发生在 definer RPC 里，触发器本就以 owner 身份跑 —— P1 的同一个规律）；
   真正接住它的是 `pg_proc.prosecdef` 结构断言。另补"删掉触发器 ⇒ 行为断言才红"这第二种变异。
3. **迁移又踩了一次"往已应用的迁移里追加 SQL 不会重跑"** ⇒ 拆成 39/40/41（P1 同款对策）。
4. 🔴 **我先前说"门禁全绿"是错的**：改登录/额度闸门后**没跑 `typecheck:tests`**，那里压着两条
   类型错误；这次在 P2 里连带修掉，并且我自己又在 market 测试里犯了**同一个错**
   （mock 返回类型推断太窄），被 `typecheck:tests` 第二次抓住。
5. **UI 契约抓到我用裸 `text-lg/xl` 写 emoji 字号** ⇒ 改用语义类 `type-section-title`。
6. **静态 import 网关 dispatcher 害了两个既有测试**（它们对 core/platform 只做薄 mock）⇒
   `useTemplateInstall` 里改成**动态 import**（给测试补桩是打地鼠，下一个缺 `platform.ports`）。
7. ⚠️ **一次全量 suite 偶发 4 条失败**（5 个文件），立即重跑两次全绿；形态符合仓库已记录的
   偶发模式（全量并行时冷模块转换超时 + 污染共享 mock），这台机器当时只剩约 1 GB 可用内存、
   Docker 仍在跑。没有抓到失败用例名（日志被过滤吞了）——记录在此，若再复现按该模式排查。

## 后续补丁（同日晚）

探针③ 那条「官方行对所有人可见」**是错的** —— 它是 RLS 漏了「调用者必须已登录」，
不是设计。已单独出两条迁移收口（42：`agent_templates`；43：`posts`/`comments`/`likes`
同一类面），证据与回滚见 `2026-09-17-anon-read-guard.md`。

## 回滚

迁移纯追加 ⇒ 回滚 = drop 两张表 + 10 个函数（8 个 RPC + 2 个工具），不碰任何既有表。
官方种子随 41 一起 drop。客户端回滚 = 回到 `05b446d^`（内层）。
