# U 盘整目录更新发布手册

## 适用范围

本手册只适用于带盘根 `Partner-W启动器.exe` 的新基础包。现存 0.0.25 及更早包没有外置启动器，不能靠本机制原地升级；必须先人工换成一次新的基础包。

代码合并、客户包打包、测试源发布、正式源发布是四个独立授权点。没有当次明确授权时，只能运行测试和临时目录夹具，不得创建客户候选包，不得改测试或正式更新源。

### 两条发布路径，别把其中一条的前提当成两条都要（2026-09-23 用户已拍「走手工」）

- **主线 = 本手册这 11 步手工流程**（本机 PowerShell + `scripts/feed-publish.mjs`）。它**不依赖 GitHub Actions**，需要的只是发布 shell 里的那几个环境变量（见「发布前提」）。
- **另一条 = `.github/workflows/release.yml` 的自动流水线**。它需要仓库级的密钥与变量（见下），**但今天没有可跑它的仓库**：本项目的代码只在 **Gitee**（`origin` = `diguade/partner-w-desktop`），GitHub 上只配了**别人的公开上游**当 `upstream`（拉基线用），没有任何本项目的仓库 ⇒ 那条流水线**当前不可用**。
  ⇒ 因此下面凡是提到「仓库级密钥 / `vars.PARTNERW_MIN_LAUNCHER_VERSION` / `release` job 可见性」的条目，**只在那条自动路径下才是前置**；**走手工路径不需要建任何 GitHub 变量或密钥**，在发布 shell 里 `export` 就是全部要求。
  ⇒ 若将来要启用手工之外的自动路径，先建一个**本项目的** GitHub 仓库（商业源码进第三方托管，需单独授权），再把那些密钥/变量设在**那个**仓库上；设在 `upstream` 上既无权限、也会把发布指向别人的仓库。

## 发布前提

- 工作树干净，发布 tag 与 `packages/desktop/package.json` 版本一致。
- Go 版本由 `launcher/go.mod` 固定；`go`、Node.js 20、pnpm 10 都在 PATH。
- ⚠️ **下面两条只属于自动路径**（`release.yml` 那条，今天没有可跑它的仓库）。**走手工路径不需要 GitHub 环境**，也不需要在 GitHub 上放任何密钥 —— 手工路径要的私钥/公钥都在**仓库外的文件与发布 shell** 里（见第 1/3/5 步与下一条）。留在原处只是为了让将来启用自动路径的人看得到它们：
  - GitHub 环境 `portable-update-production` 已启用审批保护。
  - 受保护环境中同时存在：
    - `PARTNERW_UPDATE_PUBLIC_KEY_B64`
    - `PARTNERW_UPDATE_SIGNING_KEY_PEM`
    - `PARTNERW_UPDATE_FEED_UPLOAD_TOKEN`
- 上传器在**发布 shell** 里要两个环境变量，**每开一个新 shell 都要重设**（第 3/5 步设过的不会自己跟到第 7/9/10 步）：
  - `PARTNERW_FEED_OPERATOR='<本执行人>'`：**凡是会写审计行的模式都必须设** —— `--preflight` / `--commit` / `--break-lock`（两条恢复路径都算）。不设时工具按 `unknown` 落账，"谁在什么时候破了这把锁"就没有答案。
  - `PARTNERW_UPDATE_PUBLIC_KEY_B64='<与私钥匹配的 SPKI Base64 公钥>'`：**除 `--preflight` 与 `--break-lock` 之外的每一种模式都要**（`--dry-run` / `--commit` / `--re-sign-stable`，见第 3/5/9 步）；`--re-sign-stable` 还要 `PARTNERW_UPDATE_SIGNING_KEY_FILE`。
- 私钥只允许写入系统临时目录，不得进入仓库、日志、客户包或长期制品。
- ⚠️ **`PARTNERW_UPDATE_PUBLIC_KEY_B64` 必须对 `release` job 可见** —— 只放在受保护环境里**不够**：`release`（`release.yml:54`，mac/win/linux 四平台矩阵）**没有声明 `environment`**，所以只挂在 `portable-update-production` 上的密钥对它不可见。而 2026-09-23 起客户端构建与打包都把公钥当**前置**（`scripts/require-update-public-key.cjs --require-env`；实测空值 RC=1 并点名变量与后果、真值 RC=0）⇒ 若密钥只存在于环境里，`release` 的四个构建会全部硬失败，而 `portable-update-release` 依赖 `release`，整条流水线一步也走不到（失败方向是响的，但会卡在发版当天）。公钥是公开量（内嵌在每个安装器里），放**仓库级**不增加暴露面 —— 建议同名存成仓库级密钥。⚠️ 当前实际存储范围**无法从仓库判断**，发版前请在 GitHub 设置里核对一次。
- **两个版本变量含义不同，别混用**（2026-09-23 拆开；以前是同一个变量名，见第 5 步的纠正表）：
  - `PARTNERW_LAUNCHER_VERSION`：**本次构建的启动器自己的版本**（第 3 步；ldflags 注入）。
  - `PARTNERW_MIN_LAUNCHER_VERSION`：manifest 的 `minLauncherVersion` = **最老的那个还能装这份更新的启动器**（第 5 步）。**手工路径**由发布 shell 显式 export（本手册第 5 步就是这一行）；若将来走 `release.yml` 自动路径，才需要仓库变量 `vars.PARTNERW_MIN_LAUNCHER_VERSION` —— 那是另一条路的前提，不是本手册的。
  - 两者**都没有默认值**：缺失即硬失败，绝不静默签出一份装不上的包。门槛比"本次要发的启动器"还新也会硬失败。
