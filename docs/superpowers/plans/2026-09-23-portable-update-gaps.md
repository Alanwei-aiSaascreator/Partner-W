# 客户端自动更新「补洞」账本（2026-09-23）

范围：用户已拍的**方案 C 第一步 —— 补洞**（纯客户端代码 + 两处 CI 配置）。
基线：`0bec688b`（客户端产品主线）。分支：`fix/portable-update-gaps`。

⛔ 本账本里**没有**任何打包、发布、更新源上传、服务器动作。四道授权门一道未开。

## 0. 交付清单（8 刀）

| #     | 提交                  | 一句话                                                                                                         |
| ----- | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| ⑤     | `21e4c559`            | 删掉客户端侧死代码 `portable-swap.ts`（351 行，零生产引用）+ 修注释指针                                        |
| ①     | `02cd290c`            | 空公钥在**构建期**硬失败（下载期/打包期两道），不再静默注入空串                                                |
| ②     | `0c26dbac`            | `minLauncherVersion` 改比**盘上启动器的真版本**（`--version` 探测），不再比硬编码 `'1.0.0'`                    |
| 新增⑤ | `0aa532e2`            | 拆开 `MOFANG_LAUNCHER_VERSION` / `MOFANG_MIN_LAUNCHER_VERSION`；两侧缺失即硬失败；加「同一量多来源」一致性门禁 |
| ③     | `08f3e162`            | 空间预算接进下载**与**解压两条写盘路径；失败带上「需要多少/剩多少」                                            |
| ④     | `f64a2def`            | 启动时清理崩溃残留的 PREPARE 垃圾（`recoverPortablePrepare` 以前生产零调用）                                   |
| 新增④ | `dec5ca84`            | 失败出口**分类**（六类 + 可重试性 + 下一步），新增三个错误码                                                   |
| ⑥     | （只登记不改，见 §7） | 频道名 `beta → internal` 与 `allowPrerelease` 不可达：**判为不是缺陷**                                         |

门禁总读数见 §9，**终值见 §11（§9 的读数已被它取代 —— 那条根因是错的）**。
**未做/未验清单见 §10 —— 那一节是这份账本里最该看的。**

## 1. ⑤ 死代码 `portable-swap.ts`（`21e4c559`）

**判据**：产品代码零 import ⇒ 删除。

**零引用证明**（命令与真实输出）：

```
$ grep -rn "from '.*portable-swap\|require(.*portable-swap" packages/ e2e/ scripts/
packages/desktop/test/portable-update-swap.test.ts:11:
  } from '../src/main/update/portable-swap.js';
```

唯一命中是它**自己的单测**。真身在 `launcher/internal/update/swap.go`（`Recover` 在 `:92`）。

**读数**

|        | 测试文件                    | 测试                                       |
| ------ | --------------------------- | ------------------------------------------ |
| before | 3 failed / 279 passed (282) | 21 failed / 2901 passed / 2 skipped (2924) |
| after  | 3 failed / 278 passed (281) | 21 failed / 2884 passed / 2 skipped (2907) |

差 -1 文件 / -17 测试 = 被删的那份单测；无新增失败。`pnpm typecheck` exit 0。

顺手修掉 `main/runtime/portable-app-data.ts:48-49` 里指向该文件名的注释（否则是指向不存在文件的指针）。

## 2. ① 空公钥必须构建期失败（`02cd290c`）

**事实**：`electron.vite.config.ts:9-11` 用 `JSON.stringify(process.env.MOFANG_UPDATE_PUBLIC_KEY_B64 ?? '')`
⇒ 缺变量注入空串、构建静默通过；运行期在 `portable-manifest.ts:31-40` 解码失败抛
`signature-invalid`。**CI 的 `release` job 通 job 没有这个变量**（只有 `portable-update-release`
在 `:216` 写它）⇒ 今天发出去的安装器公钥就是空的。

**挂点选择与「为什么不误伤 dev/测试」的证据**

选**两处**，都不是 define 处：

1. `build` / `build:win` / `build:mac` / `build:mac:x64` / `build:linux` 的**前置**（`--require-env`）：秒级失败。
2. `electron-builder.yml` 的 `beforePack`（改成组合钩子 `scripts/before-pack.cjs`，同时挂运行时门禁与公钥门禁）：
   **查真产物** `out/main/index.js` 里到底有没有那把钥匙 —— 只有这一处能证明"真注进去了"。

**否掉 define 处的理由（有实测依据）**：`electron-vite@3.1.0` 里
`build` 传 `'build'`（`dist/chunks/lib-B57e7lYt.mjs:19`）、`dev` 传 `'serve'`（`lib-PoOhNRXw.mjs:16`），
所以按 `command` 能挡住 dev —— **但 e2e/CI 冒烟构建走的就是 `electron-vite build`**
（`.github/workflows/e2e.yml:108,151` 直接 exec 它，本来没有钥匙也不需要）。
在 define 处抛会把 e2e 一起打掉。而这两个挂点只覆盖**会产出安装包的路**：
`electron-vite dev`、单测、e2e **都不经过**（`grep -n electron-builder .github/workflows/e2e.yml` 无命中）。

