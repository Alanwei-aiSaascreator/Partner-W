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
- 私钥只允许写入系统临时目录，不得进入仓库、日志、客户包或长期制品。
- 发布服务必须支持“先传不可变版本目录，最后原子替换频道 manifest”。仓库目前没有通用服务器上传脚本；若当班人员没有经过复核的上传工具或服务端操作手册，停在第 8 步，不得现场拼命令。

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

此步需要单独的“测试更新源发布”授权。先上传不可变路径：

```text
/updates/internal/<版本>/portable.zip
/updates/internal/<版本>/portable-files.json
```

核对服务端文件字节与本地 SHA-256 后，最后才原子替换 `/updates/internal/manifest.json`。不能先改 manifest，也不能覆盖旧版本目录。

### 8. 完成真盘矩阵

严格执行 [U 盘整目录更新真盘验收](./portable-update-real-disk-acceptance.md)。exFAT、NTFS、两台干净 Windows 电脑、登录、付费模型和真实对话都通过前，不得进入正式频道。

### 9. 复制不可变制品到正式位置

此步需要单独的“正式更新源发布”授权。将测试通过的原字节制品复制到：

```text
/updates/stable/<版本>/portable.zip
/updates/stable/<版本>/portable-files.json
```

禁止重新打包、重新签名或改 ZIP 时间戳。复制后再次核对 SHA-256 和大小。

### 10. 最后更新正式签名 manifest

只有第 9 步字节核验通过，才原子替换 `/updates/stable/manifest.json`。替换前保存当前 manifest；替换后从公网重新下载 manifest 和 ZIP，独立复核签名、哈希、大小和 HTTPS URL。

### 11. 保留服务端紧急回滚材料

保留上一版 `manifest.json`、`portable-files.json` 和 `portable.zip`。紧急回滚只把频道 manifest 指回上一套不可变制品；客户端已成功升级后不做静默降级。需要客户端降级时必须另开事故流程。

## 立即停止条件

- 公私钥不匹配、签名或任一哈希不一致。
- 输出目录非空、包中出现链接/重解析点、Windows 保留名或受保护数据目录。
- 生成过程打印私钥、token 或完整凭据。
- 测试频道 manifest 指向尚未上传或尚未核验的 ZIP。
- 真盘验收有一项未执行、失败或只有推断没有证据。