- 发布服务必须支持“先传不可变版本目录，最后原子替换频道 manifest”。服务器发布**只允许用第 7、9、10 步的 `scripts/feed-publish.mjs`**（它已经过复核）；工具缺失或未经复核时，**完成第 6 步后停止，不得进入第 7 步**，不得现场拼 `scp` / `ssh` 命令。⚠️ 这里过去写作「停在第 8 步」，**步号是错的**（第 7 步就是上传；停在第 8 步意味着一件没做的事已经做过）。口径与规格 §8.1 一致：**停在第 7 步之前**。

## 11 步发布顺序

### 1. 构建应用目录

仅在已获得“打包候选版”授权后执行：

```powershell
$env:PARTNERW_UPDATE_PUBLIC_KEY_B64 = '<与私钥匹配的 SPKI Base64 公钥>'
pnpm --filter @clawwork/desktop build:win
```

⚠️ **必须 `build:win`（含 nsis 目标），不能只跑 `electron-builder --dir`**（2026-09-25 更正）。
`--dir` 出的 `win-unpacked` **少两件文件**：`resources/app-update.yml`(111 B) 与
`resources/elevate.exe`(107520 B) —— 而 `app-update.yml` 正是**更新检查要读的那份**。
`--dir` 不算"更快的同一种包"，它**是另一种包**（两次构建的 `app.asar` 逐字节相同，差别只在这两件）。
本文件早先那版写的就是 `--dir`，0.0.27 / 0.0.28 实际出货用的是 `build:win`；
差异证据见 `docs/superpowers/plans/2026-09-23-portable-update-gaps.md` 的 §16。

⚠️ **在哪构建**：必须在**短路径检出**（`D:\p4-rel`）里跑 —— 内层 worktree 路径 >260 字符 ⇒
**NSIS 那一步必挂**。该检出还要有 `runtime-out/`（含 `kb-model/bge-small-zh-v1.5/`）与 `our-skills/`，
否则 `beforePack` 的 `require-bundled-runtime` 直接拒（从 worktree 构建时要先 `mklink /J` 过去）。

⚠️ **公钥现在是构建前置**（2026-09-23 起）：`build` 与 `electron-builder` 的
`beforePack` 都会拒绝一个**不含更新公钥**的应用（`packages/desktop/scripts/require-update-public-key.cjs`），
不再像以前那样静默注入空串、打出一个"检查更新永远失败且报成 signature-invalid"的包。
所以这一格必须先把公钥设好 —— 与第 3 步用的是**同一把**（两侧各自内嵌、各自独立验签）。

预期目录是 `packages/desktop/dist/win-unpacked`。不要把安装器、运行数据或旧 `.bat` 混入该目录。
**构建完先自己核一遍产物**（别只看命令退出码）：`resources/` 里那两件文件在不在、
`out/main/index.js` 里有没有那把公钥、`afterPack` 的密钥扫描过没过。

### 2. 运行全部门禁

```powershell
pnpm check
git diff --check
```

任一命令非零即停止。缺 Go 是发布环境不完整，不是可跳过项。

### 3. 用匹配的公钥构建启动器

将私钥文件放在仓库外；这里只需要公钥：

```powershell
$env:PARTNERW_LAUNCHER_VERSION = '<本次严格 SemVer>'
$env:PARTNERW_UPDATE_PUBLIC_KEY_B64 = '<受控发布环境中的 Ed25519 SPKI Base64 公钥>'
pnpm build:portable-launcher
```

确认 `artifacts/Partner-W启动器.exe` 前两字节是 `MZ`。公钥必须和后续签名私钥属于同一密钥对。

⚠️ 这里的 `PARTNERW_LAUNCHER_VERSION` **只是"这把启动器自己的版本"**，它**不再**决定
第 5 步 manifest 的 `minLauncherVersion`（那是另一个变量，见第 5 步的纠正表）。
两侧缺失都是硬失败，没有默认值。

### 4. 组装并审计一次性基础包

仅首次迁移到外置启动器、或基础包布局变化时执行：

```powershell
pnpm udisk:assemble -- --app-dir packages/desktop/dist/win-unpacked --launcher artifacts/Partner-W启动器.exe --out '<新的空目录>'
pnpm check:udisk-delivery
```

基础包只能包含盘根启动器、`Partner-W/` 程序目录和 `使用说明.txt`。不得包含 `.bat`、安装器、`Partner-W-运行数据`、`Partner-W工作区` 或 `.Partner-W更新`。

### 5. 在新的空目录生成签名更新