**判据**与 Go 的 `decodePublicKey`（`launcher/cmd/mofang-launcher/main.go:74-91`）**逐条对齐**：
非空 → base64 能解 → 是 PKIX/SPKI DER → 是 **Ed25519**。四条缺一即失败。

**读数**

- RED（先写测试、模块不存在）：`Test Files 1 failed (1)  Tests  no tests`（`Cannot find module '../scripts/require-update-public-key.cjs'`）
- GREEN：`vitest run test/update-public-key-packaging-gate.test.ts test/runtime-packaging-gate.test.ts` → **2 files / 28 tests passed**
- CLI 端到端：
  - 无变量 → RC=1（中文报错说"空公钥包"并点名变量）
  - 空串 → RC=1
  - 真 Ed25519 SPKI → RC=0

**变异读数**（锚点命中数均为 1、打印被改 hunk、逐字节还原）

| 变异 | 改动                                                                              | 读数                 |
| ---- | --------------------------------------------------------------------------------- | -------------------- |
| A    | `if (problems.length === 0) return null;` → `if (true) return null;`              | 5 failed / 13 passed |
| B    | `if (keyBase64.length === 0 \|\| !source.includes(keyBase64)) {` → `if (false) {` | 2 failed / 16 passed |
| C    | yml `beforePack: …` → `# beforePack: …`（注释掉）                                 | 2 failed / 26 passed |

**顺带修的第三处调用方**：`pr-check.yml` 的 `build` job 会 `pnpm build` + Linux 冒烟打包，
所以给它加了「现生成一把一次性 Ed25519 公钥」的步骤（同文件 `:349` 的启动器 job 已有同样先例）。

⚠️ **`release.yml` 的 `release` job 我加了缺失的 `MOFANG_UPDATE_PUBLIC_KEY_B64`**（见 §4）。

## 3. ② `minLauncherVersion` 假门（`0c26dbac`）

**事实**：`update-handlers.ts:27-28` 的 `LAUNCHER_PROTOCOL_VERSION = '1.0.0'` 被当启动器版本传给服务，
`portable-manifest.ts:137-139` 拿它比 `manifest.minLauncherVersion` ⇒ 比的是**我们编出来的数字**。
真值通道一直存在：`launcher/cmd/mofang-launcher/main.go:52-54` 收 `--version`、`:133-136` 打 `deps.version`。

**方向验证**（这条决定"换成真值会不会把升级墙掉"）：发布侧
`scripts/make-portable-update.mjs:55` 把 `minLauncherVersion` 设成**同一个** `MOFANG_LAUNCHER_VERSION`
（release.yml:217 = `${RELEASE_TAG#v}`），所以两侧本是同一条版本线；硬编码 `'1.0.0'`
只是**恰好 >= 真实版本**而蒙过去。⚠️ 这条也正是「新增⑤」要拆变量的原因。

**探测失败的明确出口**：`probeLauncherVersion` **永不抛**，返回 `{kind:'unavailable', reason}`；
服务收 `launcherVersion: string | null`，`null` ⇒ **不取清单、直接拒绝**。绝不退回任何版本号。

**读数**

- RED（服务侧）：`Tests 2 failed | 18 passed (20)`，实际收到
  `"errorCode": "manifest-invalid"` —— 它**去了网络**并把锅甩给清单。
- RED（模块不存在）：`Test Files 1 failed (1)  Tests no tests`
- GREEN：launcher-version 16 passed；service 20 passed；ipc 6 passed

**变异读数**

| 变异 | 改动                                                                                                          | 读数                 |
| ---- | ------------------------------------------------------------------------------------------------------------- | -------------------- |
| D    | 服务 `if (launcherVersion === null) {` → `if (false) {`                                                       | 2 failed / 18 passed |
| E    | `parseSemanticVersion(trimmed);` → `void trimmed;`                                                            | 6 failed / 10 passed |
| F    | handlers `launcherVersion: probe.kind === 'version' ? probe.version : null,` → `'1.0.0',`                     | 2 failed / 14 passed |
| G    | `if (portableInitialization !== null) return portableInitialization;` → `if (true) return Promise.resolve();` | 1 failed / 5 passed  |

**`pnpm check` 抓到一处按文件跑漏掉的缺陷**（这条是"门禁不能省"的实证）：

```
$ pnpm typecheck:tests
test/portable-update-launcher-version.test.ts(69,30): error TS2493:
  Tuple type '[]' of length '0' has no element at index '0'.
```

`vi.fn(async () => …)` 把 `mock.calls` 推成 `[]` ⇒ `calls[0][0]` 不可索引。改成显式收集数组后
`typecheck:tests` exit 0、文件仍 16/16。`pnpm typecheck`（非 test）**不编译 `test/**`\*\*，所以只有门禁能发现。

**一处既有测试的适配**：`portable-update-ipc.test.ts` 的装配现在是异步的（多了一次 `--version` 探测），
状态断言改为 `vi.waitFor` 等它落定；**断言内容一字未改**，且变异 G 证明"等"没有把它变成不会失败的测试。

