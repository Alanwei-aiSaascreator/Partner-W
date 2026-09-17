# 未登录读面收口（迁移 42 / 43）上生产记录

**日期：** 2026-09-17
**外层分支：** `feat/p2-market-creator`（提交 `c277658` / `56e6907`）
**触发：** P2 上线探针③ —— 拿 anon key 能 select 出 `agent_templates` 官方模板**整行**（含 `instructions` 提示词）。

## 做了什么

| 迁移                                            | 表                             | 改动                                                                       |
| ----------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `20260917000042_agent_templates_anon_guard.sql` | `agent_templates`              | `template_select` 加 `to authenticated`（谓词逐字不动）                    |
| `20260917000043_community_anon_read_guard.sql`  | `posts` / `comments` / `likes` | `post_select` / `comment_select` / `like_select` 同样加 `to authenticated` |

两条都**只改策略**：不动表结构、不动数据、不动 RPC、不动触发器。业务语义不变 ——
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

## 回滚

- 42：把 `20260917000039_agent_templates.sql` 里那段策略原文重跑一遍即可。
- 43：`post_select` / `comment_select` 的原文在 `20260910000001_init.sql`，
  `like_select` 的原文在 `20260917000038_p1_community_rpcs.sql`。

## 顺带发现（**未处置**，留给下一批决定）

同一次 `pg_policies` 扫描还看到：**表策略比 RPC 宽**，两处不一致 ——

1. `comment_select` / `like_select` 没有排除 `visibility = 'private'` 的帖子
   （org 分支是 `p.org_id in (select auth_org_ids())`），而 RPC 走的 `can_see_post()`
   对 private 只放作者 ⇒ 同一组织的人**直读表**能看到私有帖的评论/点赞（客户端没有直读路径，
   所以目前不可达）。
2. 两者的 `org` 分支口径也不同：策略用 `auth_org_ids()`（**所有**所属组织），
   RPC 用 `primary_org_id()`（**当前团队**）。

38 号迁移当时的意图就是「把 RLS 收紧成与 RPC 一致的可见性判断」，这两处是那次的漏网。
修法同样是加条件（把谓词抄成 `can_see_post()` 的形状），需要单独一条迁移 + 断言。