```powershell
$env:PARTNERW_UPDATE_SIGNING_KEY_FILE = '<仓库外的 Ed25519 PKCS#8 PEM>'
$env:PARTNERW_UPDATE_PUBLIC_KEY_B64 = '<与私钥匹配的 SPKI Base64 公钥>'
$env:PARTNERW_MIN_LAUNCHER_VERSION = '<最老的那个还能装这份更新的启动器版本>'
pnpm update:portable-package -- --program-dir packages/desktop/dist/win-unpacked --version '<版本>' --channel internal --base-url 'https://api.rongyinghudong.com/updates' --out '<新的空目录>'
```

⚠️ **这一格以前写的是 `PARTNERW_LAUNCHER_VERSION`，那是错的**（2026-09-23 纠正）。同一个
变量名当时承载两个不同的量：第 3 步的"**本次构建的启动器自己的版本**"与本步骤的
"**manifest 的 `minLauncherVersion`**"。后果很具体：`PARTNERW_LAUNCHER_VERSION` 在
release.yml 里是 `${RELEASE_TAG#v}`，于是 0.0.28 那次会把门槛写成 `0.0.28`，
而**盘上那把启动器永远是上一版** —— 便携更新**从不更换启动器**
（`Partner-W启动器.exe` 在 `portable-update-release.mjs` 的 `FORBIDDEN_NAMES` 里，
只由人工基础包更换）⇒ `0.0.27` 的盘自动升级到 `0.0.28` 会被
`launcher-incompatible` 直接挡死。

怎么定这个值：

|                                           | 含义                                                                                                       | 取什么                                                                |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `PARTNERW_LAUNCHER_VERSION`（第 3 步）    | 我们现在**构建的这把启动器**自己的版本（ldflags `-X main.version`），也是客户端 `--version` 探测到的那个值 | 本次 tag（`v0.0.28` → `0.0.28`）                                      |
| `PARTNERW_MIN_LAUNCHER_VERSION`（本步骤） | 这份更新**最低要求**的启动器版本 —— 比它旧的盘装不了                                                       | **当前基础包里那把启动器的版本**（例：基础包是 0.0.27 ⇒ 填 `0.0.27`） |

验收目标就是这条链：**0.0.27 的人工基础包换一次盘之后，能自动升到 0.0.28**
（含 U 盘便携态）。填成"本次发布版本"会让这条链断在第一步。

⚠️ **2026-09-25 起多一条**：真机验收发现**启动器换目录时抢不过客户端自己的退出**
（程序目录被占用 ⇒ `Access is denied`，而它一次都不重试）—— 这类缺陷**只能靠新启动器修**，
便携更新**永远不换启动器**。所以从修复那一版起：

- 第 3 步的 `PARTNERW_LAUNCHER_VERSION`（启动器自己的版本）升到 **`0.0.28`**；
- 本步骤的 `PARTNERW_MIN_LAUNCHER_VERSION` 必须跟着写 **`0.0.28`**，
  **不得再写 `0.0.27`**。还停在 `0.0.27` 的盘本来就升不动（那版的下载器/解压器/清单写入
  三处都是坏的），它们的出路是**换一份新基础包**；门槛写 `0.0.27` 只会让它们
  白下 400 MB、然后在换目录那一步失败。
- 节奏：**人工基础包 = `0.0.31`**（客户端三修 + 新启动器一起换上去），
  **第一轮远程升级验收 = `0.0.32`**。

两个变量**都没有默认值**：缺了或填错方向（门槛比本次要发的启动器还新）都会**硬失败**，
不会静默签出一份装不上的包（`scripts/make-portable-update.mjs`）。

输出必须正好有 `portable.zip`、`portable-files.json`、`manifest.json`。工具拒绝覆盖现有输出。

### 6. 独立核验签名、哈希和双实现兼容性

```powershell
pnpm check:portable-update-release
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-release-integration.test.ts
go -C launcher test ./... -count=1
Get-FileHash '<输出目录>\portable.zip' -Algorithm SHA256
```

把 SHA-256、文件大小、版本、频道、提交号和操作者写入发布记录。Node 生成器、Electron 解压验树和 Go 启动器必须都至少报告一个通过用例。

### 7. 发布到测试频道

此步需要单独的「测试更新源发布」授权。用经过复核的上传器执行，**不要现场拼 `scp` 命令**：

```powershell
$env:PARTNERW_UPDATE_PUBLIC_KEY_B64 = '<与私钥匹配的 SPKI Base64 公钥>'
$env:PARTNERW_FEED_OPERATOR = '<本执行人>'
node scripts/feed-publish.mjs --dry-run --channel internal --version <版本> --package <portable.zip> --file-manifest <portable-files.json> --manifest <manifest.json>
node scripts/feed-publish.mjs --preflight --channel internal --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --audit-out <仓库外的审计日志路径>
node scripts/feed-publish.mjs --commit --channel internal --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --package <portable.zip> --file-manifest <portable-files.json> --manifest <manifest.json> --audit-out <仓库外的审计日志路径>
```