## 4. 新增⑤ 变量纠偏 + 同一量多来源（`0aa532e2`）

**事实**：同一个变量名承载两个量 —— runbook 第 3 步（`:51`）是"**启动器自己的版本**"、
第 5 步（`:74`）是"**manifest 的 `minLauncherVersion`**"。后果具体：
`MOFANG_LAUNCHER_VERSION` = `${RELEASE_TAG#v}` ⇒ 0.0.28 那次会把门槛写成 0.0.28，
而**盘上那把启动器永远是上一版**（便携更新**从不换启动器**：`荣盈魔方启动器.exe` 在
`FORBIDDEN_NAMES` 里，只由人工基础包更换）⇒ 验收目标 0.0.27 → 0.0.28 会被
`launcher-incompatible` 挡死。

**改法**：`MOFANG_MIN_LAUNCHER_VERSION`（新，**无默认值**，缺失即硬失败）承载 manifest 门槛；
`MOFANG_LAUNCHER_VERSION` 只留给启动器自身版本。另加校验：**门槛比本次要发的启动器还新**也硬失败
（那等于要求一个还不存在的启动器）。

**同一量多来源的扫描结论**

| 量           | 来源                                                                                                                                                        | 处理                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| feed URL     | `auto-updater.ts:88`（定义）、`electron-builder.yml:13`、`feed-publish.mjs` 的 `PUBLIC_BASE_URL`、`release.yml` 的 `MOFANG_UPDATE_BASE_URL` 与 `--base-url` | 跨 TS/yml/脚本/workflow，**收敛不了** ⇒ 加一致性门禁 `scripts/lib/update-source-consistency.test.mjs`（7 条） |
| 启动器版本   | `MOFANG_LAUNCHER_VERSION`（ldflags）、release tag、客户端探测                                                                                               | **已收敛**：ldflags 与探测读同一把 exe 的同一行；manifest 门槛已拆走                                          |
| 状态文件路径 | `update-handlers.ts` 拼过一次、启动恢复也要拼                                                                                                               | **已收敛**到 `portableUpdateStateFilePath()`（见 §6）                                                         |

⚠️ **`release.yml` 需要仓库变量 `vars.MOFANG_MIN_LAUNCHER_VERSION`**（值是"当前基础包里那把启动器"，
0.0.27 基础包 ⇒ `0.0.27`）。**这是我加的、需要你确认的一处配置**：变量不存在时该 job 会硬失败，
报 `Missing protected release secret: MOFANG_MIN_LAUNCHER_VERSION`（响亮且可操作）。

**读数**

- RED（三条新 CLI 用例，改动前）：
  - `✖ the CLI refuses to sign when MOFANG_MIN_LAUNCHER_VERSION is missing`
  - `✖ the manifest minimum comes from MOFANG_MIN_LAUNCHER_VERSION, not from MOFANG_LAUNCHER_VERSION`
    → `actual: '0.0.28'  expected: '0.0.27'`（它真的取了启动器那个版本）
  - `✖ the CLI refuses a minimum newer than the launcher this release ships`
- GREEN：`ℹ tests 16  ℹ pass 16  ℹ fail 0`；一致性门禁 7 passed；`pnpm check:portable-update-release` RC=0

**变异读数**

| 变异 | 改动                                                                                   | 读数                                       |
| ---- | -------------------------------------------------------------------------------------- | ------------------------------------------ |
| H    | `const raw = env.MOFANG_MIN_LAUNCHER_VERSION;` → `… \|\| env.MOFANG_LAUNCHER_VERSION;` | 1 failed（"refuses to sign when missing"） |
| I    | yml `url:` → `https://updates.example.invalid/updates/`                                | 1 failed（发布源一致性）                   |
| J    | runbook 第 5 步 `$env:MOFANG_MIN_LAUNCHER_VERSION` → `$env:MOFANG_LAUNCHER_VERSION`    | 1 failed（runbook 漂移）                   |

⚠️ **我自己在这里栽过一次**：第一轮 RED 里既有的 CLI 用例也红了，我差点读成"我的改动打破了它"。
真因是我**没 export Go 的 PATH**，而那条用例结尾会 `go -C launcher test`。
⇒ 该命令里的 `export PATH="/d/go-toolchain/go/bin:$PATH"` 是**命令的一部分**，不是可选项。

## 5. ③ 空间预算没接线（`08f3e162`）

**事实**：`calculatePortableSpaceBudget`（`portable-package.ts`）**生产零调用**；
下载侧只比 `available < expectedSize`（= **zip 大小**）；解压侧**完全没有检查** ——
而真正吃空间的是解压后的整棵程序树。

**接法**

- 下载：`packageSize + expandedSize + currentProgramSize + 64 MiB`
- 解压：`expandedSize + 64 MiB`（那一刻包已在盘上占着、现有程序也还在原处，重复算就是双计）
- 展开体积**只能**从签名过的 `portable-files.json` 算（`sumExpandedBytes`）：
  ⛔ manifest 键集被三层冻死（TS 精确键集 / Go `DisallowUnknownFields` / 签名负载逐键枚举），
  加 `expandedSize` 会让**已出厂的启动器**验签失败。
