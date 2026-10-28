# P4（埋点分析 + 隐私合规）上生产记录

**日期：** 2026-09-18（设计/计划 09-17，实现 09-17 深夜—09-18，推生产 09-18；
计划里写作 `2026-09-17-p4-analytics-privacy-deploy.md`，实际文件名按落地日）
**分支：** 外层 `feat/p2-market-creator`；内层 worktree `feat/assistant-task-workbench`；后台 `feat/admin-console-foundation`（**三个分支都未 push**）
**设计 / 计划：** `docs/superpowers/specs|plans/2026-09-17-p4-analytics-privacy*.md`（外层）

## 这一批做了什么

| 迁移                    | 内容                                                                                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 48 `analytics_events`   | 埋点事件表（RLS 开、**无任何 authenticated 策略**、`revoke all`；只有 definer RPC 读写）                                                                            |
| 49 `analytics_rpcs`     | `analytics_track`（白名单/批次/限流/时间窗）+ 运营读面 `admin_analytics_overview`/`admin_analytics_events` + purge                                                  |
| 50 `privacy_tables`     | `privacy_requests` / `privacy_request_events`（append-only）；`subject_id` **刻意无外键**；**表级 ACL 收口**（原来 authenticated 能 TRUNCATE 整表）；快照配对 CHECK |
| 51 `privacy_rpcs`       | 客户端五函数（state/export/download/deletion/cancel）+ `privacy_build_export`；下载状态闸；复用不再死锁（僵尸单自动收口 `snapshot_purged`）；并发 23505 兜底        |
| 52 `privacy_admin_rpcs` | 运营六函数（list/detail/reject/execute/complete/purge）；六条阻断点处置；临时停 append-only 触发器 + 显式恢复；9 条 FK 支持索引；逐卡审计                           |

客户端：埋点 11 个动作点 + `module_opened` 60 秒节流、preload 通道；设置页「隐私与数据」（导出/删除工单全流程 + 二次确认）；内测中心「埋点分析」移除、「隐私与合规」毕业。
后台：埋点看板 + 隐私工单页（能力表与 RPC 角色数组逐条对齐）。

## 生产验证（已做）

- **dry-run（推之前，只读）**：只列 48–52，无多余编号。
- **推生产**：`npx supabase db push --linked` ⇒ 五个全部 applied。
- **只读核验**（推完即跑）：`new_tables=3`、`rls_on=3`、隐私函数 `14`、两张 append-only/touch 触发器各 1 且 `tgenabled='O'`、最高迁移 `20260917000052`。
- **anon 探针**：`anon` 对 `analytics_track` / `privacy_request_deletion` **无 execute**、对新表 **无 select**；`authenticated` 有 select、**无 TRUNCATE**（收口生效）；`authenticated` 读不到 `analytics_events`、也执行不了 `privacy_build_export`。
- **财务不动**：`licenses=8 / orders=7 / usage_records=144`，推前推后与彩排后**三次一致**。

## ⭐ 真实删除路径的生产彩排（2026-09-18，本轮新增）

此前整条链只在本地 Docker 验过——而本批自己的证据写着"**本地绿 ≠ 生产能删**（本地 postgres 可能是 superuser）"。这次在生产真跑了一遍：

1. **造包袱**（一次性账号 U `…f001` + 邀请对象 M `…f002` + 组织 + 成长账本/流水 + **到期的删除工单** `6d3453d3-db0f-4d2d-9abf-6cc287255046` + `requested` 流水）。
2. **影响面预览**（以运营身份调 `admin_privacy_detail`）：`will_be_pre_cleaned.invited_members=1`、`requires_trigger_exemption.growth_entries=1`、`multi_member_owner=false` —— 与设计的三组分离口径一致。
3. **执行**：`admin_privacy_execute` ⇒ `{completed: true, unlinked_invites: 1}`。
4. **核验**：U 已从 `auth.users` 消失；M 的 `invited_by` 解绑；成长流水随级联清空；**两张 append-only 触发器恢复 `tgenabled='O'`**；工单 `completed` 且流水恰好 `requested → processing → completed`；财务三表不变。
5. **清理**：删 M 与三个组织；**工单 `6d3453d3…` 按设计保留**（append-only 使它不可删——这本身就是设计不变量，留作本次彩排的审计痕迹）。
6. **彩排的额外发现**：插入 `auth.users` 会**自动开个人组织**（`slug = u-<uuid无连字符>`、名字取自用户昵称）；注销后该组织以 **0 成员**残留——正是计划里"organizations 不删（PII 残留，与财务不参与删除冲突）"那条已知遗留的**生产实锤**。

## 删除路线（Task 1 结论）

**路线 A**：数据库内的 definer 函数即可删 `auth.users`（显式 GRANT + BYPASSRLS，**不是** superuser）。本次彩排 = 路线 A 在生产成立。

## 运维：保留期由谁执行

- 埋点 `analytics_events`：**180 天**，由运营 RPC 清理（后台「埋点」页）。
- 导出快照：**30 天**，由后台隐私工单页的「清理快照」入口执行（`privacy.manage`；0 条不写审计）；未结单会被收口成 `failed/snapshot_purged`，已结案只清快照、保留状态。
- 工单行本身：**永久保留**（审计用途；不可删，见彩排第 5 条）。

## 待人工验收（清单）

- [ ] 客户端设置页「隐私与数据」：申请导出 → 下载（含截断提示）→ 申请删除 → 撤回 → 再申请（冷却 7 天）
- [ ] 运营后台：埋点看板两页有数；隐私工单列表/详情/驳回（填理由）/执行（含波及卡清单二次确认）
- [ ] `viewer` 登录能看到「埋点」；`support` 能看隐私工单并驳回、**不能**执行删除
- [ ] 内测中心不再有「埋点分析」与假的「隐私与合规」；真入口在设置页
- [ ] ⚠️ **内测中心毕业（Task 15）合入前不要对外发版**（旧包里假入口仍在）

## 回滚

五个迁移全部**纯追加**（新表/新函数/新索引，不动既有对象与数据）：回滚 = 停用/删除新对象即可；财务与既有表不受影响。工单行与流水（append-only）保留。

## 基线与门禁（2026-09-18 收口时实测）

- 内层：desktop **174 文件 / 1526 passed + 2 skipped**；core 297；pwa 61；shared 41；`typecheck`/`lint` 0；`check:dead-code` 1 file/46 exports/75 types；`format:check` 630 文件（历史基线 632 之下）。
- 后台：**13 文件 / 224 passed**；`typecheck`、`build` 0。
- 外层：`bash scripts/test-db.sh` **23/23 PASS**（含从零 `db reset --local` 重放 01–52 与断言 158 条）。