退出码：`0` 完成；`1` 失败、拒绝、**被别人占着锁**或事故；`2` 没给模式旗标（工具只打印用法）；`3` 可重跑（翻转未生效 —— **只有这个码**代表 `--commit` 可以安全重跑，其它非零码都可能已经改动过远端状态）。

**读结果先看 `outcome`，不要只看退出码**：`1` **同时**代表 `fail` / `blocked` / `incident` 三种结论，而它们的下一步动作相反。

| `outcome`（命令打印的 JSON 里那个字段） | 意思                                                                                                                      | 下一步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `done`                                  | 十三步走完、公网复验通过、锁已释放                                                                                        | 退出码 `0`，继续第 8 步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `retry`                                 | 翻转没生效（公网还是旧 manifest），远端状态**确定**；⚠️ **锁按设计留在这台运行名下**（`lockState: retained-by-this-run`） | 退出码 `3`，**只有它可以安全重跑** `--commit` —— 但**直接重跑会先撞上自己留下的锁**（取锁的 `mkdir` 遇 EEXIST ⇒ `not-acquired` ⇒ 收口 `blocked`、退 `1`）⇒ **先按 7b 释放它**：`--confirm-runid` 填**本次打印的 `runid`**（本条已经退出 `3`，所以它可证不在进行中），释放成功再重跑 `--commit`                                                                                                                                                                                                                                                                              |
| `fail`                                  | 翻转**之前**失败，远端状态确定                                                                                            | 退出码 `1`，读审计日志看停在哪一阶段，修掉成因再重跑                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `blocked`                               | 这个频道**已经有锁**，本次**没拿到锁**（`lockState: not-acquired`）                                                       | 退出码 `1`，**先别拆锁**：持锁的很可能就是**你自己上一次的 `retry`**（它按设计留着锁退出 `3`）⇒ 先用 7b **探**一次，`--confirm-runid` 填**你上次那条命令打印的 `runid`**：**对得上** ⇒ 那是你自己的锁，命令当场报 `lock-broken`，再重跑；**对不上** ⇒ 工具**当场拒绝并打印真正的 owner runid**，且**拒绝发生在任何写之前**（只读一次远端记录、不写审计行）⇒ 拿那个 runid 去认人，确认对方**确实已经不在进行中**，才走 7b                                                                                                                                                    |
| `incident`                              | 结果**不确定**（翻转后失败、上传后核对不上、CAS 不匹配…），**锁被有意保留**                                               | 退出码 `1`，停下来人工核查，再按 7b 恢复 —— **先读命令打印的 `lockState`，再决定「这锁是不是本次留下的」**（别凭印象）：`retained-by-this-run` ⇒ 本次确实取到过锁并有意保留它，走 7b 第一条命令、`--confirm-runid` 填**本次打印的 `runid`**（与 `retry` 同一条路）；`ownership-unknown` ⇒ 本次**无法确认**自己是否拥有那把锁（取锁的回执丢了，或记录里的 `runid`/`planHash` 不是本次的）⇒ **不得声称保留**，先按下面的办法查清 owner 再说。**再分清 owner 记录读不读得出来**：**读得出来** ⇒ 走 7b 第一条命令；**读不出来** ⇒ 才走 `--owner-record-unreadable` 那条专用路径 |

⚠️ **`blocked` 与完整性事故 `incident` 都退 `1`，但锁的来源相反**：`incident` 的锁是**本次运行有意保留**的（见上表 `incident` 行）；`blocked` 的锁**本次根本没拿到**。**「那把锁不是你的」不该是一句断言** —— 工具**当场给判据**：拿**你上次那条命令打印的 `runid`** 按 7b 探一次（`--confirm-runid`）。**对得上** ⇒ 那锁是你自己的（例如上一次 `retry` 按设计留下的），释放它安全；**对不上** ⇒ 工具**立即拒绝**并**打印真正的 owner runid**（`--confirm-runid does not match the owner runid <那串 runid>`），**这条拒绝发生在任何写之前**（只读一次远端 `owner.json`，**一条审计行都不写**）⇒ 但**只有确认那次运行确实已经不在进行中之后**才允许走 7b 的恢复路径 —— 否则你会在它写到一半时把它脚下的东西拆掉。

**结论在哪：** 命令打印的 JSON 的 `outcome` 字段，以及审计日志里**收口那一行的 `stage`**（同一个词，例如 `{"stage":"blocked","reason":"the channel is already locked"}`）。**别拿审计日志最后一行当结论**：最后一行是 `unlock`（`status` 为 `done` 或 `retained`）或 `lock-retained`，它只说**锁**怎么了；各阶段行上的 `status` 只说**那一步**的结果。

**凡是给了 `--audit-out` 的模式（`--preflight` / `--commit` / `--break-lock`），任何非 `0` 都要先读审计日志**；`--dry-run` 与 `--re-sign-stable` **不写审计行**（`--dry-run` 连 `--audit-out` 都不接），它们的失败原因只看 stderr。