- 因此文件清单**提前到下载之前取**（不发相位，界面停在 `available`；副作用是坏清单在花掉一次大下载之前就失败）。
- 解压前先 `mkdir(temporaryRoot)` **再** `statfs`：`statfs` 一个不存在的路径会抛 ENOENT
  （既不是"空间不足"、也跟这份包无关）。

**读数**

- RED（服务侧）：`Tests 2 failed | 21 passed (23)`，两条都是 `requiredFreeBytes` 缺席
- RED（包侧，把判定退回 zip 大小）：`Tests 3 failed | 26 passed (29)`
- GREEN：`Tests 47 passed (47)`

**变异读数**

| 变异 | 改动                                                                                  | 读数                 |
| ---- | ------------------------------------------------------------------------------------- | -------------------- |
| K    | `available < input.requiredFreeBytes` → `available < input.expectedSize`              | 3 failed / 26 passed |
| L    | 解压预检 `await assertFreeBytes({` → `if (false) await assertFreeBytes({`             | 1 failed / 28 passed |
| M    | 服务 `requiredFreeBytes: downloadBudget,` → `requiredFreeBytes: current.packageSize,` | 1 failed / 22 passed |
| N    | `if (detail !== undefined) this.detail = detail;` → `this.detail = detail;`           | 7 failed             |

**门禁又抓到两处**（都不是我发现的）：`pnpm typecheck:tests` 报了
`portable-update-release-integration.test.ts`（`requiredFreeBytes` 现在必填）；
全量测试报了失败对象的**形状**断言 —— 这逼出一个真问题：
普通字段声明在 ES2022 类字段语义下**照样发出一个 `undefined` 自有属性**，
于是 `Object.keys(error)` 从 `['code','name']` 变成 `['code','detail','name']`。
改法是 `declare readonly detail?`（只声明类型、不产生字段）+ 有才赋。
既有断言**未放宽**，另加一条"空间失败只多带两个数字"的按名测试。

## 6. ④ 崩溃恢复没接线（`f64a2def`）

**事实**：`recoverPortablePrepare` **生产零调用**。崩在下载/解压中途会留下
`.荣盈魔方更新/download/<txn>/`（几百 MB 包）与 `staged/<txn>/`（解压了一半的树），
而下次更新用新 transactionId ⇒ 永不回收。

**挂点**：`runUpdaterStartupHousekeeping()`（`main/auto-updater.ts`，由 `main/index.ts:422`
在 `prepareWorkspaceAtStartup` 之后调用 —— 与它旁边两条清理同源：都要靠工作区准备阶段写下的
`getPortableWorkspaceRoot()` 分辨"这是不是盘上运行"）。

**两条硬约束（各有按名测试）**

1. **非便携态一律不动手**（`portableRoot === null` ⇒ `skipped-not-portable`）。
2. **绝不抛**：失败收成 `{kind:'failed', reason}`，调用方写 warn 级调试日志（吞掉但不静默）。

**刻意不碰 `ready`**：只回收四个 PREPARE 相位；`applying`/`awaiting-health` 归启动器的
`Recover`（`swap.go:92`），而 `ready` 是"已验完、就等重启换目录"的成果，删掉等于白扔用户的下载。

顺带把状态文件路径收敛到 `portableUpdateStateFilePath()`（以前 `update-handlers.ts` 另拼一次）。

**读数**

- RED（函数不存在）：`Tests 6 failed | 19 passed (25)`
- GREEN：state 25 + auto-updater 23 + ipc 6 = 52 passed

**变异读数**

| 变异 | 改动                                                                                                | 读数                       |
| ---- | --------------------------------------------------------------------------------------------------- | -------------------------- |
| O    | `void recoverInterruptedPortablePrepare();` → 注释掉                                                | 1 failed（**装配点**那条） |
| P    | `if (input.portableRoot === null) return { kind: 'skipped-not-portable' };` → `if (false) …`        | 1 failed / 24 passed       |
| Q    | `if (!PREPARE_PHASES.includes(input.transaction.phase)) return false;` → `if (false) return false;` | 2 failed / 23 passed       |

变异 O 是这一刀的要害：它证明的不再是"函数写好了、也有测试"，
而是"**启动序列真的把它带起来了**" —— 原缺陷正是"逻辑在、没人调"。

## 7. ⑥ 频道名 `beta → internal`：**判为不是缺陷，只登记不改**

- `portableChannel()` 把应用侧的 `beta` 映射到 `internal` **feed 目录**，
  这**就是**盘上形态下"要不要预发布"的等价决定（已安装侧才用 `autoUpdater.allowPrerelease`）。
