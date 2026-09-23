# 工作区写入闸门（红线落实）——设计

**日期**：2026-09-23 · **分支**：`fix/workspace-escape-guard` · **目标版本**：0.0.27

**上游红线**（用户 2026-09-22 拍板）：分析/工具的中间产物必须落**工作区或系统临时目录**，
绝不落桌面/文档/下载/主目录；**非要在工作区外写，必须先问**。

## 0. 为什么现在做

0.0.26 真盘实测：用户分析 Word 时**桌面出现文件**。助手说"是为了分析"，随后自己删掉。
**删掉 ≠ 没发生** —— 产品要装在客户机器上，未经允许写工作区外会直接变成投诉与信任问题。

## 1. 事实基础（2026.9.3 随包运行时，自测非推断）

| #   | 事实                                                                                               | 证据                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| F1  | 客户端**从不设**任何工具闸门                                                                       | 本机真实 `<state>/openclaw.json` 的 `tools` 段只有 `deny`（两个 memory 工具）                                                   |
| F2  | `tools.fs.workspaceOnly` **默认 false**（不限制）；它是 `FsToolsConfig` 的**唯一子键**，读写一起锁 | `dist/health-tuyyTTVY.d.ts:1944-1947`；`dist/schema-C9vBoeg0.mjs:997`                                                           |
| F3  | 该键**不覆盖 exec**                                                                                | `MUTATING_FS_TOOLS` 只含 write/edit/apply_patch；运行时自己的审计器警告此缺口（`dist/audit-CykMkbGv.mjs:797`）                  |
| F4  | **fs 工具没有任何审批通道**                                                                        | 审批 kind 联合只有 `exec` / `plugin` / `system-agent`（`dist/approval-types-CQ_BKP9V.d.ts:756`）                                |
| F5  | exec 有完整审批通道，且**我们客户端已经全接好**                                                    | 权限含 `operator.approvals`（`main/ws/gateway-client.ts:475`）；`ApprovalDialog` + `approvalStore` + `ws:exec-approval-resolve` |
| F6  | `tools.exec.mode` 是规范键：`deny / allowlist / ask / auto / full`；`ask` = 白名单未命中就问人     | `docs/tools/exec.md:125-131`                                                                                                    |
| F7  | 审批通道不可达时**默认拒绝**（`askFallback` 默认 deny）                                            | `docs/tools/exec-approvals.md:239-245`；实现 `exec-approvals-config-DFQjGFtl.mjs:61`                                            |
| F8  | **`mode` 与旧 `security`/`ask` 不得混写**（运行时会拒绝混合策略）                                  | `docs/tools/exec-approvals.md:196-205`                                                                                          |
| F9  | `workspaceOnly:true` 会连带关掉 root expansion；**per-agent 覆盖可把它改回 false**                 | `dist/tool-fs-policy-Ddk6WgAw.mjs:9-19`                                                                                         |

## 2. 设计

### 2.1 写进运行时的三个闸门

```json
{
  "tools": {
    "fs": { "workspaceOnly": true },
    "exec": { "mode": "ask" },
    "elevated": { "enabled": false }
  }
}
```

（**片段**：只列本次新增的键；文件里其余内容原样保留。）

合并语义 = **确保并保留**：

- 这三个键永远被置成上面的值；`tools` 段里其它键（`deny`、`profile`…）与 `exec` 的其它键**一字不动**。
- **always-ensure，不是 only-fill**：用户若显式设过 `workspaceOnly:false` / `mode:"full"`，会被**改回**红线值。
  理由：这是产品红线、不是偏好项。这条语义必须有按名测试钉住；将来若要开放成设置项，改的就是这里。
- **不写 legacy**：只写 `exec.mode`，不写 `security`/`ask`（F8）。
- ⚠️⚠️ **不写 `askFallback`**。设计初稿要写它（把 fail-closed 显式化），**静态探针实测证明那是错的**：
  该键**不在 `openclaw.json` 的 `tools.exec` schema 里**，写进去会让**整份配置被判非法** ——
  `config get tools` ⇒ `cli_error: OpenClaw config is invalid` + `Unrecognized key: "askFallback"`。
  审批通道不可达时默认就是 deny（F7），所以**不写 = 用默认值、语义不变**。
  该键属于**审批存储**那一侧，不是 `openclaw.json` 的 `tools` 段。