上传器固定执行十三步，**不得调换**：本地预验证 → stage（确保受控目录 + 探测目标后选 put/reput 上传 + 远端改名）→ 远端复核 → 取频道锁 → 锁内重新核验 → 原子提交版本目录（**单次目录 rename**）→ 备份旧 manifest → CAS → **SFTP 上传临时 manifest 并核对远端摘要** → 原子翻转 → 公网复验 → 逐阶段审计 → 释放锁。

⚠️ **这十三步是流程，不是审计日志里的全部阶段名。** 审计日志另有两个条目：会话级的 `open`（整轮开始）与 **`reveal`**。`reveal` 的口径写死为「**这一轮把版本真正放出去了**」（翻转生效 **且** 公网复验通过），**不是**「这一轮收口」—— 收口是紧随其后的那条 `done` / `fail` / `incident` / `retry` / `blocked` 条目，它的 `stage` 就是结论本身。所以失败路径上 `reveal` 停在 `pending` 是**正确**的（那一轮确实没把版本放出去）。⚠️ 结论只有 **3 个**（§6.11 的 `done` / `fail` / `incident`），而工具会写 **5 个**：`retry`（翻转没生效、可重跑）与 `blocked`（频道已有锁、本次没取到锁）是本工具**多出来**的两个收口词，不是 §6.11 的原文 —— 读日志时按上表那五行读，别只认那三个。

- 本地预验证**先于任何网络写**；任一项不过就一个字节都不写。
- `--dry-run` 完全离线，**不需要** `--host` / `--known-hosts`，只校验三个本地产物。它把**这一次发布将要写入的本地产物摘要与目标路径**都打出来：`local`（三个产物的 SHA-256 与大小、`packageUrl`）、`targets`（版本目录、staging 目录、两个 `.part` 上传目标、频道 manifest、临时 manifest 路径）、`planHash`（`channel + version + 三产物哈希`），以及十三步计划。**唯一的例外是备份路径**：它的文件名带着**服务器上现存 manifest 的摘要**，那是联网才读得到的事实，所以 `--dry-run` 打不出来（命令会打印一行说明）。
- `--preflight` 只读，只能给出**可写性指标**；真正的写入能力到 stage 阶段才被证明。⚠️ 它**仍然会写一条会话级审计行**，所以**必须给 `--audit-out`**（缺了会以 `--audit-out is required` 退出 1）。
- ⚠️ **`--preflight` 核什么**（2026-09-24 扩面，工具实测）：① `stat -c '%d'` 比较**状态根与发布根的设备号**（§6.8 的「同一文件系统」前提）；② 探测本身是否成功（失败则 `notes` 非空、退出 `1`）；③ **新增**：逐个报出**状态根、发布根、频道根**的 `kind` / 属主 / 组 / 权限位 / 设备号（频道根缺席是首次发布的正常态，不算 note；两个根不是目录会落进 `notes`）。它**仍然只读**：一次设备号探测 + 每个根一次探测，**绝不触写**（有测试按名钉住）。**仍未实现、仍要操作员自己核**：host key 是否匹配、有效账号、磁盘余量、锁是否空闲、目标版本目录是否已存在及其字节状态（见「发布前检查单」）。真正的写入能力仍然要到 stage 阶段才被证明。
- **首次发布需要的目录：工具自建，不再要操作员手工准备**（2026-09-24）。stage 步骤会逐个**探测并确保**它拥有的受控目录：`<state-root>/lock`、`<state-root>/staging`、`<update-root>/<频道>`。规则与上传目标同源：远端必须**正面回答** `absent` / `directory <属主> <组> <权限> <设备>` / `file` / `symlink` / `other`；**缺席就 `mkdir -p` 建好再复核**，而 `file`、`symlink`、`other`、探测失败、或"建完复核不过"一律**拒绝**并在审计里给出**可直接执行的 `install -d` 提示**。频道根还会**查内容**：只允许 `manifest.json`、`manifest.json.<runid>.tmp` 与 `<semver>` 版本目录，出现别的条目就**按名拒绝**（2026-09-24 那次清理就是因为同级目录里被人放了无关文件）。`<state-root>/backup` 同样由工具确保。
  ⇒ **运维只需预置两个根**：`/opt/partner-w/updates` 与 `/opt/partner-w/updates-state`（`root:root 755`、**同一文件系统**，设备号要能被 preflight 比出来）。两个根之下的东西都是工具的。