- `auto-updater.ts:267` 的 `autoUpdater.allowPrerelease = …` 在便携分支（`:250` 提前 return）
  之后 ⇒ 盘上形态执行不到。这**不是**漏掉的设置：便携路径根本不用 electron-updater
  （`:249` 的注释就是"签名的整目录清单才是真相源，electron-updater 在这里没有立足点"），
  给一个用不上的库设开关没有意义。所以**不改**。
- 残留观察（**未改**）：若 `portable === true` 而 `portableService === null`，代码会**穿透**到
  electron-updater 那条在盘上"没有立足点"的分支。⑧ 之后该分支更难到达
  （`launcher-unavailable` 也会把服务挂上），但"根目录在装配时恒为 null ⇒ 首次检查才装配"
  这个时序没动。**登记为观察项，不作为缺陷处理。**

## 8. 新增④ 失败出口分类（`dec5ca84`）

`renderer/features/internal-beta/update-errors.ts` 里两张并行的 Record 合成**一张表**，
每条错误码带 `{category, retryable, action, text}`：

| 类别         | 错误码                                                                                              | 可重试             | 下一步                               |
| ------------ | --------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------ |
| `no-update`  | `update-not-published`、`cancelled`                                                                 | 是                 | 说"当前频道暂无更新"（**不是错误**） |
| `network`    | `network`、`feed-response`、`package-integrity`                                                     | 是                 | 稍后再试                             |
| `untrusted`  | `signature-invalid`、`manifest-invalid`、`unsupported-policy`（+`archive-unsafe`/`file-integrity`） | 否（后两者可重试） | 重新获取完整交付包                   |
| `space`      | `disk-space`                                                                                        | 是                 | 先说清"需要多少/剩多少"              |
| `launcher`   | `launcher-incompatible`、`launcher-unavailable`                                                     | 否                 | 换**完整基础包**                     |
| `filesystem` | `volume-readonly`、`filesystem-error`、`file-in-use`、`rollback-failed`                             | 见 §8 注           | 与空间不足分开                       |

**新增三个错误码及其行为**

1. `update-not-published`：feed 的 `<channel>/manifest.json` 返回 **404** ⇒ 服务落回 **idle**
   （不是 error），且**不设 permanentError**（新版本发布后下一次 check 必须能看见）。
   这就是现在的真实状态：Codex 已核 `/updates/stable/manifest.json` 与
   `/updates/internal/manifest.json` **都是 404** ⇒ 文案与文档**不许**把远程源描述成"已可用"。
2. `launcher-unavailable`：探测失败以前被报成 `launcher-incompatible`（"版本太旧"），
   而那是**我们没做过的比较**；"没认出配套启动器"（缺失/不是我们的/只换了客户端留下旧启动器）
   是另一回事，也正是基础包规则要拦的交付形态。判为**永久失败**（再点也没用）。
   ⚠️ 这条**改了 ② 已提交的对外错误码**（`launcher-incompatible` → `launcher-unavailable`），
   同时把「真版本比清单要求的旧」保留为 `launcher-incompatible` —— 两者语义不同，各有测试。
3. `filesystem-error`：`mapFileSystemFailure` 的兜底以前是 `archive-unsafe`
   （"更新包里有不安全的内容"）—— 那是在**冤枉这份包**：写失败、exFAT 命名限制、
   半途断电残留都会落到兜底。现在兜底是 `filesystem-error`，**与空间不足分开**
   （清空间解决不了写失败）。

**另修一条真缺陷**：盘上那条链失败时给渲染进程的是**错误码**，而 `describeUpdateError`
是按 electron-updater 的英文原文写的 ⇒ 错误码一路落到 `default` ⇒
用户看到"下载更新没完成，请稍后重试"，**`launcher-unavailable` 那种明确不该重试的也被建议重试**
（分类就白做了）。现在整串命中错误码即交给分类文案；英文原文照旧走原路径（精确整串匹配）。

**读数**

- RED（分类表不存在）：`Tests 18 failed | 28 passed (46)`
- GREEN：errors 50 passed；service 26 passed；package 44 passed

**变异读数**

| 变异 | 改动                                                                                | 读数                 |
| ---- | ----------------------------------------------------------------------------------- | -------------------- |
| R    | `disk-space` 的 `category: 'space'` → `'filesystem'`                                | 2 failed / 44 passed |
| S    | `if (typeof required !== 'number' \|\| …) return null;` → `if (true) return null;`  | 1 failed / 45 passed |
| T    | 服务 `if (code === 'update-not-published') {` → `if (false) {`                      | 1 failed / 25 passed |
| U    | `return new PortableUpdateFailure('filesystem-error');` → `return unsafeArchive();` | 7 failed             |

**两处断言的调整（均刻意、且比看上去更窄）**

- `rollback-failed` 判**不可重试**：它的文案本来就是"别拔盘、别删文件、找技术支持"，
  标成"可重试"会与它旁边那句话矛盾。**先写错的是我的测试**，不是表。
- `describeUpdateError('cancelled', …)` 现在给分类表那句（"已取消更新，当前版本可以继续使用。"）。
  断言改成检查**意图**（这不是错误）而不是逐字串。

## 9. 门禁总读数

