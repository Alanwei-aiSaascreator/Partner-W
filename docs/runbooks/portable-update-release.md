# U 盘整目录更新发布手册

## 适用范围

本手册只适用于带盘根 `荣盈魔方启动器.exe` 的新基础包。现存 0.0.25 及更早包没有外置启动器，不能靠本机制原地升级；必须先人工换成一次新的基础包。

代码合并、客户包打包、测试源发布、正式源发布是四个独立授权点。没有当次明确授权时，只能运行测试和临时目录夹具，不得创建客户候选包，不得改测试或正式更新源。

## 发布前提

- 工作树干净，发布 tag 与 `packages/desktop/package.json` 版本一致。
- Go 版本由 `launcher/go.mod` 固定；`go`、Node.js 20、pnpm 10 都在 PATH。
- GitHub 环境 `portable-update-production` 已启用审批保护。
- 受保护环境中同时存在：
  - `MOFANG_UPDATE_PUBLIC_KEY_B64`
  - `MOFANG_UPDATE_SIGNING_KEY_PEM`
  - `MOFANG_UPDATE_FEED_UPLOAD_TOKEN`
- 上传器在**发布 shell** 里要两个环境变量，**每开一个新 shell 都要重设**（第 3/5 步设过的不会自己跟到第 7/9/10 步）：
  - `MOFANG_FEED_OPERATOR='<本执行人>'`：**凡是会写审计行的模式都必须设** —— `--preflight` / `--commit` / `--break-lock`（两条恢复路径都算）。不设时工具按 `unknown` 落账，"谁在什么时候破了这把锁"就没有答案。
  - `MOFANG_UPDATE_PUBLIC_KEY_B64='<与私钥匹配的 SPKI Base64 公钥>'`：**除 `--preflight` 与 `--break-lock` 之外的每一种模式都要**（`--dry-run` / `--commit` / `--re-sign-stable`，见第 3/5/9 步）；`--re-sign-stable` 还要 `MOFANG_UPDATE_SIGNING_KEY_FILE`。
- 私钥只允许写入系统临时目录，不得进入仓库、日志、客户包或长期制品。
- 发布服务必须支持“先传不可变版本目录，最后原子替换频道 manifest”。服务器发布**只允许用第 7、9、10 步的 `scripts/feed-publish.mjs`**（它已经过复核）；工具缺失或未经复核时，停在第 8 步，不得现场拼 `scp` / `ssh` 命令。

## 11 步发布顺序

### 1. 构建应用目录

仅在已获得“打包候选版”授权后执行：

```powershell
pnpm --filter @clawwork/desktop build
pnpm --filter @clawwork/desktop exec electron-builder --win --x64 --dir --publish never
```

预期目录是 `packages/desktop/dist/win-unpacked`。不要把安装器、运行数据或旧 `.bat` 混入该目录。

### 2. 运行全部门禁

```powershell
pnpm check
git diff --check
```

任一命令非零即停止。缺 Go 是发布环境不完整，不是可跳过项。

### 3. 用匹配的公钥构建启动器

将私钥文件放在仓库外；这里只需要公钥：

```powershell
$env:MOFANG_LAUNCHER_VERSION = '<本次严格 SemVer>'
$env:MOFANG_UPDATE_PUBLIC_KEY_B64 = '<受控发布环境中的 Ed25519 SPKI Base64 公钥>'
pnpm build:portable-launcher
```

确认 `artifacts/荣盈魔方启动器.exe` 前两字节是 `MZ`。公钥必须和后续签名私钥属于同一密钥对。

### 4. 组装并审计一次性基础包

仅首次迁移到外置启动器、或基础包布局变化时执行：

```powershell
pnpm udisk:assemble -- --app-dir packages/desktop/dist/win-unpacked --launcher artifacts/荣盈魔方启动器.exe --out '<新的空目录>'
pnpm check:udisk-delivery
```

基础包只能包含盘根启动器、`荣盈魔方/` 程序目录和 `使用说明.txt`。不得包含 `.bat`、安装器、`荣盈魔方-运行数据`、`荣盈魔方工作区` 或 `.荣盈魔方更新`。

### 5. 在新的空目录生成签名更新

