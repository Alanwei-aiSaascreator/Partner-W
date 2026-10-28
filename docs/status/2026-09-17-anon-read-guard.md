# 未登录读面收口（迁移 42 / 43 / 44）上生产记录

**日期：** 2026-09-17
**外层分支：** `feat/p2-market-creator`（提交 `c277658` / `56e6907` / `44eb7d0`）
**触发：** P2 上线探针③ —— 拿 anon key 能 select 出 `agent_templates` 官方模板**整行**（含 `instructions` 提示词）。

## 做了什么

| 迁移                                                   | 表                             | 改动                                                                                          |
| ------------------------------------------------------ | ------------------------------ | --------------------------------------------------------------------------------------------- |
| `20260917000042_agent_templates_anon_guard.sql`        | `agent_templates`              | `template_select` 加 `to authenticated`（谓词逐字不动）                                       |
| `20260917000043_community_anon_read_guard.sql`         | `posts` / `comments` / `likes` | `post_select` / `comment_select` / `like_select` 同样加 `to authenticated`                    |
| `20260917000044_posts_policy_mirrors_can_see_post.sql` | 同上三张表                     | 三条策略改为**直接调用 `can_see_post()`**（与 RPC 同一份定义）；并给 authenticated 授权该函数 |

三条**都不动表结构、不动数据、不动 RPC、不动触发器**（42/43 纯策略；44 除三条策略外，
只多一条给 authenticated 的函数授权 —— 因为策略要调用 `can_see_post()`）。业务语义不变 ——
「公开」= 所有**登录**用户可见（客户端根本没有匿名场景：所有读都走 definer RPC，
RPC 只 `grant` 给 authenticated，anon 实测 401 `42501`）。

## 怎么确定"就这几张表"

没有靠猜：直接查 `pg_policies` 里**能落到 anon** 的 SELECT/ALL 策略（`roles` 不含
`authenticated` 限定的），共 15 条，逐条读谓词：

- 12 条靠 `auth.uid()` / `auth_org_ids()` / `is_org_admin()` 兜底 ⇒ anon 下分别实测为
  **NULL / 空集 / false**（三者在 anon 角色下都验过）⇒ 读不到任何行；
- 真正能命中 anon 的只有 3 条：`post_select`、`comment_select`、`like_select` 的
  `visibility = 'public'` 分支 —— `init.sql`（9-10）写下、38 号迁移重写 `like_select` 时照抄。

## 证据

- **行为实证（本地，造行后回滚）**：库里 2 帖（public + org 各一）/ 1 评论 / 1 点赞 ⇒
  anon 读到 **1 帖 + 1 评论 + 1 点赞**，正好是公开帖那一份；迁移 43 后 ⇒ `0|0|0`。
- **TDD 两轮都先红后绿**：
  - 42：`agent_templates.sql` ⑪ 段（anon 读模板 / anon 读安装记录 + 「已登录读得到」对照）——
    旧策略下**只有目标那条红**、对照绿 ⇒ 不是查询写错；
  - 43：`community_team.sql` ㉑ 段（anon 读帖/评论/点赞 + 两条对照：库里确实造出了行、
    已登录用户照旧读得到公开帖）。
- 本地 **20 个 SQL 测试文件全 PASS**；`db push --linked --dry-run` 每次都只列当次要推的那一条。
- **生产探针（同一条脚本，推 42 前/后）**：`agent_templates` 从「返回官方模板行」变成 **`HTTP 200 []`**
  —— 同一脚本、几分钟内的前后对照。

## ⚠️ 43 在生产**没有**行为证据（如实说明）

`posts` / `comments` / `likes` 在生产是 **0 行**，所以探针推前推后都是 `200 []` ——
这条**不能**当验证。43 的生产证据只有「push 成功」+「本地语义测试」；
真正想在线上观察到它，要等第一条真实公开帖（或 P1 的双账号彩排）。

✅ **后来补上了结构级证据**：拉生产 schema 比对（命令见下节），确认 43/44 的策略与
授权在生产上确实生效。但要说清楚这是 **DDL 级**证据，不是行为级。

## 回滚

- 42：把 `20260917000039_agent_templates.sql` 里那段策略原文重跑一遍即可。
- 43：`post_select` / `comment_select` 的原文在 `20260910000001_init.sql`，
  `like_select` 的原文在 `20260917000038_p1_community_rpcs.sql`。

## 顺带发现：表策略比 RPC 宽（迁移 44 已处置一处，另一处**是我判断错了**）

同一次 `pg_policies` 扫描看到两处「表策略比 RPC 宽」，逐条验之后是一真一假：

1. ❌ **"同组织的人能直读别人 private 帖的评论/点赞" —— 我判断错了，实测读不到。**
   那两条策略的 `exists (select 1 from posts p …)` 子查询**自身也受 posts 的 RLS 过滤**，
   私有帖在里面就已经不可见 ⇒ EXISTS 恒假。是兜底、不是设计。㉒ 段把这条行为钉成了断言
   （免得以后有人改子查询时把它弄丢）。
2. ✅ **真问题：org 分支口径不同** —— 策略用 `auth_org_ids()`（**所有**所属组织），
   RPC 用 `primary_org_id()`（**当前团队**）⇒ 多组织用户能直读非当前团队的帖子
   （本地实测：甲同属 A/B、当前团队 A 时，直读 B 的 `org` 帖读得到）。
   **迁移 44 已修**：三条策略改为直接调用 `can_see_post()`（同一份定义 ⇒ 结构上不可能再漂移），
   并给 authenticated 授权该函数（策略按查询者身份求值，与 `auth_org_ids`/`is_org_admin` 同理；
   anon 不授权 —— 三条策略都是 `to authenticated`，anon 走默认拒绝、不求值函数）。
   该 grant 已登记进 `rpc_auth_guard.sql` 的授权矩阵。

## 怎么在生产上验 DDL（不需要 psql / service_role）

42/43 那种"探针读一行"的验证，在这三张 0 行的表上**给不出信息**。可用的替代是
**拉生产 schema 出来比对**：

```bash
supabase db dump --linked --schema public -f /tmp/prod-schema.sql < /dev/null
```

实测不需要 DB 密码（`--linked` 用已存的凭据）。42/43 推完后 dump 出来的就是
`CREATE POLICY … FOR SELECT TO "authenticated"`，44 推完后是
`USING ("public"."can_see_post"(…))` + `GRANT ALL ON FUNCTION can_see_post TO authenticated`
（且**没有** anon 那一行）。这是**结构级**证据，不是行为级 —— 行为级仍要等真实数据。