```
$ export PATH="/d/go-toolchain/go/bin:$PATH"      # 第一步就是 Go
$ pnpm check
```

| 时点                      | 结果                                                         |
| ------------------------- | ------------------------------------------------------------ |
| 第 2 刀后（首次跑全门禁） | **RC=1**：`typecheck:tests` 报 `TS2493`（见 §3）——修好后通过 |
| 第 5 刀后                 | 待补：见 §9.1                                                |

桌面端全量测试（`packages/desktop`）：

| 时点                            | 文件                        | 测试                           |
| ------------------------------- | --------------------------- | ------------------------------ |
| 基线 `0bec688b`（未改任何代码） | 3 failed / 279 passed (282) | 21 failed / 2901 passed (2924) |
| 最后一刀后                      | 3 failed / 280 passed (283) | 21 failed / 2979 passed (3002) |

**那 3 个失败文件是环境性的、与本次改动无关**：
`artifact-reconcile` / `context-source-service` / `db-context-sources`
**都**因 `better-sqlite3@12.6.2` **编不过 Node 26**（v8 移除了 `PropertyCallbackInfo::This`，
实测 `error C2039`）而加载不到原生绑定。基线（未改动时）就同样红。详见 §10。

### 9.1 最终 `pnpm check` 读数

见 §9.1。

## 10. 未做 / 未验清单（**明说，不默认成立**）

1. ~~**`pnpm check` 在本机不可能全绿**~~ ⇒ ⛔ **这条根因是错的，见 §11**：真因是我自己的
   `pnpm install --ignore-scripts` 跳过了后置的 `electron-builder install-app-deps`，
   原生模块从没按 **Electron 的 ABI** 编过。跑一条 `install-app-deps` 后全门禁 **RC=0**、
   桌面端 **3000 passed / 0 failed**。Node 26 不是障碍，也不需要换成 Node 20。
2. **没有任何真机验证**：全部读数来自单测 / 纯函数门禁 / 假注入（`statfs`、`startLauncher`）。
   U 盘便携态、真实 `荣盈魔方启动器.exe --version` 探测、真实解压、真实换目录**一次都没跑过**。
   ⇒ ② 的"探测真实启动器"目前只有注入桩 + 一次"用 node 冒充启动器"的真 spawn 测试。
3. **`launcher-version.ts` 的真 spawn 只测到"能拿到 stdout 且严格 semver 拒掉 `v26.…`"**；
   没有用**真正的启动器二进制**跑过 `--version`（那要打包，越界）。
4. **`release.yml` 的两处配置需要你确认**：
   - `MOFANG_UPDATE_PUBLIC_KEY_B64` 在 `release` job 是否可见（**仓库级** vs
     只挂在 `portable-update-production` 环境）。环境级 ⇒ 该 job 会硬失败并报
     `MOFANG_UPDATE_PUBLIC_KEY_B64 is not set`。**我无法从仓库判断**，故标 UNVERIFIED。
   - 仓库变量 `vars.MOFANG_MIN_LAUNCHER_VERSION` **尚不存在**，需要建（值 = 当前基础包里那把启动器）。
5. **公钥/私钥配对没有被证明**：裁决要求"证明私钥与该公钥配对"，我**没有做**（需要真密钥，越界）。
   代码侧只保证两侧内嵌同一把、且都必须是非空 Ed25519 SPKI。
6. **0.0.27 基础包本身没有构建、没有装配、没有真机换盘**。
   "0.0.27 → 0.0.28 自动升级"这条验收链**一次都没跑过**（需要打包 + 更新源，两道都越界）。
7. ~~**空间预算的"数字上屏"没做**~~ ⇒ ✅ **2026-09-23 已做，提交 `ec62b749`**。
   原来的读数比上面写的更差：两个面板都只把 `message` 字符串递进翻译层、**从没传过那两个数字**；
   而盘上那条链的失败是**发布出来的状态**（不抛异常到渲染进程）⇒ `errorMessage` 压根没被设过，
   关于页实际渲染出来的是「更新失败：」后面**空着**（红测第一次的读数字符串就是
   `…settings.updateError:settings.checkForUpdates…`，冒号后为空）。
   现在：新增渲染侧**唯一入口** `describeUpdateErrorFromState(raw, operation, portable)` ——
   **相位是 error 且错误码认得出 ⇒ 以公开状态为准**（带两个数字）；认不出 / 没状态则退回老路，
   与 `asPortableErrorCode` 同一口径。关于页改成存**原始报错 + 操作**、渲染时才翻译
   （以前存翻译结果，等于把公开状态挡在门外）；内测中心同样走这条缝。
   读数：桌面端 3000 → **3007 passed / 2 skipped / 0 failed**（新增 5 条单测 + 关于页 1 条 + 内测中心 1 条）；
   两处渲染点各自的变异（把 `portable` 位置换成 `null`）**只红自己那条**
   （关于页 1 failed | 8 passed；内测中心 1 failed | 7 passed），还原逐字节相同（sha256）、`pnpm check` **RC=0**。
   ⚠️ 仍未上屏的：安装态（electron-updater）那条链**本来就没有字节数**（那里没有空间预算逻辑），不是漏。