- **staging 目录**在状态根下、公网读不到：`/opt/partner-w/updates-state/staging/<频道>/<版本>/<planHash>/`（`planHash` = `channel + version + 三产物哈希`，所以只有**同一版本 + 同样字节**才落在同一个目录里）。发布中途断掉后**直接重跑 `--commit` 就可以**：上传目标按**产物**命名（`portable.zip.part`、`portable-files.json.part`）；上一次运行留下的**带 runid 后缀**的半截文件由 stage 步骤自动清掉、并在审计的 `stage` 条目里点名（`removedStrayParts`），**清不掉就当场 `fail` 停住、一个字节都不上传**。版本目录**不可变**：它只可能有 `portable.zip` 与 `portable-files.json` 两个文件，多一个、少一个、大小或摘要不对都拒。
- ⚠️ **上传前会先探测目标再选命令**（2026-09-24，修掉一个首次发布必挂的缺陷）：远端 `.part` **不存在 → `put`**（整传）；**存在且短于本地 → `reput`**（断点续传）；**与本地等长 → `put`**（sftp 拒绝对等长目标续传）；**长于本地 / 不是普通文件 / 探测失败 / 答案不在词表内 → 拒绝**。所选的命令、探测结论与探测到的字节数都写进审计的 `stage` 行。
  ⛔ **不得再用"手工创建 0 字节 `.part`"当发布前置条件**：那是 2026-09-24 事故当时的临时绕法，现在**不需要、也不支持**——工具自己会探测并选择。谁再手工播种，都会被当成"已存在的部分文件"而改变续传起点。
  ⚠️ **仍未在真机验过的**：一次**真正的中断后续传**（`reput` 从半截文件继续）。`put` 与"缺席即整传"已在真机走过；`reput` 的续传语义只有单测。
- `--host` 不许以 `-` 开头、不许含空白；**`--known-hosts` 的路径可以含空格** —— 路径安全规则**故意比主机规则窄**（主机名进 argv 前要防选项注入，路径是整体参数，工具按参数传递、不拼 shell）。**不要**为了“看起来安全”去改建带有空格的 known_hosts 路径。
- 版本目录**不可变**；已存在且逐字节一致才可复用，**存在但为空视为不完整并拒绝**。
- **CAS 不匹配是完整性事故**：收口为 `incident` 并**保留锁**，不自动翻转、不自动回滚、不自动删除，人工核查后走显式恢复。

### 7b. 卡住时怎么恢复

锁是**目录 + `owner.json`**，不是裸目录。恢复必须先读 owner，再显式确认：

```powershell
$env:PARTNERW_FEED_OPERATOR = '<本执行人>'
node scripts/feed-publish.mjs --break-lock --channel <频道> --host <主机> --known-hosts <路径> --reason "<为什么可以安全破除>" --confirm-runid <审计日志里那条 owner 的 runid> --audit-out <审计日志路径>
```

`--break-lock` **不需要** `--version`：锁路径是 `/opt/partner-w/updates-state/lock/<频道>`，与版本无关（工具也不会回显版本）。`--confirm-runid` 必须与远端 owner 的 `runid` **完全一致**，否则立即拒绝；破除结果与真实 `previousOwner`、操作者都会写进审计日志。**删除失败不会记成 `lock-broken`。**

**锁在、但 `owner.json` 读不出来时**（`--confirm-runid` 无从确认 —— 上面那条命令**不适用**）：状态路径是 `/opt/partner-w/updates-state/lock/<频道>`，记录文件是它下面的 `owner.json`。**不要 `rm -rf` 这个目录，也不要 `rm` 掉锁目录本身**（状态目录是 junction 高发区，本仓库有硬规定；裸删会留下无法解释的状态）。用你平时的登录账号与密钥登到发布主机上（**本手册从不要求你手写 `ssh` 命令**），按顺序做**两件事**：

```bash
ls -la /opt/partner-w/updates-state/lock/<频道>
cat /opt/partner-w/updates-state/lock/<频道>/owner.json
```

第二条的输出分四种**读法**，分别意味着不同的事（工具把它们归成**三种状态**，报在 `ownerRecordStatus` 里）：

| `cat` 的读数                | 意思                                                                                                          | 工具报的状态                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `No such file or directory` | 记录没写成或已被删                                                                                            | `missing`                                         |
| 非 JSON 文本                | 写坏了                                                                                                        | `corrupt`                                         |
| **空输出（0 字节）**        | 文件被创建但载荷没写进去 —— 工具**也**报 `corrupt`（`cat` 成功但内容为空 ⇒ 解析失败），**没有**单独的“空”状态 | `corrupt`（`the owner record is not valid JSON`） |
| `Permission denied`         | 取不到                                                                                                        | `transport`                                       |

**空输出这一种值得单独认**，因为成因是写入方式：owner 写入是 `printf … | base64 -d > owner.json`，重定向**先**创建/清空文件，所以 `base64 -d` 失败、中途被杀、或路径上根本没有 `base64` 都会留下一个 0 字节或半截的文件。**四种读法 → 三种状态**：判断“该不该拆锁”只需要这三种，所以工具不为此多设一态；但四种读数**下一步动作不同**（前三种可直接走下面这条专用路径；`Permission denied` 往往要先修权限或换个账号再读一次）。

**确认前一次运行确实不在进行中**之后，才走这条专用路径（仍然必填 `--reason` 与 `--audit-out`，并用这个 flag 本身作为“已确认不在进行中”的声明；**不要求** `--confirm-runid`，因为根本没有可确认的 runid）：

```powershell
$env:PARTNERW_FEED_OPERATOR = '<本执行人>'
node scripts/feed-publish.mjs --break-lock --channel <频道> --owner-record-unreadable --reason "<为什么可以安全破除>" --host <主机> --known-hosts <路径> --audit-out <审计日志路径>
```

