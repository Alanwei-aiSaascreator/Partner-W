# P3（悬赏 + 成长中心）上生产记录

**日期：** 2026-09-17
**分支：** 外层 `feat/p2-market-creator`（P3 的迁移直接跟在它后面）；
内层 worktree 沿用 `feat/assistant-task-workbench`
**设计 / 计划：** `docs/superpowers/specs|plans/2026-09-17-p3-bounty-growth*.md`（外层仓库）

## 这一批做了什么

把内测中心里本机模拟的「悬赏」「成长中心」做成**真后端 + 真界面**，并从内测中心毕业。

| 迁移             | 内容                                                                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `20260917000045` | 四张表（`growth_entries` 账本 / `growth_accounts` 余额缓存 / `bounties` / `bounty_events` 审计）+ 幂等唯一索引 + definer 余额触发器 + append-only 触发器 + `can_see_bounty()`（**唯一一份**可见性定义）+ RLS 只读策略 |
| `20260917000046` | 成长 RPC：`growth_summary` / `growth_history` / `growth_check_in`（+ `growth_today()` 把「按 Asia/Shanghai 算今天」钉成一处）                                                                                         |
| `20260917000047` | 悬赏 8 个 RPC：`bounty_create`（托管）/ `claim` / `release` / `submit` / `accept`（发放）/ `reject` / `cancel`（退款）/ `list` + `bounty_lock`（内部辅助，**刻意不授权**）                                            |

产品决定（用户 2026-09-17 拍板）：奖励用**成长值托管结算**（不碰计费额度/真钱）；
**任何人可发布、发布者验收**；分数改名**「成长值」**以区别于计费「积分」。

## 生产验证（已做）

推送：`supabase db push --linked`，`--dry-run` 先确认只列 45/46/47。

**行为级（anon 探针，只读）：**

| 探针                                                                           | 结果                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| 四张表 anon 直读                                                               | 全部 `HTTP 200 []`（能建连、读不到行 ⇒ 不是"打不开"） |
| `growth_summary` / `growth_check_in` / `bounty_list` / `bounty_create`（anon） | 全部 **401 `42501 permission denied`**                |
| **负对照**：不存在的表                                                         | 404 `PGRST205` ⇒ 上面的读不是假象                     |

**结构级（`supabase db dump --linked --schema public`）：**

- 四条策略都是 `FOR SELECT TO "authenticated"`；
- 授权面：6 个客户端 RPC → `authenticated` + `service_role`；
  `can_see_bounty` → `authenticated` + `service_role`（**无 anon**）；
  `bounty_lock`、`sync_growth_account`、`reject_row_change` → **只给 `service_role`**；
- ⚠️ 如实说明：四张表对 `anon` 仍有 Supabase 默认的**表级** GRANT（`GRANT ALL ON TABLE`），
  数据安全靠的是 RLS 策略（与全库其余表一致）；探针已证 anon 读不到行。

自动化证据：SQL **75 条断言**（`scripts/tests/bounty_growth.sql`，两轮变异验证）；
客户端全量 **1386 passed / 2 skipped（163 文件）**；`lint` / `typecheck` / `typecheck:tests` /
`typecheck:e2e` / `check:i18n` / `architecture` / `ui-contract` / `renderer-copy` 全通过。

## 执行中抓到的真问题（都已修 + 已加断言/注释）

1. 🔴 **余额触发器在负数上必崩**（迁移 45 已改）：`insert … on conflict do update` 会先做
   **试探性插入**，而 CHECK 约束在**检测冲突之前**求值 ⇒ 托管扣款（amount 为负）时试探插入的
   `balance=-100` 先撞 `balance >= 0`，永远走不到"更新已有行"。**第一次发悬赏就会在生产上爆**。
   修法：把「确保行存在」（种子固定 0）与「应用增量」分开。
   ⚠️ 排查陷阱：在外面手写同样的 ON CONFLICT 是**好的**，只在触发器路径炸 ——
   一度让我误以为是 definer / RLS 的问题，做了三层最小复现才定位。
   顺带查了 P1/P2 的计数触发器：它们是 `update … set x = x + 1`，**没有这个模式**。
2. **已提交的悬赏，领取者没有出口**：不能放弃、不能取消，只能等作者表态 ⇒
   `release` 改成 `claimed` 与 `submitted` 都能走（作者仍可打回或取消）。
3. **`typecheck` 抓到 eslint 与单测都看不见的遗留**：删模块时漏了 `ICONS` 表里的
   `bounty: CircleDollarSign`（图标还解析得到，所以 eslint 不响），
   是 `Record<BetaModule, …>` 的键约束拦下的。
4. 测试自身两处写错（不是实现错）：cancel 对已提交的期望应是 `invalid_state`
   （那个状态连作者也不能取消）；守恒断言原先把全局账户都算进去 ⇒ 重写成
   **`sum(余额) == sum(账本金额)`** 与 **`sum(累计获得) == 正数账目之和`**，更强也更稳。
   另：悬赏 tab 的测试夹具我一开始写成驼峰，而 IPC 回来的是数据库原始行（snake_case）
   ⇒ 归一化器一律读到 undefined、界面上永远没有动作按钮。

## 待人工验收（**这次能在生产上做**，因为现在有真实账号）

用本 worktree 的 `pnpm dev`（客户端连托管 Supabase，即生产）：

1. 全局栏「成长」→ 余额与明细出现；点**签到** ⇒ +20、按钮变「今日已签到」；
2. 退出重进/重启 ⇒ 仍显示已签到、**不再加分**（按天幂等）；
3. 「团队协作」→「悬赏」→ 发一条 100 分的悬赏 ⇒ **成长值立刻少 100**（托管）；
4. 换第二个账号（**先把它加进同一个团队**）⇒ 能看到并领取 → 提交；
5. 切回第一个账号 ⇒ **通过验收** ⇒ 领取人 +100、发布者累计获得不变（花掉不掉级）；
6. 再发一条并**取消** ⇒ 成长值退回；已有人领的也能取消（这是设计取舍，见设计文档 §5.1）；
7. 重启客户端 ⇒ 列表、余额、明细都还在。

## 回滚

迁移纯追加（四张新表 + 附属触发器/函数，不碰任何既有表、不碰计费）⇒
回滚 = drop 这四张表与 12 个函数（3 成长 + 8 悬赏 + `bounty_lock`）。
若已产生真实成长值数据，回滚前先快照。客户端回滚 = 回到 `1a42574^`（内层）。