### 2.2 存量用户路径（最容易漏的一刀）

`runtime/state-config.ts:293-301` 有一条"已经一致 ⇒ 一个字节都不写"的提前返回，判据是
`token 对 && memory 段已设 && deny 已设 &&（便携时）skipBootstrap 已设`。
⇒ **新闸门必须进这个判据**，否则 token 本来就对的存量用户（包括用户自己那块 U 盘）**永远拿不到**。
这条坑本项目踩过：memory 默认值当初就是这么变成"对用户机器完全无效"的。

### 2.3 为什么 fs 只能硬闸、exec 只能"每条问"

- **fs**：F4 ⇒ 没有"问了再写"的通道，"非要写先问"在 fs 上**不可能**实现 ⇒ 只能硬拒绝。
  代价必须写清楚：`workspaceOnly` **连读一起锁**（F2）⇒ 助手可能读不了用户随口给的绝对路径。
  附件分析走的是网关 media 通道，**预期**不受影响 —— 但这属于**未验**，见 §5.2 探针。
- **exec**：F3 ⇒ 只上 fs 闸等于一半没修（shell 仍能写出去）；F6 ⇒ 只有白名单粒度，
  **没有"只对写到工作区外的命令问"**这种粒度。四个档位里选 `ask`：
  - 不选 `ask:"always"`：它让"始终允许"失效 ⇒ 每次都弹，用户会被训练成无脑点同意。
  - 不选 `auto`：红线的第二句是"必须先**问**（用户）"，`auto` 可能由模型点头 ⇒ 把红线降级。
  - 不选 `deny`：打死助手正常的工具链（Word 分析那条链就是多轮 exec）。
  - 不选 `full`（现状）：等于没做。

### 2.4 客户端侧（本期不改 UI 结构）

- 审批弹窗已有（F5）：本期只需确认它在"命令要写工作区外"这一场景下的**文案与操作可读**。
- 用户要"把产物拿到工作区外"的出口 = 已有的导出通道
  （`ipc/artifact-handlers.ts` 的 `copyArtifactToDestination`）。**本期确认界面入口是否存在**；
  不存在则登记为后续项。
- 给助手提示词加"边界一句话"（让它别反复试一个必然失败的写）：**本期不做**。
  理由 = 闸门是强制层、提示词是体验层；登记为后续。

## 3. 不做（非目标）

- 沙箱（需 docker/后端；消费级 Windows 单机没有）。
- "用户同意后允许 fs 写到工作区外"（F4：运行时没有这条通道）。
- 预置 exec 白名单：那会让"安全"变成一个需要长期维护的清单；v1 让用户用"始终允许"自己长出来。
- 不动 0.0.26 产物（0.0.26 已冻结；本改动进 0.0.27）。

## 4. 已知边界与残余风险（登记，不得写成已完成）

- **per-agent 覆盖能绕过全局闸门**（F9）：`agents.entries.<id>.tools.fs.workspaceOnly:false` 会盖掉全局值。
  今天客户端不写这个键；登记 —— 将来若做"按助手的工具设置"，必须同时收紧这里。
- **非交互 exec 会变成默认拒绝**（F7）：cron / heartbeat / 后台任务里的 shell 会失败。
  **实现前必须先盘一遍**产品里有没有依赖非交互 exec 的路径（计划里列为前置调查）。
- 本闸门只管 **fs 三工具 + exec**；`sftp` 等其它工具链不在内。
- 本设计**不解释**那次桌面文件到底是 fs 还是 shell 写的（等真盘取证）；因此按"两条都堵"取最大交集。
- `workspaceOnly` 下附件（media cache）与技能路径是否仍可读写：**未验**，见 §5.2。
- **`askFallback` 无法由我们的配置钉住**（不在 `tools.exec` schema 里，写了整份配置非法 ⇒ 见 §2.1）：
  它留在**审批存储**那一侧、默认 deny。将来若要显式钉死（防止某台机器的存储里被改成 `full`），
  必须走审批存储的接口，且**先在真运行时验一次**。