审计日志里会记 `stage: break-lock` + `ownerRecordUnreadable: true` + 原因 + 执行人。**「交给人工检查」单独一句不是可接受的终态指令**：没有上面这条路径，操作员面前只剩“自己想办法删掉那个目录”一条路，而那正是本仓库禁止的动作。

### 8. 完成真盘矩阵

严格执行 [U 盘整目录更新真盘验收](./portable-update-real-disk-acceptance.md)。exFAT、NTFS、两台干净 Windows 电脑、登录、付费模型和真实对话都通过前，不得进入正式频道。

### 9. 离线签出 stable 的 manifest（这一步不搬制品）

此步需要单独的「正式更新源发布」授权。`stable` **只能复用** `portable.zip` 与 `portable-files.json` 的**原字节**；**`stable` 的 manifest 必须单独离线签名**（`channel: stable` 与 stable 的 `packageUrl`），禁止改字段复用 internal 的 manifest——签名覆盖 `channel` 与 `packageUrl`。

⚠️ **这一步不复制、不上传任何东西**（本节标题过去写作“复制不可变制品到正式位置”，会让人去找一条并不存在的命令）：制品由**第 10 步的 `--commit`** 放上去，用的还是 internal 那两个文件的**原字节**。这里只做一件事：**离线**签出 stable 的 manifest。

stable 的 manifest 用上传器的离线模式**当场签**（**不联网**，只用本地产物与仓库外的私钥）：

```powershell
$env:PARTNERW_UPDATE_PUBLIC_KEY_B64 = '<与私钥匹配的 SPKI Base64 公钥>'
$env:PARTNERW_UPDATE_SIGNING_KEY_FILE = '<仓库外的 Ed25519 PKCS#8 PEM>'
node scripts/feed-publish.mjs --re-sign-stable --channel stable --version <版本> --package <portable.zip> --file-manifest <portable-files.json> --manifest <internal 的 manifest.json> --stable-out <仓库外的 stable manifest 路径>
```

- `--stable-out` 必须在**仓库外**，且**拒绝覆盖**已有文件；要重签必须先手工删掉旧的那一份。
- ⚠️ **`--stable-out` 的写入不是原子的**：`wx` 只保证不覆盖 —— 进程写一半被杀会留下**半截文件，而且永久不可覆盖**，恢复 = **手工删掉再重签**。路径由操作员显式给出且在仓库外，所以这个删除不可逆但**可见**；改成“临时名 + rename”会**去掉覆盖拒绝这道守卫本身**，不划算 ⇒ **接受**。
- 这个模式**不写审计行**（它既不是十三步之一、也不是已登记的会话级条目）⇒ **必须在发布记录里手工写下**：产物路径，以及命令打印的三个摘要 `stableManifestSha256` / `reusedFileManifestSha256` / `reusedPackageSha256`。

### 10. 最后更新正式签名 manifest

用同一上传器 `--channel stable` 执行同样的十三步：

```powershell
$env:PARTNERW_UPDATE_PUBLIC_KEY_B64 = '<与私钥匹配的 SPKI Base64 公钥>'
$env:PARTNERW_FEED_OPERATOR = '<本执行人>'
node scripts/feed-publish.mjs --preflight --channel stable --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --audit-out <仓库外的审计日志路径>
node scripts/feed-publish.mjs --commit --channel stable --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --package <portable.zip> --file-manifest <portable-files.json> --manifest <第 9 步签出来的 stable manifest> --audit-out <仓库外的审计日志路径>
```

`--package` / `--file-manifest` 给的是**原字节**（internal 的那两个：不许重新打包、不许重新签名、不许改 ZIP 时间戳），`--manifest` 给的是**第 9 步签出来的那一份**。翻转后必须完成公网复验：重新取回 manifest **原始字节**、验签、比对 `channel` / `version` / `packageUrl`（**完整 origin**）以及两个产物的 SHA-256 与大小。

### 11. 保留服务端紧急回滚材料

保留上一版 `manifest.json`、`portable-files.json` 和 `portable.zip`。紧急回滚只把频道 manifest 指回上一套不可变制品；客户端已成功升级后不做静默降级。需要客户端降级时必须另开事故流程。

上传器**自己也会**把翻转前的频道 manifest 抄一份到状态根下：`/opt/partner-w/updates-state/backup/<频道>-manifest.json-pre-<版本>-<旧 manifest 的 SHA-256>`（**名字里带摘要** ⇒ 同一版本重跑**不会覆盖**上一次的备份；文件内容由 stage 之后的 `sha256sum` 核对过，核对不过当场记 `incident` 并保留锁，不会带着一份不可信的回滚材料继续翻）。⚠️ 频道**首次**发布时服务器上本来没有 manifest，工具**不复制**任何东西、只在审计里记 `previousManifestSha256: "absent"` —— 这是记录，不是遗漏。

## nginx 与权限

