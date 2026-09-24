# 工作区文件系统自检（FAT32 那条）—— 实施记录

**Goal:** 盘上「几个助手失败」不再是一句用户无从下手的死话。助手因为**文件系统**装不上时，
界面直接说清"这块盘不支持、换 exFAT/NTFS"，并给出**按了有用**的出口（去设置里换工作区）。

**依据（真机定位，2026-09-24）**：同事那块盘上日志是 **114 条一样的**
`unsafe workspace file "IDENTITY.md"`。根因：随包运行时的 `@openclaw/fs-safe` 对**零身份**
（`dev === 0` 或 `ino === 0`）**fail-closed**，而 **FAT32 上 `dev` 恒为 0**。
三档实测：**FAT32 `dev=0` 必坏 / exFAT `dev≠0` 可用 / NTFS `dev≠0` 可用**。

**为什么以前没救**：客户端**早就认这个错**（`ws/gateway-client.ts` 的 `setAgentFile` 写过
"写失败后回读一次"的缓解），但那条缓解的前提是"其实写成功了"，而 FAT32 上**回读也失败**
⇒ 缓解一次都没生效（日志里 `gateway.agent-file.write-verified-after-unsafe` 出现 0 次）。

---

## 做了什么

| 层     | 文件                                                         | 内容                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 契约   | `packages/shared/src/workspace-fs.ts`                        | `WorkspaceFsIdentityState` / `WorkspaceFsIdentity`（跨 main→preload→renderer 的 DTO，放 shared 免得三处各抄一份字段名）                                                                                                  |
| 主进程 | `src/main/workspace/fs-identity.ts`                          | `probeWorkspaceFsIdentity(dir)`：在**真实工作区目录**里建探测文件 → `lstat(bigint)` 取 `dev`/`ino` → 删掉。**探两次**，两次都零才下结论；一次零一次不零 ⇒ `unknown`（Windows 杀毒/索引器争用会造成偶发零值，不许下结论） |
| 主进程 | `src/main/ipc/workspace-handlers.ts`                         | `workspace:fs-identity`；没有工作区 ⇒ `unknown`（**不是** ok：没量到就不许说"没问题"）                                                                                                                                   |
| 桥     | `src/preload/index.ts` + `clawwork.d.ts`                     | `probeWorkspaceFsIdentity()`                                                                                                                                                                                             |
| 判定   | `src/renderer/lib/startup-readiness.ts`                      | `assistantBlocker`：**两个独立信号都对上**才下结论（①助手确实失败了 ②探测量到问题）。只有 ① ⇒ 说不出所以然；只有 ② ⇒ 探测可能是错的，**不许冤枉一块好盘**                                                                |
| 说话   | `StartupReadinessPanel` / `startupFailureText` / 9 份 locale | 两档各一句人话 + 出口从「重新准备」换成「换工作区」（设置 → 系统）；欢迎屏那一格说同一句（用户最先看到的是它）                                                                                                           |

## 读数（本机实跑）

- 新增/改动测试：`workspace-fs-identity.test.ts` 7 条 + `startup-readiness.test.ts`（+8 条）+ `startup-readiness-screen.test.tsx`（+4 条）
- **变异电池 10 条 = 8 杀 + 2 对照**，RC=0，基线 52 条全绿
  - 杀掉的关键改法：零身份判不出来 / 只探一次 / 探测失败当 ok / **助手没失败也下结论** /
    两档对调 / 面板不给出口 / 面板吞掉那句话 / 欢迎屏不说
- `pnpm check` **RC=0**；`typecheck`、`typecheck:tests` RC=0
  （⚠️ 改了 `@clawwork/shared` 之后 **desktop 的 tsc 要先重建 shared 的 dist** ——
  它解析的是 dist 不是源码，这点与 Vite 打包不同）

## 执行期发现

1. 🔴 **`layouts/StartupReadiness/index.tsx`（整屏门禁）在产品里已经没人引用** ——
   只有测试在 import 它（面板 + 欢迎屏才是现在的路径）。
   **证据**：`git log -S"layouts/StartupReadiness" -- packages/desktop/src/renderer/App.tsx`
   ⇒ 是 `5e103c2e`（"feat(startup): prepare ai inside workspace"，即 B 方案那次重构）
   **把 import 从 App.tsx 拿掉的**，组件本身被留在原地。

   ⚠️ 后果比"死代码"更值钱：**它承载的四条文案在产品里一个字都不显示**
   （`startupReadiness.title` / `description` / **`notAnInstall`** / `keepOpen` —— 全库只有这一个文件用它们）。
   其中 `notAnInstall`（"这不是安装：程序不写进系统，也不创建桌面图标…"）是 `dd84e0b1`
   为**同事的真反馈**（"双击 exe 装到电脑"）专门加的；`keepOpen`（"请保持应用开启"）同理。
   而它的测试**仍然全绿** —— 断言的是一个**用户看不到的界面**，
   这正是"测试养着死代码、还给出假信心"的形状（本仓第三例，前两例：`presentationPathFor`、
   产物名那条线）。

   **待用户拍**（两条路，别自己选）：
   ① 把那几句（尤其 `notAnInstall`）搬到**活着的面**（面板/欢迎屏）上，再删掉这个组件与其测试；
   ② 或者它本来该被路由到（`5e103c2e` 漏接了一处）——那就把它接回 App.tsx。
   在拍之前**两者都不动**（本轮只记录）。

   ✅ **已经加的守卫**（2026-09-25）：`test/layouts-reachability.test.ts` ——
   解析模块说明符，逐个检查 `src/renderer/layouts/*` 有没有被产品代码 import；
   已知的这一条进 `KNOWN_UNRENDERED` 记账（**必须写原因**，理由太短直接红）。
   同类守卫实测：`knip` 抓不到这一类（它把测试的 import 算作"被使用"）。
   ⚠️ 这条守卫的量法**自己错过一次**：第一版搜字符串 `layouts/FileBrowser`，
   把 `import FileBrowser from '../FileBrowser'`（相对路径）误判成"没人用" ——
   现在真解析路径，并配了一条对照（必须是 `>= 17` 个认得出引用方 + FileBrowser 必须认得出）。

2. ℹ️ 探测写在**工作区根**：fs-safe 校验的是工作区里那些身份文件所在的卷，同一次安装里
   它们同卷。写在根上顺带把"这块盘能不能写"也量了（`unwritable` 那一档）。

## ⛔ 仍未验（要真机）

- **真 FAT32 盘上跑一遍**：插一块 FAT32 的盘 → 首启 → 应当**几秒内**出现那句"这块盘不支持"，
  而不是 60 秒后一句"助手失败"。本机的注入式测试只证明**判据与出口**对，
  证明不了"真 FAT32 上 `dev` 确实是 0 且探针能读到"（那要靠真盘）。
- **exFAT/NTFS 盘上不许出现这句**（假阳性检查）—— 同上，要真盘。
- 交付说明书里"文件系统要求"那段（说明书不在仓库、在工作区外）——按红线**要先问**。