- **运行时的 `.last-good` 回滚可能把闸门吞掉**（复核者 Minor 7，**本机无法证伪**）：回滚判据含
  `missing-meta-vs-last-good` 一类，而 `openclaw.json.last-good` 若还是**旧版**（无闸门）⇒ 回滚后闸门**静默消失**。
  ⇒ 手工验收里加了一步：真机跑一轮后**读一眼** state 里 `openclaw.json` 的 `tools` 段。
- **`deny` 里的非字符串条目被静默丢弃**（复核者 Minor 6）：是 sanitize 不是传播（比原样写出非法形态好），
  代价是"用户手写的条目被无声删掉、日志里一句话都没有"。登记。
- **§6 的行号基于基线 `608882ff`**（改动后已位移）。

## 5. 验收

### 5.1 单测（`packages/desktop/test/runtime-state-config.test.ts`，按名钉住）

1. 首跑：三个闸门都在，且**不写 legacy `security`/`ask`**。
2. **存量用户（token / memory / deny 都早就对）也必须补上 —— 提前返回不能漏了它**。
3. 用户自己的其它 `tools` / `exec` 键**不被覆盖**（已 deny 的项、`profile`、`strictInlineEval` 等）。
4. 幂等：连跑两次，文件字节不变。
5. 用户显式 `workspaceOnly:false` / `exec.mode:"full"` ⇒ 被改回红线值（always-ensure 语义）。
6. 以上每一条都要配**一条实跑的变异读数**（删合并 / 删提前返回判据 / `true`→`false` / 混写 legacy ⇒ 各自按名变红）。

### 5.2 真运行时（唯一真证据；分两级）

**静态级 —— ✅ 已做（2026-09-23，真运行时 CLI）**：把合并后的配置写进临时 state，让运行时自己读回 ⇒
`tools.fs.workspaceOnly: true` / `tools.exec.mode: "ask"` / `tools.elevated.enabled: false`
**三条原样读回**；同一次探针**抓到** `askFallback` 会让整份配置被判非法（见 §2.1）。
⚠️ 这证明的是"**运行时认得这些键**"，**不是**"行为上真的拦住了" —— 后者是下面那条。

**另两次探针（2026-09-23 补，复核者 Minor 5 要求）**：
① **合并后的 legacy 输出形态**（`{strictInlineEval:true, mode:"ask"}`，无 `security`/`ask`）被**接受**；
② **混合形态**（`mode` 与 `security`/`ask` 并存）被**拒绝** ——
`mode cannot be combined with security or ask in the same exec object`（并点名 `tools.exec.mode`）
⇒ **F8 从"文档说"升级为"实测"**。⚠️ 校验器是运行时自己的 CLI；网关启动走同一份 schema 属**同源推断**，
未单独实跑网关。

**行为级 —— 未做**：

- 让真网关的 agent `write` 到 `%USERPROFILE%\Desktop\<probe>` ⇒ **被拒**。
- 让 agent 跑一条 shell 命令 ⇒ **出现审批请求**；断开审批通道 ⇒ **被拒**（fail-closed）。
- 同一次探针里顺带验 §4 的未验项（附件/media 在 `workspaceOnly` 下是否仍可读；`askFallback` 在审批存储里的实际取值）。
- 跑不通 ⇒ 把手工验收步骤写进计划账本，并**明说不算证据**。

## 6. 落点

- 分支 `fix/workspace-escape-guard`（基于 `608882ff`）；`fix/local-credential-exposure` 的指针在审查通过前**不动**。
- 触点：`packages/desktop/src/main/runtime/state-config.ts` ——
  `mergeToolsDefaults`（`:201`，扩成"确保并保留"三闸门）+ 提前返回判据（`:293-301`）+ 新谓词；
  测试在 `packages/desktop/test/runtime-state-config.test.ts`。
- **不碰 0.0.26 产物、不碰更新源、不发版。**