- 新 manifest 位于 `/updates/<channel>/manifest.json`，**不继承** `= /updates/latest.yml` 的 `no-cache`。客户端是 Electron 主进程的全局 `fetch`（undici，无隐式 HTTP 缓存），当前风险低。**建议**追加 `location ~ ^/updates/(internal|stable)/manifest\.json$ { add_header Cache-Control "no-cache" always; }`。
- 生产**应当使用受限发布账号**：对版本目录可写、manifest 单独一步可换、不能改动其他内容。
- **当前是显式例外**：`/opt/partner-w/updates` 与 `/opt/partner-w/backups` 均为 `root:root 755`，首次发布将**临时使用 root**。残留风险：root 一旦被脚本缺陷或误用影响，可改动服务器上任意文件；审计**只能事后发现**。建立受限账号属后续加固。

## 公网复验的时间预算（2026-09-24 新增）

`public-verify` 要**把制品从公网完整取回来**（不只看状态码）。它曾经把"请求头 + 下载体"压在**同一个 60 秒常量**里 —— 400 MB 的包在这条线路上（实测 0.47–2.3 MB/s）必然超时，于是**翻转已经成功、运行却以 `incident` 收尾并保留锁**。现在拆成两个预算：

- **请求头**：`PUBLIC_HEADER_TIMEOUT_MS = 60 s`（常量，小文件仍然快速失败）。
- **下载体**：`publicBodyTimeoutMs(size) = min(30 min, max(30 s, size / 256 KiB/s + 30 s))` —— 按**制品大小 ÷ 保守最低速率 + 缓冲**算，且有下限与**上限**（不允许无限等待）。
- 读数举例：529 B → 30 s · 29 KB → 30 s · **398 MB → 约 25.4 min**（实测那条线约 3–14 min，余量充足）。
- 下载**边算 sha256**，**只有整段 body 到齐且摘要相符**才允许声明成功。三种失败各有独立原因：`Content-Length` 与本版本不符 / body 短于声明 / 摘要不符。

## 已经翻转、但公网复验失败时怎么办（`incident` 的恢复口径）

判别与恢复顺序固定：

1. **先读命令打印的 `lockState`**，再决定"这锁是不是本次留下的"。
2. ⛔ **不要重跑 `--commit`**：它不会解决"公网取不回来"的成因，还会重新上传、再次翻转。
3. **人工核公网三件**（这才是真正缺的那步复验）：`manifest.json` 的**原始字节**（并验签）、`portable-files.json`、`portable.zip` 的**大小与 SHA-256**。⚠️ 400 MB 的包请用**分段取样**（头/中/尾各取 1 MiB 与本地逐段比对）或完整下载后比对，**不要用 HEAD 的 Content-Length 代替**。
4. 三件都对 ⇒ 按 **7b** 用**本次打印的 `runid`** 破除这把锁（2026-09-24 那次真实事故就是这么收口的）。
5. 任一对不上、或状态不确定 ⇒ **不破锁、不覆盖任何公网文件、不重跑 `commit`**，保存取证并停下汇报。

## 发布前检查单

- [ ] `docs/portable-update-key-registry.md` 的 host-key 指纹已由用户或授权运维人员经**可信带外渠道**核对，并写明核对方式。（本项依赖《2026-09-22-portable-release-assembly-and-ci》Task 6 落地的密钥登记册；未落地前记「未验证」）
- [ ] 上传器使用**仓库外** known_hosts，`BatchMode=yes` 与 `StrictHostKeyChecking=yes` 生效。
- [ ] **preflight 仍未实现**的项已由操作员**手工核过**：host key 指纹与仓库外 known_hosts 一致、当前账号有效、两个根所在挂载点磁盘余量足够、频道锁空闲、目标版本目录是否已存在及其字节状态。（两个根的**存在性 / 属主 / 权限 / 设备号**现在由 preflight 报出；`<update-root>/<频道>`、`<state-root>/{lock,staging,backup}` 由**工具自建**，不再是操作员的前置动作。）
- [ ] 三个产物的本地 SHA-256 与大小已记录，且与待发 manifest 逐项一致。
- [ ] 启动器身份挑战（第 6b 步）三条全部通过，读数已归档为**发布期 QC 证据**。（本项依赖《2026-09-22-portable-release-assembly-and-ci》Task 6 落地的第 6b 步；未落地前记「未验证」）
- [ ] `--audit-out` 指向**仓库外**；审计日志含 `open` … `unlock` 的**逐阶段**记录。
- [ ] 审计行里的 `operator` 是本执行人，不是 `unknown`（会写审计行的模式都设了 `PARTNERW_FEED_OPERATOR`，见「发布前提」）。
- [ ] 已保留上一版 `manifest.json`、`portable-files.json` 与 `portable.zip` 作为回滚材料。
- [ ] 已确认「回滚只能拦住还没升级的客户端」——已升级的客户端**不会**降级，真降级必须另开事故流程。

## 立即停止条件

- 公私钥不匹配、签名或任一哈希不一致。
- 输出目录非空、包中出现链接/重解析点、Windows 保留名或受保护数据目录。
- 生成过程打印私钥、token 或完整凭据。
- 测试频道 manifest 指向尚未上传或尚未核验的 ZIP。
- 真盘验收有一项未执行、失败或只有推断没有证据。