```powershell
$env:MOFANG_UPDATE_SIGNING_KEY_FILE = '<仓库外的 Ed25519 PKCS#8 PEM>'
$env:MOFANG_UPDATE_PUBLIC_KEY_B64 = '<与私钥匹配的 SPKI Base64 公钥>'
$env:MOFANG_LAUNCHER_VERSION = '<最低可接收此更新的启动器版本>'
pnpm update:portable-package -- --program-dir packages/desktop/dist/win-unpacked --version '<版本>' --channel internal --base-url 'https://api.rongyinghudong.com/updates' --out '<新的空目录>'
```

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
$env:MOFANG_UPDATE_PUBLIC_KEY_B64 = '<与私钥匹配的 SPKI Base64 公钥>'
$env:MOFANG_FEED_OPERATOR = '<本执行人>'
node scripts/feed-publish.mjs --dry-run --channel internal --version <版本> --package <portable.zip> --file-manifest <portable-files.json> --manifest <manifest.json>
node scripts/feed-publish.mjs --preflight --channel internal --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --audit-out <仓库外的审计日志路径>
node scripts/feed-publish.mjs --commit --channel internal --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --package <portable.zip> --file-manifest <portable-files.json> --manifest <manifest.json> --audit-out <仓库外的审计日志路径>
```

退出码：`0` 完成；`1` 失败、拒绝、**被别人占着锁**或事故；`2` 没给模式旗标（工具只打印用法）；`3` 可重跑（翻转未生效 —— **只有这个码**代表 `--commit` 可以安全重跑，其它非零码都可能已经改动过远端状态）。

**读结果先看 `outcome`，不要只看退出码**：`1` **同时**代表 `fail` / `blocked` / `incident` 三种结论，而它们的下一步动作相反。

| `outcome`（命令打印的 JSON 里那个字段） | 意思                                                                                                                      | 下一步                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `done`                                  | 十三步走完、公网复验通过、锁已释放                                                                                        | 退出码 `0`，继续第 8 步                                                                                                                                                                                                                                                                                                                                                                                                  |
| `retry`                                 | 翻转没生效（公网还是旧 manifest），远端状态**确定**；⚠️ **锁按设计留在这台运行名下**（`lockState: retained-by-this-run`） | 退出码 `3`，**只有它可以安全重跑** `--commit` —— 但**直接重跑会先撞上自己留下的锁**（取锁的 `mkdir` 遇 EEXIST ⇒ `not-acquired` ⇒ 收口 `blocked`、退 `1`）⇒ **先按 7b 释放它**：`--confirm-runid` 填**本次打印的 `runid`**（本条已经退出 `3`，所以它可证不在进行中），释放成功再重跑 `--commit`                                                                                                                           |
| `fail`                                  | 翻转**之前**失败，远端状态确定                                                                                            | 退出码 `1`，读审计日志看停在哪一阶段，修掉成因再重跑                                                                                                                                                                                                                                                                                                                                                                     |
| `blocked`                               | 这个频道**已经有锁**，本次**没拿到锁**（`lockState: not-acquired`）                                                       | 退出码 `1`，**先别拆锁**：持锁的很可能就是**你自己上一次的 `retry`**（它按设计留着锁退出 `3`）⇒ 先用 7b **探**一次，`--confirm-runid` 填**你上次那条命令打印的 `runid`**：**对得上** ⇒ 那是你自己的锁，命令当场报 `lock-broken`，再重跑；**对不上** ⇒ 工具**当场拒绝并打印真正的 owner runid**，且**拒绝发生在任何写之前**（只读一次远端记录、不写审计行）⇒ 拿那个 runid 去认人，确认对方**确实已经不在进行中**，才走 7b |
| `incident`                              | 结果**不确定**（翻转后失败、上传后核对不上、CAS 不匹配…），**锁被有意保留**                                               | 退出码 `1`，停下来人工核查，再按 7b 恢复 —— **先分清哪条**：owner 记录**读得出来** ⇒ 走 7b 第一条命令，`--confirm-runid` 填**本次打印的 `runid`**（与 `retry` 同一条路）；**读不出来** ⇒ 才走 `--owner-record-unreadable` 那条专用路径                                                                                                                                                                                   |

⚠️ **`blocked` 与完整性事故 `incident` 都退 `1`，但锁的来源相反**：`incident` 的锁是**本次运行有意保留**的（见上表 `incident` 行）；`blocked` 的锁**本次根本没拿到**。**「那把锁不是你的」不该是一句断言** —— 工具**当场给判据**：拿**你上次那条命令打印的 `runid`** 按 7b 探一次（`--confirm-runid`）。**对得上** ⇒ 那锁是你自己的（例如上一次 `retry` 按设计留下的），释放它安全；**对不上** ⇒ 工具**立即拒绝**并**打印真正的 owner runid**（`--confirm-runid does not match the owner runid <那串 runid>`），**这条拒绝发生在任何写之前**（只读一次远端 `owner.json`，**一条审计行都不写**）⇒ 但**只有确认那次运行确实已经不在进行中之后**才允许走 7b 的恢复路径 —— 否则你会在它写到一半时把它脚下的东西拆掉。

**结论在哪：** 命令打印的 JSON 的 `outcome` 字段，以及审计日志里**收口那一行的 `stage`**（同一个词，例如 `{"stage":"blocked","reason":"the channel is already locked"}`）。**别拿审计日志最后一行当结论**：最后一行是 `unlock`（`status` 为 `done` 或 `retained`）或 `lock-retained`，它只说**锁**怎么了；各阶段行上的 `status` 只说**那一步**的结果。

**凡是给了 `--audit-out` 的模式（`--preflight` / `--commit` / `--break-lock`），任何非 `0` 都要先读审计日志**；`--dry-run` 与 `--re-sign-stable` **不写审计行**（`--dry-run` 连 `--audit-out` 都不接），它们的失败原因只看 stderr。

上传器固定执行十三步，**不得调换**：本地预验证 → stage（建 staging 目录 + 续传上传 + 远端改名）→ 远端复核 → 取频道锁 → 锁内重新核验 → 原子提交版本目录（**单次目录 rename**）→ 备份旧 manifest → CAS → **SFTP 上传临时 manifest 并核对远端摘要** → 原子翻转 → 公网复验 → 逐阶段审计 → 释放锁。

- 本地预验证**先于任何网络写**；任一项不过就一个字节都不写。
- `--dry-run` 完全离线，**不需要** `--host` / `--known-hosts`，只校验三个本地产物。
- `--preflight` 只读，只能给出**可写性指标**；真正的写入能力到 stage 阶段才被证明。⚠️ 它**仍然会写一条会话级审计行**，所以**必须给 `--audit-out`**（缺了会以 `--audit-out is required` 退出 1）。
- `--host` 不许以 `-` 开头、不许含空白；**`--known-hosts` 的路径可以含空格** —— 路径安全规则**故意比主机规则窄**（主机名进 argv 前要防选项注入，路径是整体参数，工具按参数传递、不拼 shell）。**不要**为了“看起来安全”去改建带有空格的 known_hosts 路径。
- 版本目录**不可变**；已存在且逐字节一致才可复用，**存在但为空视为不完整并拒绝**。
- **CAS 不匹配是完整性事故**：收口为 `incident` 并**保留锁**，不自动翻转、不自动回滚、不自动删除，人工核查后走显式恢复。

### 7b. 卡住时怎么恢复

锁是**目录 + `owner.json`**，不是裸目录。恢复必须先读 owner，再显式确认：

```powershell
$env:MOFANG_FEED_OPERATOR = '<本执行人>'
node scripts/feed-publish.mjs --break-lock --channel <频道> --host <主机> --known-hosts <路径> --reason "<为什么可以安全破除>" --confirm-runid <审计日志里那条 owner 的 runid> --audit-out <审计日志路径>
```

`--break-lock` **不需要** `--version`：锁路径是 `/opt/rongying/updates-state/lock/<频道>`，与版本无关（工具也不会回显版本）。`--confirm-runid` 必须与远端 owner 的 `runid` **完全一致**，否则立即拒绝；破除结果与真实 `previousOwner`、操作者都会写进审计日志。**删除失败不会记成 `lock-broken`。**

**锁在、但 `owner.json` 读不出来时**（`--confirm-runid` 无从确认 —— 上面那条命令**不适用**）：状态路径是 `/opt/rongying/updates-state/lock/<频道>`，记录文件是它下面的 `owner.json`。**不要 `rm -rf` 这个目录，也不要 `rm` 掉锁目录本身**（状态目录是 junction 高发区，本仓库有硬规定；裸删会留下无法解释的状态）。用你平时的登录账号与密钥登到发布主机上（**本手册从不要求你手写 `ssh` 命令**），按顺序做**两件事**：

```bash
ls -la /opt/rongying/updates-state/lock/<频道>
cat /opt/rongying/updates-state/lock/<频道>/owner.json
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
$env:MOFANG_FEED_OPERATOR = '<本执行人>'
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
$env:MOFANG_UPDATE_PUBLIC_KEY_B64 = '<与私钥匹配的 SPKI Base64 公钥>'
$env:MOFANG_UPDATE_SIGNING_KEY_FILE = '<仓库外的 Ed25519 PKCS#8 PEM>'
node scripts/feed-publish.mjs --re-sign-stable --channel stable --version <版本> --package <portable.zip> --file-manifest <portable-files.json> --manifest <internal 的 manifest.json> --stable-out <仓库外的 stable manifest 路径>
```

- `--stable-out` 必须在**仓库外**，且**拒绝覆盖**已有文件；要重签必须先手工删掉旧的那一份。
- ⚠️ **`--stable-out` 的写入不是原子的**：`wx` 只保证不覆盖 —— 进程写一半被杀会留下**半截文件，而且永久不可覆盖**，恢复 = **手工删掉再重签**。路径由操作员显式给出且在仓库外，所以这个删除不可逆但**可见**；改成“临时名 + rename”会**去掉覆盖拒绝这道守卫本身**，不划算 ⇒ **接受**。
- 这个模式**不写审计行**（它既不是十三步之一、也不是已登记的会话级条目）⇒ **必须在发布记录里手工写下**：产物路径，以及命令打印的三个摘要 `stableManifestSha256` / `reusedFileManifestSha256` / `reusedPackageSha256`。

### 10. 最后更新正式签名 manifest

用同一上传器 `--channel stable` 执行同样的十三步：

```powershell
$env:MOFANG_UPDATE_PUBLIC_KEY_B64 = '<与私钥匹配的 SPKI Base64 公钥>'
$env:MOFANG_FEED_OPERATOR = '<本执行人>'
node scripts/feed-publish.mjs --preflight --channel stable --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --audit-out <仓库外的审计日志路径>
node scripts/feed-publish.mjs --commit --channel stable --version <版本> --host <主机> --known-hosts <仓库外的 known_hosts 路径> --package <portable.zip> --file-manifest <portable-files.json> --manifest <第 9 步签出来的 stable manifest> --audit-out <仓库外的审计日志路径>
```

`--package` / `--file-manifest` 给的是**原字节**（internal 的那两个：不许重新打包、不许重新签名、不许改 ZIP 时间戳），`--manifest` 给的是**第 9 步签出来的那一份**。翻转后必须完成公网复验：重新取回 manifest **原始字节**、验签、比对 `channel` / `version` / `packageUrl`（**完整 origin**）以及两个产物的 SHA-256 与大小。

### 11. 保留服务端紧急回滚材料

保留上一版 `manifest.json`、`portable-files.json` 和 `portable.zip`。紧急回滚只把频道 manifest 指回上一套不可变制品；客户端已成功升级后不做静默降级。需要客户端降级时必须另开事故流程。

## nginx 与权限

- 新 manifest 位于 `/updates/<channel>/manifest.json`，**不继承** `= /updates/latest.yml` 的 `no-cache`。客户端是 Electron 主进程的全局 `fetch`（undici，无隐式 HTTP 缓存），当前风险低。**建议**追加 `location ~ ^/updates/(internal|stable)/manifest\.json$ { add_header Cache-Control "no-cache" always; }`。
- 生产**应当使用受限发布账号**：对版本目录可写、manifest 单独一步可换、不能改动其他内容。
- **当前是显式例外**：`/opt/rongying/updates` 与 `/opt/rongying/backups` 均为 `root:root 755`，首次发布将**临时使用 root**。残留风险：root 一旦被脚本缺陷或误用影响，可改动服务器上任意文件；审计**只能事后发现**。建立受限账号属后续加固。

## 发布前检查单

- [ ] `docs/portable-update-key-registry.md` 的 host-key 指纹已由用户或授权运维人员经**可信带外渠道**核对，并写明核对方式。（本项依赖《2026-09-22-portable-release-assembly-and-ci》Task 6 落地的密钥登记册；未落地前记「未验证」）
- [ ] 上传器使用**仓库外** known_hosts，`BatchMode=yes` 与 `StrictHostKeyChecking=yes` 生效。
- [ ] 三个产物的本地 SHA-256 与大小已记录，且与待发 manifest 逐项一致。
- [ ] 启动器身份挑战（第 6b 步）三条全部通过，读数已归档为**发布期 QC 证据**。（本项依赖《2026-09-22-portable-release-assembly-and-ci》Task 6 落地的第 6b 步；未落地前记「未验证」）
- [ ] `--audit-out` 指向**仓库外**；审计日志含 `open` … `unlock` 的**逐阶段**记录。
- [ ] 审计行里的 `operator` 是本执行人，不是 `unknown`（会写审计行的模式都设了 `MOFANG_FEED_OPERATOR`，见「发布前提」）。
- [ ] 已保留上一版 `manifest.json`、`portable-files.json` 与 `portable.zip` 作为回滚材料。
- [ ] 已确认「回滚只能拦住还没升级的客户端」——已升级的客户端**不会**降级，真降级必须另开事故流程。

## 立即停止条件

- 公私钥不匹配、签名或任一哈希不一致。
- 输出目录非空、包中出现链接/重解析点、Windows 保留名或受保护数据目录。
- 生成过程打印私钥、token 或完整凭据。
- 测试频道 manifest 指向尚未上传或尚未核验的 ZIP。
- 真盘验收有一项未执行、失败或只有推断没有证据。