8. **public feed 现在不可用**（`stable/manifest.json`、`internal/manifest.json` 都 404，
   `latest.yml` 还指向 0.0.23）。我**没有**把它描述成可用；`update-not-published` 这条分类
   就是照这个事实写的。
9. **没有改 `.gitignore`、没有降断言、没有打包、没有连任何服务器**。
10. ⑧ 的 `launcher-unavailable` 复用而非新增了 UI 动作（`replace-package`），
    因此**没有**动 i18n 文案体系；如果将来要求单独文案，那是一次独立的改动。

### 9.1 门禁终值（**已被 §11 取代 —— 那是错的读数**）

```
$ export PATH="/d/go-toolchain/go/bin:$PATH"
$ pnpm check
PNPM_CHECK_RC=1
```

**前面 16 步全部 exit 0**（`pnpm check` 是 `&&` 串联，能走到最后一步就是证据）：

| 步骤                                                                                                                                                                                                             | 读数                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `check:portable-launcher`（Go）                                                                                                                                                                                  | `ok mofang-compass/portable-launcher/{cmd/mofang-launcher,internal/update}`      |
| `check:portable-update-release`（4 个文件）                                                                                                                                                                      | `tests 39 / pass 39 / fail 0`（13 build + 16 release + 3 ci + **7 新增一致性**） |
| `check:portable-feed-publish`                                                                                                                                                                                    | `tests 249 / pass 249 / fail 0`                                                  |
| `lint` / `check:architecture` / `check:ci-bot-security` / `check:ui-contract` / `check:renderer-copy` / `check:i18n` / `check:udisk-delivery` / `check:gateway-probe` / `check:dead-code`(knip) / `format:check` | 全部通过                                                                         |
| `typecheck` / `typecheck:tests` / `typecheck:e2e`                                                                                                                                                                | 三步 exit 0                                                                      |
| `test`（最后一步）                                                                                                                                                                                               | **失败** —— 见下                                                                 |

`pnpm -r test`：`@clawwork/core` 38 files passed、`@clawwork/pwa` 4 files passed、
`@clawwork/desktop` **`Test Files 3 failed | 280 passed (283)`** / `Tests 21 failed | 2979 passed | 2 skipped (3002)`。

那 3 个文件是 `artifact-reconcile` / `context-source-service` / `db-context-sources`，
**全部**因 `better-sqlite3@12.6.2` 与 Node 26 源级不兼容而加载不到原生绑定（§10 第 1 条）。
它们在**基线 `0bec688b`、我未改任何代码时**就是同样的 3 红。

⚠️ **读日志的一条纪律**（我在本轮里差点误读）：`node --test` 会把**每个 bundle 的汇总**
依次打出来，末尾那个数字属于**最后跑的 bundle**。我第一轮读到的 `tests 249`
属于 `check:portable-feed-publish`，不是 portable-update-release 那个 bundle；
只看 tail 会把它当成后者的读数。⇒ 数测试总量要**按 bundle 定位**，别读 tail。

## 11. ⛔ 更正：上面那条"环境性失败"的根因是错的（2026-09-23 晚）

**我先前说的**：那 3 个红文件（`artifact-reconcile` / `context-source-service` /
`db-context-sources`）因 `better-sqlite3@12.6.2` **编不过 Node 26** 而加载不到原生绑定，
"本机不可能全绿"。

**真相**：**是我自己的安装方式自伤。** 我为了绕开一次 `better-sqlite3` 编译失败，
用了 `pnpm install --frozen-lockfile --ignore-scripts` —— 那会跳过仓库自己的
`packages/desktop` 后置脚本 `postinstall: electron-builder install-app-deps`，
于是原生模块**从未按 Electron 的 ABI 编译**。

而这条链的绑定**必须是 Electron 的 ABI**：那 3 个文件会 **fork Electron** 去探数据库
（`ELECTRON_RUN_AS_NODE="1"`，见 asar 包装器），所以加载绑定的是 Electron 34（ABI 132），
不是跑测试的那个 Node。绑定缺席 ⇒ 子进程退出 1 ⇒ `ERR_DLOPEN_FAILED`。
我先前用"在 Node 26 下 `require('better-sqlite3')` 报 ABI 147 vs 132"当证据 ——
**那个诊断本身就对错了对象**：它测的是"Node 能不能加载 Electron 的绑定"，
而真正要回答的是"Electron 能不能加载"。

**一条命令就修好**：

```
$ cd packages/desktop && ./node_modules/.bin/electron-builder install-app-deps
  • completed installing native dependencies        (RC=0)
```

修完后那 3 个文件：`Test Files 3 passed (3) / Tests 23 passed (23)`。

**全门禁终值（RC=0，取代 §9.1）**

