# P1（广场 + 团队）上生产记录

**日期：** 2026-09-17
**分支：** 外层 `feat/p1-community-team`、内层 `feat/p1-community-team`（worktree `local-file-artifact-loop`）
**设计文档：** `docs/superpowers/specs/2026-09-17-p1-community-team-design.md`
**实施计划：** `docs/superpowers/plans/2026-09-17-p1-community-team.md`

## 这一批做了什么

把内测中心里「广场」「团队」两个 localStorage 假模块做成真功能：数据库层新增邀请机制与 16 个 definer RPC，客户端在主界面提供广场（发帖/评论/点赞）与团队（成员/邀请码/切换团队）。**计费路径一个字节都没碰。**

| 迁移             | 内容                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260917000035` | `org_members.is_primary`（部分唯一索引 + BEFORE INSERT 兜底触发器）、`primary_org_id()`、`member_display_name()`（昵称 → 脱敏手机号，绝不返回完整号码）                               |
| `20260917000036` | `org_invite_codes` 表 + 建码/列码/撤销/用码加入（`select … for update` 行锁，防并发超发）                                                                                             |
| `20260917000037` | `team_current` / `team_members` / `team_switch` / `team_member_set_role` / `team_member_remove` / `team_leave`                                                                        |
| `20260917000038` | 广场 6 个 RPC（计数一律 `count(*)` 现算）+ **删掉 4 条写策略**（`post_insert` / `comment_insert` / `comment_update` / `like_write`）+ `like_select` 从 `using(true)` 收紧成可见性判断 |

**顺带补掉的真实漏洞**：`comment_insert` 与 `like_write` 原来只校验"作者是你自己"，**不校验帖子可见性** —— 知道 post id 就能给别人的私有帖评论、点赞。P1 把这两条路收掉了（写入一律走 RPC）。

## 生产验证（已做）

推送：`supabase db push --linked`，**只应用了 35–38**（34 已在生产历史里，不会被重放）。

| 探针（anon key，只读）                               | 结果                                                                                   |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /rest/v1/org_invite_codes?select=id&limit=1`    | HTTP 200 `[]` ⇒ 表已建、RLS 挡住内容                                                   |
| `GET /rest/v1/org_members?select=is_primary&limit=1` | HTTP 200 `[]` ⇒ 新列已建                                                               |
| **负对照**：`GET /rest/v1/definitely_not_a_table`    | HTTP 404 `PGRST205` ⇒ 上面两条的"空"不是假象（顺带证明 PostgREST schema cache 已刷新） |
| `POST /rest/v1/rpc/team_current`（anon）             | HTTP 401 `42501 permission denied`                                                     |
| `POST /rest/v1/rpc/community_feed`（anon）           | HTTP 401 `42501 permission denied`                                                     |
| `POST /rest/v1/rpc/team_join_with_code`（anon）      | HTTP 401 `42501 permission denied` ⇒ 授权面只给 authenticated                          |

自动化证据：SQL 测试 `scripts/tests/community_team.sql` **50 条断言**全绿（含"非成员不能评论/点赞"与"计数现算"两条回归，其中计数那条**做过变异验证**：把 `community_feed` 改回读旧列会变红）；客户端 `pnpm test` 全包通过（shared 41 / core 242 / pwa 61 / desktop 1290）。

## 待人工验收（双账号彩排）

⚠️ **别同时开两个客户端**（dev 客户端的网关会抢 18789）。社区功能是服务端的，两个账号**先后**跑即可：

1. 用本 worktree 的 `pnpm dev` 起客户端（老 EXE 里没有这些界面；打包已明确推迟）
2. A 登录 →「团队协作」→ 成员页只有自己 → 生成邀请码
3. A 退出 → B 登录 → 输码加入 → 看到 A 团队 2 名成员；切换器能切回自己空间
4. A 发一条"团队可见" → B 进广场看得到；B 点赞 → **A 那边计数是 1**（不是 0）
5. 两边各自重启 → 内容都在

## 回滚

设计文档 §10。要点：迁移纯追加；**唯一有破坏性的动作**是替换那 5 条策略，而它们**只在 `20260910000001_init.sql` 里定义过一次**、之后没有任何迁移改过（已逐文件核对）⇒ 可逐字还原。改动前的策略定义可用 `scripts/p1-preflight-snapshot.sql`（外层仓库）存档。

## 执行中发现并修正的问题

1. **迁移拆成 4 个文件**（原计划单文件）：单文件在本地标记"已应用"后无法增量迭代，拆开才能每步"apply → 跑测试"。
2. **迁移 34 提前带入分支**：本地 `supabase migration up` 会因"远程有 34、本地没有"直接拒绝。
3. **我最初的缺陷描述有误，已更正**：`posts.like_count` 经 definer RPC 写入时**是准的**（触发器以 owner 身份运行、RLS 被绕过）；无条件偏差的只有 `comment_count`（它**没有**任何触发器）。变异验证因此改成钉 `comment_count`，测试里加了一条"这一列仍是 0"的对照断言。