| 步骤                                                                          | 读数                                                                                                  |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `check:portable-launcher`（Go）                                               | ok（`cmd/mofang-launcher`、`internal/update`）                                                        |
| `check:portable-update-release`（4 文件）                                     | `tests 39 / pass 39 / fail 0`                                                                         |
| `check:portable-feed-publish`（3 文件）                                       | `tests 249 / pass 249 / fail 0`                                                                       |
| `lint` / `architecture` / `ci-bot-security` / `ui-contract` / `renderer-copy` | 通过（exit 0）                                                                                        |
| `check:i18n`                                                                  | `tests 8 / pass 8`                                                                                    |
| `check:udisk-delivery`                                                        | `tests 48 / pass 48`                                                                                  |
| `check:gateway-probe`                                                         | `tests 25 / pass 25`                                                                                  |
| `check:dead-code`（knip） / `format:check`（prettier）                        | 通过                                                                                                  |
| `typecheck` / `typecheck:tests` / `typecheck:e2e`                             | 三步 exit 0                                                                                           |
| `pnpm -r test`                                                                | shared `124 passed`、core `655 passed`、pwa `61 passed`、**desktop `3000 passed / 2 skipped (3002)`** |

```
$ export PATH="/d/go-toolchain/go/bin:$PATH"
$ pnpm check
PNPM_CHECK_RC=0
```

**为什么没有改提交信息**：错根因写在 `21e4c559` / `02cd290c` / `0c26dbac` / `0aa532e2` /
`08f3e162` / `f64a2def` / `dec5ca84` 七个提交的正文里（"better-sqlite3 cannot compile
against Node 26"）。**重写它们会换掉你已核实的 8 个 SHA** —— 代价大于收益。
⇒ **本文件的 §11 是这条的正确性基准**；提交正文里那句话按本条更正读。

**另一件要说清的事**：我为了做"CI 一致的 Node 20"这一步，下载了
`node-v20.20.2-win-x64` 到**系统临时目录**（`%TEMP%\node20\`，不在仓库里）。
事后证明**不需要**：真因与 Node 版本无关。那份解压件留在临时目录，未使用、未进仓库。

**教训（归到已有的那类）**：这是「先验你自己的验证脚本」家族的又一例 ——
**把"我的环境自伤"读成了"产品的环境限制"**。具体形状：
① 我用 `--ignore-scripts` 省事 ⇒ 跳过一个**必需的**后置步骤；
② 出红之后我用**另一个工具**（裸 `node-gyp` + 裸 `require`）去诊断，
而它测的不是产品真正用的那条路（fork Electron）；
③ 两次读数都"自洽"（ABI 数字确实不匹配），于是我把一个**可修的环境问题**
写成了"本机不可能全绿"，还写进了 7 个提交。
正确的做法是：门禁报红时，先问"**产品自己是怎么准备这个原生的**"（读 `postinstall`），
而不是自己另造一条准备路径。

## 12. 合并态独立复验（`a67d872f`，2026-09-23 二轮）

本账本的 §11 是我这条线的终值（`3890628c`）。此后分支上又落了**四个不是我提交的**改动
（并行的更新线接着我的提交往下做）：`2e1c1888`、`db9b64d7`、`ec62b749`、`a67d872f`。

**我做的独立复验**：在 `a67d872f` 上重跑整道门禁（不是引用他们的读数）。

```
$ export PATH="/d/go-toolchain/go/bin:$PATH"
$ pnpm check
PNPM_CHECK_RC=0
```

| 步骤                                                                                  | 读数                                                                                             |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `go -C launcher test`                                                                 | ok                                                                                               |
| `check:portable-update-release`                                                       | `tests 39 / pass 39 / fail 0`                                                                    |
| `check:portable-feed-publish`                                                         | `tests 249 / pass 249 / fail 0`                                                                  |
| `check:i18n` / `check:udisk-delivery` / `check:gateway-probe`                         | `8` / `48` / `25`，全 pass                                                                       |
| lint / architecture / ci-bot-security / ui-contract / renderer-copy / knip / prettier | 通过                                                                                             |
| `typecheck` / `typecheck:tests` / `typecheck:e2e`                                     | exit 0                                                                                           |
| `pnpm -r test`                                                                        | shared `124`、core `655`、pwa `61`、**desktop `283 files / 3007 passed / 2 skipped / 0 failed`** |

**我复核了他们改我的两处**（只读）：

- `2e1c1888`：纯注释/文档，抓的是**我留下的真问题** —— `0c26dbac`（②）的 docblock 里
  "发布侧门槛取同一个 `MOFANG_LAUNCHER_VERSION`"在我自己的 `0aa532e2`（新增⑤）拆变量后
  **就不再成立**，还引了已变成注释的 `make-portable-update.mjs:55`。没有放松任何断言。
- `ec62b749`：新增渲染侧**唯一入口** `describeUpdateErrorFromState(raw, operation, portable)`，
  分层为 `FromState`（相位 error 且码认得出 ⇒ 以公开状态为准，带两个数字）→
  `describeUpdateError`（整串错误码）→ `describePortableError`，共用我加的 `asPortableErrorCode`
  与同一张分类表。**没有与我的实现重复**，也没有第二套判据。
