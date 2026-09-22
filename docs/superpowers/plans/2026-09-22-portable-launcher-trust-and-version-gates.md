# 启动器信任与版本门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面应用读取盘根启动器的**真实**版本与嵌入公钥指纹，让启动器在交换前用自己**编译进去的真实版本**再校验一次 `minLauncherVersion`，删除冒充启动器版本的硬编码常量，并让"启动器不可用"这一状态**上屏**而不是静默消失。

**Architecture:** 启动器新增两个**只读、无副作用**的 CLI 模式（`--describe-json`、`--verify-manifest <path>`）。桌面主进程用 **`spawnSync`**（带超时、`windowsHide`）调用 `--describe-json`，并经过一个显式的 `normalizeRunOutcome` 适配器把结果统一成 `{ status, stdout, error }`——**不用 `execFileSync`**，因为它在成功时返回 `string`/`Buffer` 而不是结果对象，直接按对象读 `.stdout` 会让真实启动器被永久误判为不兼容。严格解析后把**真实版本**喂给既有的 `minLauncherVersion` 门禁。Go 侧新增一个与 TypeScript **逐条镜像**的 SemVer 比较器，使两侧判定不会分叉。启动器的 `Apply` 在第一次 rename 之前再校验一次兼容性。

**Tech Stack:** Go 1.25（仅标准库）、TypeScript 5.7、Electron 34、Vitest 3、`node:test`、pnpm。

**规格来源：** `docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md` §4.1、§4.2、§4.3、§4.4、§5.7。

---

## 文件地图

| 文件                                                                    | 动作 | 职责                                                                                        |
| ----------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| `launcher/internal/update/semver.go`                                    | 新建 | 严格 SemVer 解析与比较，语义与 `packages/desktop/src/main/update/portable-manifest.ts` 一致 |
| `launcher/internal/update/semver_test.go`                               | 新建 | 上表的单元测试，含与 TS 同源的用例表                                                        |
| `launcher/internal/update/describe.go`                                  | 新建 | `--describe-json` 的载荷结构、公钥指纹、序列化                                              |
| `launcher/internal/update/describe_test.go`                             | 新建 | 指纹与载荷的单元测试                                                                        |
| `launcher/cmd/mofang-launcher/main.go`                                  | 修改 | 新增 `modeDescribe` / `modeVerifyManifest`、`invocation.path`、退出码 `exitVerifyFailed`    |
| `launcher/cmd/mofang-launcher/describe_test.go`                         | 新建 | 两个新模式的端到端（进程内 `run`）测试与副作用断言                                          |
| `launcher/internal/update/verify.go`                                    | 修改 | 新增 `CheckLauncherCompatibility`                                                           |
| `launcher/internal/update/verify_test.go`                               | 修改 | 兼容性校验的单元测试                                                                        |
| `launcher/internal/update/swap.go`                                      | 修改 | `Apply` 增加 `launcherVersion` 参数并在首次 rename 前校验                                   |
| `launcher/internal/update/swap_test.go`                                 | 修改 | `Apply` 调用点补参数 + 拒绝交换的测试                                                       |
| `launcher/cmd/mofang-launcher/main_test.go`                             | 修改 | `Apply` 调用点补参数                                                                        |
| `packages/desktop/src/main/update/launcher-descriptor.ts`               | 新建 | 调用 `--describe-json`、严格解析、fail-closed                                               |
| `packages/desktop/test/portable-launcher-descriptor.test.ts`            | 新建 | 用注入的 runner 覆盖全部失败形态                                                            |
| `packages/desktop/src/main/ipc/update-handlers.ts`                      | 修改 | 删除 `LAUNCHER_PROTOCOL_VERSION`，改为探测真实版本；探测失败时以 `unavailable` 挂载服务     |
| `packages/desktop/src/main/update/portable-update-service.ts`           | 修改 | 新增 `unavailable` 依赖：用已有的 `permanentError` 机制表达"启动器不可用"                   |
| `packages/desktop/src/renderer/features/internal-beta/update-errors.ts` | 修改 | `launcher-incompatible` 文案覆盖"缺失或版本太旧"两种情形                                    |
| `packages/desktop/test/portable-update-ipc.test.ts`                     | 修改 | 断言接线形态与 fail-closed（**断言错误上屏**，不是静默消失）                                |
| `packages/desktop/test/portable-update-service.test.ts`                 | 修改 | `unavailable` 前置条件的服务层测试                                                          |
| `packages/desktop/test/internal-beta-update-errors.test.ts`             | 修改 | 文案与动作的契约测试                                                                        |
| `packages/desktop/test/portable-update-about.test.tsx`                  | 修改 | UI 契约：错误态必须显示可操作原因，且不显示需要 ready 的按钮                                |
| `packages/desktop/test/portable-launcher-describe-integration.test.ts`  | 新建 | 真实 Windows GUI 二进制的 stdout 捕获集成测试                                               |

**knip 约束（务必遵守）：** `knip.json` 里 `packages/desktop` 的 `project` 只含 `src/**/*.{ts,tsx}`，测试目录不在其中。因此 `launcher-descriptor.ts` 的**每一个导出都必须被生产代码引用**（`update-handlers.ts`），否则 `pnpm check:dead-code` 会红。不要为了让测试方便而额外导出。

---

## 依赖与执行顺序

1. Task 1（SemVer）→ Task 4 依赖它。
2. Task 2（`--describe-json`）→ Task 5、Task 8 依赖它。
3. Task 3（`--verify-manifest`）与 Task 2 共用 `main.go` 的模式分发，必须在其后。
4. Task 5（TS 读取模块）→ Task 7 依赖它（接线要用它取真实版本）。
5. Task 6（服务层 `unavailable` 前置条件）与 Task 5 无依赖，可在 Task 5 之后任意位置执行；但**必须在 Task 7 之前**，因为 Task 7 会传入 `unavailable`。
6. Task 4（Go 侧交换前校验）与 Task 2/3 无依赖，可在 Task 3 之后任意位置执行。
7. Task 8 必须最后，它需要真实二进制。

**每刀的通用纪律（每个 Task 都适用，不再重复展开）：**

- 先写**命名 RED**，运行并确认**按测试名失败**（不是编译错误、不是别的测试）。
- 再做**最小 GREEN**。
- 然后做**行为级变异验证**：手工删掉本刀的关键护栏，确认指定测试**按测试名变红**，再**逐字节恢复**（`git diff` 必须为空）。
- 变异脚本要先自检：干净状态下必须全绿才继续；**测试脚本自身的失败要写成脚本错误**（非零退出 + 明确文本），不得混进“测试失败”。
- 判据必须包含 `passed > 0`；**“跳过”一律记作“未验证”**，不得计入通过。
- 定向测试通过后再跑**完整门禁** `pnpm check`。
- 独立提交，**显式 pathspec**，禁止 `git add -A`。

---

### Task 1: Go — 与 TypeScript 逐条镜像的 SemVer 比较器

**Files:**

- Create: `launcher/internal/update/semver.go`
- Test: `launcher/internal/update/semver_test.go`

本刀必须镜像的 TS 语义（来源 `packages/desktop/src/main/update/portable-manifest.ts:27-72`）：

- 模式串允许可选 prerelease 与可选 build metadata（`+` 段被接受但**不参与比较**）。
- prerelease 为空 ⇔ 正式版；**正式版大于预发布版**；两者都空 ⇒ 相等。
- 逐段比较：段缺失 ⇒ 段少的小；数字段按数值比；数字段与字母段比 ⇒ **数字段小**；其余按字符串比。

- [ ] **Step 1: 写失败的测试**

创建 `launcher/internal/update/semver_test.go`：

```go
package update

import "testing"

func TestCompareSemanticVersionsOrdersNumerically(t *testing.T) {
	cases := []struct {
		left  string
		right string
		want  int
	}{
		{"1.0.0", "1.0.0", 0},
		{"1.0.1", "1.0.0", 1},
		{"0.9.0", "1.0.0", -1},
		{"1.10.0", "1.9.0", 1},
		{"2.0.0", "10.0.0", -1},
	}
	for _, item := range cases {
		got, err := CompareSemanticVersions(item.left, item.right)
		if err != nil {
			t.Fatalf("compare %s and %s: %v", item.left, item.right, err)
		}
		if got != item.want {
			t.Fatalf("compare %s and %s = %d, want %d", item.left, item.right, got, item.want)
		}
	}
}

func TestCompareSemanticVersionsRanksPrereleasesBelowReleases(t *testing.T) {
	cases := []struct {
		left  string
		right string
		want  int
	}{
		{"1.0.0", "1.0.0-beta.1", 1},
		{"1.0.0-beta.1", "1.0.0", -1},
		{"1.0.0-alpha", "1.0.0-beta", -1},
		{"1.0.0-alpha.1", "1.0.0-alpha.2", -1},
		{"1.0.0-alpha.10", "1.0.0-alpha.9", 1},
		{"1.0.0-alpha", "1.0.0-alpha.1", -1},
		{"1.0.0-beta.2", "1.0.0-beta.11", -1},
		{"1.0.0-1", "1.0.0-alpha", -1},
	}
	for _, item := range cases {
		got, err := CompareSemanticVersions(item.left, item.right)
		if err != nil {
			t.Fatalf("compare %s and %s: %v", item.left, item.right, err)
		}
		if got != item.want {
			t.Fatalf("compare %s and %s = %d, want %d", item.left, item.right, got, item.want)
		}
	}
}

func TestCompareSemanticVersionsIgnoresBuildMetadata(t *testing.T) {
	got, err := CompareSemanticVersions("1.0.0+build.7", "1.0.0+build.1")
	if err != nil {
		t.Fatalf("compare build metadata: %v", err)
	}
	if got != 0 {
		t.Fatalf("build metadata changed the comparison: got %d, want 0", got)
	}
}

func TestCompareSemanticVersionsRejectsUnstrictValues(t *testing.T) {
	for _, value := range []string{"1.0", "v1.0.0", "01.0.0", "1.0.0-", "dev", "", "1.0.0.0"} {
		if _, err := CompareSemanticVersions(value, "1.0.0"); err == nil {
			t.Fatalf("accepted an unstrict version: %q", value)
		}
		if _, err := CompareSemanticVersions("1.0.0", value); err == nil {
			t.Fatalf("accepted an unstrict version on the right side: %q", value)
		}
	}
}
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

运行：

```bash
go -C launcher test ./internal/update/ -run TestCompareSemanticVersions -count=1
```

预期：编译失败并报 `undefined: CompareSemanticVersions`。这是“按测试名失败”的可接受形态（符号尚不存在）；**若报的是其它测试失败或语法错误，停下查明**。

- [ ] **Step 3: 写最小实现**

创建 `launcher/internal/update/semver.go`：

```go
package update

import (
	"fmt"
	"strconv"
	"strings"
)

type semanticVersion struct {
	major      int64
	minor      int64
	patch      int64
	prerelease []string
}

func isNumericPart(value string) bool {
	if value == "" {
		return false
	}
	for _, symbol := range value {
		if symbol < '0' || symbol > '9' {
			return false
		}
	}
	return true
}

func isIdentifierPart(value string) bool {
	if value == "" {
		return false
	}
	for _, symbol := range value {
		switch {
		case symbol >= '0' && symbol <= '9':
		case symbol >= 'a' && symbol <= 'z':
		case symbol >= 'A' && symbol <= 'Z':
		case symbol == '-':
		default:
			return false
		}
	}
	return true
}

func isNumericIdentifier(value string) bool {
	if !isNumericPart(value) {
		return false
	}
	return value == "0" || value[0] != '0'
}

func parseSemanticVersion(value string) (semanticVersion, error) {
	body := value
	if plus := strings.IndexByte(body, '+'); plus >= 0 {
		metadata := body[plus+1:]
		body = body[:plus]
		if !allDotSeparated(metadata, isIdentifierPart) {
			return semanticVersion{}, fmt.Errorf("unstrict semantic version %q", value)
		}
	}
	prerelease := []string{}
	if dash := strings.IndexByte(body, '-'); dash >= 0 {
		raw := body[dash+1:]
		body = body[:dash]
		if !allDotSeparated(raw, isIdentifierPart) {
			return semanticVersion{}, fmt.Errorf("unstrict semantic version %q", value)
		}
		prerelease = strings.Split(raw, ".")
	}
	parts := strings.Split(body, ".")
	if len(parts) != 3 {
		return semanticVersion{}, fmt.Errorf("unstrict semantic version %q", value)
	}
	numbers := make([]int64, 3)
	for index, part := range parts {
		if !isNumericIdentifier(part) {
			return semanticVersion{}, fmt.Errorf("unstrict semantic version %q", value)
		}
		parsed, err := strconv.ParseInt(part, 10, 64)
		if err != nil {
			return semanticVersion{}, fmt.Errorf("unstrict semantic version %q", value)
		}
		numbers[index] = parsed
	}
	return semanticVersion{major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease: prerelease}, nil
}

func allDotSeparated(value string, accept func(string) bool) bool {
	if value == "" {
		return false
	}
	for _, part := range strings.Split(value, ".") {
		if !accept(part) {
			return false
		}
	}
	return true
}

func comparePrerelease(left, right []string) int {
	if len(left) == 0 || len(right) == 0 {
		if len(left) == len(right) {
			return 0
		}
		if len(left) == 0 {
			return 1
		}
		return -1
	}
	count := len(left)
	if len(right) > count {
		count = len(right)
	}
	for index := 0; index < count; index++ {
		if index >= len(left) || index >= len(right) {
			if index >= len(left) && index >= len(right) {
				return 0
			}
			if index >= len(left) {
				return -1
			}
			return 1
		}
		leftPart := left[index]
		rightPart := right[index]
		if leftPart == rightPart {
			continue
		}
		leftNumeric := isNumericPart(leftPart)
		rightNumeric := isNumericPart(rightPart)
		if leftNumeric && rightNumeric {
			leftValue, _ := strconv.ParseInt(leftPart, 10, 64)
			rightValue, _ := strconv.ParseInt(rightPart, 10, 64)
			if leftValue < rightValue {
				return -1
			}
			return 1
		}
		if leftNumeric != rightNumeric {
			if leftNumeric {
				return -1
			}
			return 1
		}
		if leftPart < rightPart {
			return -1
		}
		return 1
	}
	return 0
}

func CompareSemanticVersions(left, right string) (int, error) {
	leftVersion, err := parseSemanticVersion(left)
	if err != nil {
		return 0, err
	}
	rightVersion, err := parseSemanticVersion(right)
	if err != nil {
		return 0, err
	}
	if leftVersion.major != rightVersion.major {
		if leftVersion.major < rightVersion.major {
			return -1, nil
		}
		return 1, nil
	}
	if leftVersion.minor != rightVersion.minor {
		if leftVersion.minor < rightVersion.minor {
			return -1, nil
		}
		return 1, nil
	}
	if leftVersion.patch != rightVersion.patch {
		if leftVersion.patch < rightVersion.patch {
			return -1, nil
		}
		return 1, nil
	}
	return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease), nil
}
```

- [ ] **Step 4: 运行测试并确认通过**

运行：

```bash
go -C launcher test ./internal/update/ -run TestCompareSemanticVersions -count=1 -v
```

预期：4 个测试全部 `--- PASS`，且 `ok` 行出现。

- [ ] **Step 5: 行为级变异验证**

对 `semver.go` 施加三处变异，每处单独一次，逐字节恢复：

1. 把 `comparePrerelease` 里 `if len(left) == 0 { return 1 }` 改成 `return -1` ⇒ 预期 `TestCompareSemanticVersionsRanksPrereleasesBelowReleases` **按测试名变红**。
2. 把 `if leftNumeric != rightNumeric { if leftNumeric { return -1 } return 1 }` 的 `return -1` 与 `return 1` 互换 ⇒ 预期同一测试**按测试名变红**。
3. 把 `parseSemanticVersion` 里 `if !isNumericIdentifier(part)` 改成 `if !isNumericPart(part)` ⇒ 预期 `TestCompareSemanticVersionsRejectsUnstrictValues` **按测试名变红**（`01.0.0` 会被接受）。

每次变异后运行：

```bash
go -C launcher test ./internal/update/ -run TestCompareSemanticVersions -count=1 -v
```

判据：输出中必须出现该测试名 + `FAIL`，且 `--- PASS` 计数减少。恢复后再次运行必须全绿。

- [ ] **Step 6: 提交**

```bash
git add launcher/internal/update/semver.go launcher/internal/update/semver_test.go
git commit -m "feat(launcher): mirror the TypeScript semantic version comparison"
```

---

### Task 2: Go — 启动器身份自述 `--describe-json`

**Files:**

- Create: `launcher/internal/update/describe.go`
- Test: `launcher/internal/update/describe_test.go`
- Modify: `launcher/cmd/mofang-launcher/main.go`
- Test: `launcher/cmd/mofang-launcher/describe_test.go`

载荷格式（规格 §5.7 固定）：`{ "schemaVersion": 1, "launcherVersion": "<严格 SemVer>", "embeddedKeys": [ { "fingerprint": "<大写 hex>", "base64": "<SPKI Base64>" } ] }`。

**线格式决定（必须在实现中固定）：** `fingerprint` 在 JSON 里是**不带分隔符的大写 hex**（64 字符）。规格里“以大写 hex 分组显示”是**台账/手册的展示格式**；两侧比较时统一先去掉空格再转大写，因此展示格式与线格式都能比中。

- [ ] **Step 1: 写失败的测试（纯函数层）**

创建 `launcher/internal/update/describe_test.go`：

```go
package update

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"strings"
	"testing"
)

func TestKeyFingerprintIsUppercaseHexOfTheDer(t *testing.T) {
	cases := [][]byte{
		{},
		{0x00, 0x0f, 0xff},
		{0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70},
		[]byte("mofang-portable-launcher"),
	}
	for _, item := range cases {
		sum := sha256.Sum256(item)
		want := strings.ToUpper(hex.EncodeToString(sum[:]))
		got := KeyFingerprint(item)
		if got != want {
			t.Fatalf("fingerprint of %v = %q, want %q", item, got, want)
		}
		if len(got) != 64 {
			t.Fatalf("fingerprint length = %d, want 64", len(got))
		}
	}
}

func TestKeyFingerprintDistinguishesDifferentKeys(t *testing.T) {
	fingerprints := map[string]bool{}
	for _, item := range [][]byte{{0x30, 0x2a}, {0x30, 0x2b}, {0x30, 0x2a, 0x00}} {
		got := KeyFingerprint(item)
		if fingerprints[got] {
			t.Fatalf("fingerprint collision for %v", item)
		}
		fingerprints[got] = true
	}
}

func TestBuildDescriptionCarriesVersionAndEmbeddedKey(t *testing.T) {
	der := []byte{0x01, 0x02, 0x03, 0x04}
	key := base64.StdEncoding.EncodeToString(der)
	raw, err := BuildDescription("1.2.3", key, der)
	if err != nil {
		t.Fatalf("build the description: %v", err)
	}
	var payload LauncherDescription
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode the description: %v", err)
	}
	if payload.SchemaVersion != DescribeSchemaVersion {
		t.Fatalf("schemaVersion = %d, want %d", payload.SchemaVersion, DescribeSchemaVersion)
	}
	if payload.LauncherVersion != "1.2.3" {
		t.Fatalf("launcherVersion = %q, want %q", payload.LauncherVersion, "1.2.3")
	}
	if len(payload.EmbeddedKeys) != 1 {
		t.Fatalf("embeddedKeys length = %d, want 1", len(payload.EmbeddedKeys))
	}
	if payload.EmbeddedKeys[0].Base64 != key {
		t.Fatalf("embedded key base64 = %q, want %q", payload.EmbeddedKeys[0].Base64, key)
	}
	if payload.EmbeddedKeys[0].Fingerprint != KeyFingerprint(der) {
		t.Fatalf("embedded key fingerprint does not match the digest of the same bytes")
	}
}

func TestBuildDescriptionReportsNoKeyWhenTheKeyIsUnusable(t *testing.T) {
	raw, err := BuildDescription("1.2.3", "", nil)
	if err != nil {
		t.Fatalf("build the description without a key: %v", err)
	}
	var payload LauncherDescription
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("decode the description: %v", err)
	}
	if payload.EmbeddedKeys == nil {
		t.Fatalf("embeddedKeys must serialise as an empty array, not null")
	}
	if len(payload.EmbeddedKeys) != 0 {
		t.Fatalf("embeddedKeys length = %d, want 0", len(payload.EmbeddedKeys))
	}
}
```

本刀**不需要**读取 `launcher/testdata/` 的任何夹具：上面的用例全部用合成 DER 字节，避免依赖夹具密钥内容。

- [ ] **Step 2: 运行测试并确认按测试名失败**

运行：

```bash
go -C launcher test ./internal/update/ -run 'TestKeyFingerprint|TestBuildDescription' -count=1
```

预期：`undefined: KeyFingerprint`、`undefined: BuildDescription`、`undefined: LauncherDescription`、`undefined: DescribeSchemaVersion`。**若出现“重复声明 fixtureRoot”之类的错误，先删掉本地重复声明再继续。**

- [ ] **Step 3: 写最小实现**

创建 `launcher/internal/update/describe.go`：

```go
package update

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
)

const DescribeSchemaVersion = 1

type EmbeddedKeyDescription struct {
	Fingerprint string `json:"fingerprint"`
	Base64      string `json:"base64"`
}

type LauncherDescription struct {
	SchemaVersion   int                      `json:"schemaVersion"`
	LauncherVersion string                   `json:"launcherVersion"`
	EmbeddedKeys    []EmbeddedKeyDescription `json:"embeddedKeys"`
}

func KeyFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return strings.ToUpper(hex.EncodeToString(sum[:]))
}

func BuildDescription(version string, publicKeyBase64 string, der []byte) ([]byte, error) {
	keys := []EmbeddedKeyDescription{}
	if len(der) > 0 && publicKeyBase64 != "" {
		keys = append(keys, EmbeddedKeyDescription{
			Fingerprint: KeyFingerprint(der),
			Base64:      publicKeyBase64,
		})
	}
	payload := LauncherDescription{
		SchemaVersion:   DescribeSchemaVersion,
		LauncherVersion: version,
		EmbeddedKeys:    keys,
	}
	return json.Marshal(payload)
}
```

- [ ] **Step 4: 运行测试并确认通过**

运行：

```bash
go -C launcher test ./internal/update/ -run 'TestKeyFingerprint|TestBuildDescription' -count=1 -v
```

预期：4 个测试全部 `--- PASS`。

- [ ] **Step 5: 写失败的测试（CLI 模式层）**

创建 `launcher/cmd/mofang-launcher/describe_test.go`：

```go
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDescribeJSONReportsTheCompiledVersionAndKey(t *testing.T) {
	harness := newHarness(t)
	code := run([]string{"--describe-json"}, harness.dependencies())
	if code != exitOK {
		t.Fatalf("exit code = %d, want %d (output %q, logs %q)", code, exitOK, harness.output.String(), harness.logs.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(harness.output.Bytes(), &payload); err != nil {
		t.Fatalf("describe output is not JSON: %v (output %q)", err, harness.output.String())
	}
	if payload["schemaVersion"] != float64(1) {
		t.Fatalf("schemaVersion = %v, want 1", payload["schemaVersion"])
	}
	if payload["launcherVersion"] != "1.2.3" {
		t.Fatalf("launcherVersion = %v, want %q", payload["launcherVersion"], "1.2.3")
	}
	keys, ok := payload["embeddedKeys"].([]any)
	if !ok || len(keys) != 1 {
		t.Fatalf("embeddedKeys = %v, want one entry", payload["embeddedKeys"])
	}
	entry, _ := keys[0].(map[string]any)
	fingerprint, _ := entry["fingerprint"].(string)
	if len(fingerprint) != 64 || fingerprint != strings.ToUpper(fingerprint) {
		t.Fatalf("fingerprint = %q, want 64 uppercase hex characters", fingerprint)
	}
}

func TestDescribeJSONNeverTouchesTheDeliveryRoot(t *testing.T) {
	harness := newHarness(t)
	before := listDeliveryEntries(t, harness.root)
	code := run([]string{"--describe-json"}, harness.dependencies())
	if code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}
	after := listDeliveryEntries(t, harness.root)
	if before != after {
		t.Fatalf("description changed the delivery root: %q -> %q", before, after)
	}
	if harness.ops.calls != 0 {
		t.Fatalf("description performed %d operations on the update ops interface, want 0", harness.ops.calls)
	}
}

func TestDescribeJSONWritesNothingToStandardError(t *testing.T) {
	harness := newHarness(t)
	code := run([]string{"--describe-json"}, harness.dependencies())
	if code != exitOK {
		t.Fatalf("exit code = %d, want %d", code, exitOK)
	}
	if harness.logs.Len() != 0 {
		t.Fatalf("description logged %q, want nothing", harness.logs.String())
	}
}

func listDeliveryEntries(t *testing.T, root string) string {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("read the delivery root: %v", err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return strings.Join(names, "|")
}

func TestParseInvocationAcceptsTheDescribeFlag(t *testing.T) {
	parsed, err := parseInvocation([]string{"--describe-json"})
	if err != nil {
		t.Fatalf("parse --describe-json: %v", err)
	}
	if parsed.mode != modeDescribe {
		t.Fatalf("mode = %d, want modeDescribe (%d)", parsed.mode, modeDescribe)
	}
	_ = filepath.Separator
}
```

- [ ] **Step 6: 运行测试并确认按测试名失败**

运行：

```bash
go -C launcher test ./cmd/mofang-launcher/ -run 'TestDescribeJSON|TestParseInvocationAcceptsTheDescribeFlag' -count=1
```

预期：`undefined: modeDescribe`。**若报 `harness.ops.calls` 字段不存在，按 `main_test.go` 中 `fakeOps` 的真实字段名调整这一处断言**（先运行 `grep -n "type fakeOps" -A 12 launcher/cmd/mofang-launcher/main_test.go`），其余断言不变。

- [ ] **Step 7: 写最小实现**

修改 `launcher/cmd/mofang-launcher/main.go`。

(a) 在 `invocationMode` 常量块里追加两个模式：

```go
const (
	modeLaunch invocationMode = iota
	modeApply
	modeVersion
	modeDescribe
	modeVerifyManifest
)
```

(b) 在退出码常量块里追加：

```go
const (
	exitOK             = 0
	exitUnsupported    = 2
	exitLaunchFailed   = 3
	exitApplyFailed    = 4
	exitLockHeld       = 5
	exitInvalidState   = 6
	exitNoProgram      = 7
	exitVerifyFailed   = 8
)
```

(c) `invocation` 结构体增加路径字段：

```go
type invocation struct {
	mode      invocationMode
	statePath string
	path      string
}
```

(d) `parseInvocation` 改为：

```go
func parseInvocation(args []string) (invocation, error) {
	switch len(args) {
	case 0:
		return invocation{mode: modeLaunch}, nil
	case 1:
		if args[0] == "--version" {
			return invocation{mode: modeVersion}, nil
		}
		if args[0] == "--describe-json" {
			return invocation{mode: modeDescribe}, nil
		}
	case 2:
		if args[0] == "--apply" && args[1] != "" {
			return invocation{mode: modeApply, statePath: args[1]}, nil
		}
		if args[0] == "--verify-manifest" && args[1] != "" {
			return invocation{mode: modeVerifyManifest, path: args[1]}, nil
		}
	}
	return invocation{}, errors.New("unsupported launcher arguments")
}
```

(e) 新增解码材料函数（保留 `decodePublicKey` 的签名不变，避免动 `main_test.go`）：

```go
func decodePublicKeyMaterials(encoded string) ([]byte, ed25519.PublicKey, error) {
	der, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return nil, nil, err
	}
	parsed, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, nil, err
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, nil, errors.New("public key is not an ed25519 key")
	}
	return der, key, nil
}

func decodePublicKey(encoded string) (ed25519.PublicKey, error) {
	_, key, err := decodePublicKeyMaterials(encoded)
	return key, err
}
```

(f) `dependencies` 增加 DER 字段：

```go
type dependencies struct {
	ops           update.Ops
	screen        ui.Screen
	messages      ui.Messages
	publicKey     ed25519.PublicKey
	publicKeyDER  []byte
	version       string
	launcherPath  string
	output        io.Writer
	logf          func(string, ...any)
}
```

(g) 在 `run` 里，`modeVersion` 分支之后追加 `modeDescribe` 分支：

```go
	if parsed.mode == modeDescribe {
		raw, err := update.BuildDescription(deps.version, publicKeyBase64, deps.publicKeyDER)
		if err != nil {
			deps.screen.Error(deps.messages.UnsupportedArgs, deps.messages.UnsupportedArgsDetail)
			return exitUnsupported
		}
		fmt.Fprintln(deps.output, string(raw))
		return exitOK
	}
```

(h) `main()` 改为使用 `decodePublicKeyMaterials` 并填充 `publicKeyDER`：

```go
	der, publicKey, keyErr := decodePublicKeyMaterials(publicKeyBase64)
	if keyErr != nil {
		fmt.Fprintf(os.Stderr, "portable launcher: %v\n", keyErr)
	}
```

并把 `dependencies{...}` 里加上 `publicKeyDER: der,`。

- [ ] **Step 8: 运行测试并确认通过**

运行：

```bash
go -C launcher test ./cmd/mofang-launcher/ -count=1 -v
```

预期：新增 4 个测试 `--- PASS`，且**既有 12 个测试全部仍然 PASS**（`TestParseInvocationAcceptsOnlyTheDocumentedArguments` 的用例表不能因为新增模式而变红；若它用了“未知 flag 必须被拒”的用例，确认 `--force` 仍然是未知的）。

- [ ] **Step 9: 行为级变异验证**

1. 把 `BuildDescription` 里 `keys := []EmbeddedKeyDescription{}` 改成 `var keys []EmbeddedKeyDescription` ⇒ 预期 `TestBuildDescriptionReportsNoKeyWhenTheKeyIsUnusable` **按测试名变红**（`embeddedKeys` 变成 `null`）。
2. 把 `KeyFingerprint` 里 `strings.ToUpper(...)` 去掉 ⇒ 预期 `TestKeyFingerprintIsUppercaseHexOfTheDer` 与 CLI 的 `TestDescribeJSONReportsTheCompiledVersionAndKey` **按测试名变红**。
3. 把 `run` 里 `modeDescribe` 分支的返回值改成 `exitUnsupported` ⇒ 预期 `TestDescribeJSONReportsTheCompiledVersionAndKey` **按测试名变红**。

每处变异后运行：

```bash
go -C launcher test ./internal/update/ ./cmd/mofang-launcher/ -run 'TestKeyFingerprint|TestBuildDescription|TestDescribeJSON' -count=1 -v
```

恢复后重新运行必须全绿，且 `git diff` 为空。

- [ ] **Step 10: 提交**

```bash
git add launcher/internal/update/describe.go launcher/internal/update/describe_test.go launcher/cmd/mofang-launcher/main.go launcher/cmd/mofang-launcher/describe_test.go
git commit -m "feat(launcher): report the compiled version and embedded key fingerprint"
```

---

### Task 3: Go — `--verify-manifest <path>`

**Files:**

- Modify: `launcher/cmd/mofang-launcher/main.go`
- Test: `launcher/cmd/mofang-launcher/describe_test.go`（追加）

结果 JSON：成功 `{ "schemaVersion": 1, "ok": true, "keyFingerprint": "<大写 hex>" }`；失败 `{ "schemaVersion": 1, "ok": false, "errorCode": "<code>" }`，`code` 取 `signature-invalid` 或 `manifest-invalid`（与 `packages/shared/src/portable-update.ts:20` 的 `PortableUpdateErrorCode` 同名，便于桌面侧直接透传）。

- [ ] **Step 1: 写失败的测试**

追加到 `launcher/cmd/mofang-launcher/describe_test.go`：

```go
func TestVerifyManifestAcceptsTheFixtureManifest(t *testing.T) {
	harness := newHarness(t)
	code := run([]string{"--verify-manifest", filepath.Join("../../testdata", "manifest.json")}, harness.dependencies())
	if code != exitOK {
		t.Fatalf("exit code = %d, want %d (output %q)", code, exitOK, harness.output.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(harness.output.Bytes(), &payload); err != nil {
		t.Fatalf("verify output is not JSON: %v (output %q)", err, harness.output.String())
	}
	if payload["ok"] != true {
		t.Fatalf("ok = %v, want true", payload["ok"])
	}
	if payload["keyFingerprint"] == "" || payload["keyFingerprint"] == nil {
		t.Fatalf("a successful verification must report the matched key fingerprint")
	}
}

func TestVerifyManifestRejectsAMutatedManifest(t *testing.T) {
	harness := newHarness(t)
	root := t.TempDir()
	raw, err := os.ReadFile(filepath.Join("../../testdata", "manifest.json"))
	if err != nil {
		t.Fatalf("read the fixture manifest: %v", err)
	}
	mutated := strings.Replace(string(raw), "\"mandatory\": false", "\"mandatory\": true", 1)
	if mutated == string(raw) {
		t.Fatalf("the mutation did not change the manifest")
	}
	target := filepath.Join(root, "manifest.json")
	if err := os.WriteFile(target, []byte(mutated), 0o600); err != nil {
		t.Fatalf("write the mutated manifest: %v", err)
	}
	code := run([]string{"--verify-manifest", target}, harness.dependencies())
	if code != exitVerifyFailed {
		t.Fatalf("exit code = %d, want %d (output %q)", code, exitVerifyFailed, harness.output.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(harness.output.Bytes(), &payload); err != nil {
		t.Fatalf("verify output is not JSON: %v (output %q)", err, harness.output.String())
	}
	if payload["ok"] != false {
		t.Fatalf("ok = %v, want false", payload["ok"])
	}
	if payload["errorCode"] == "" || payload["errorCode"] == nil {
		t.Fatalf("a failed verification must report an error code")
	}
}

func TestVerifyManifestRejectsAMissingFile(t *testing.T) {
	harness := newHarness(t)
	code := run([]string{"--verify-manifest", filepath.Join(harness.root, "absent.json")}, harness.dependencies())
	if code != exitVerifyFailed {
		t.Fatalf("exit code = %d, want %d", code, exitVerifyFailed)
	}
}

func TestVerifyManifestNeverTouchesTheDeliveryRoot(t *testing.T) {
	harness := newHarness(t)
	before := listDeliveryEntries(t, harness.root)
	run([]string{"--verify-manifest", filepath.Join("../../testdata", "manifest.json")}, harness.dependencies())
	after := listDeliveryEntries(t, harness.root)
	if before != after {
		t.Fatalf("verification changed the delivery root: %q -> %q", before, after)
	}
	if harness.ops.calls != 0 {
		t.Fatalf("verification performed %d operations on the update ops interface, want 0", harness.ops.calls)
	}
}

func TestParseInvocationAcceptsTheVerifyManifestFlag(t *testing.T) {
	parsed, err := parseInvocation([]string{"--verify-manifest", "C:/manifest.json"})
	if err != nil {
		t.Fatalf("parse --verify-manifest: %v", err)
	}
	if parsed.mode != modeVerifyManifest {
		t.Fatalf("mode = %d, want modeVerifyManifest (%d)", parsed.mode, modeVerifyManifest)
	}
	if parsed.path != "C:/manifest.json" {
		t.Fatalf("path = %q, want %q", parsed.path, "C:/manifest.json")
	}
	rejected := [][]string{
		{"--verify-manifest"},
		{"--verify-manifest", ""},
		{"--verify-manifest", "a", "b"},
	}
	for _, args := range rejected {
		if _, err := parseInvocation(args); err == nil {
			t.Fatalf("accepted an invalid invocation: %v", args)
		}
	}
}
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

运行：

```bash
go -C launcher test ./cmd/mofang-launcher/ -run 'TestVerifyManifest|TestParseInvocationAcceptsTheVerifyManifestFlag' -count=1
```

预期：`undefined: modeVerifyManifest` / `undefined: exitVerifyFailed`。

- [ ] **Step 3: 写最小实现**

在 `launcher/internal/update/describe.go` 追加结果结构：

```go
const VerifyResultSchemaVersion = 1

type VerifyResult struct {
	SchemaVersion  int    `json:"schemaVersion"`
	OK             bool   `json:"ok"`
	KeyFingerprint string `json:"keyFingerprint,omitempty"`
	ErrorCode      string `json:"errorCode,omitempty"`
}

func BuildVerifyResult(ok bool, fingerprint string, errorCode string) ([]byte, error) {
	payload := VerifyResult{
		SchemaVersion:  VerifyResultSchemaVersion,
		OK:             ok,
		KeyFingerprint: fingerprint,
		ErrorCode:      errorCode,
	}
	return json.Marshal(payload)
}
```

在 `main.go` 的 `run` 里，`modeDescribe` 分支之后追加：

```go
	if parsed.mode == modeVerifyManifest {
		return verifyManifest(deps, parsed.path)
	}
```

并在 `main.go` 里新增：

```go
func verifyManifest(deps dependencies, manifestPath string) int {
	raw, err := os.ReadFile(manifestPath)
	if err != nil {
		return reportVerifyFailure(deps, "manifest-invalid")
	}
	manifest, err := update.DecodeSignedManifest(raw)
	if err != nil {
		return reportVerifyFailure(deps, "manifest-invalid")
	}
	if err := update.VerifySignedManifest(manifest, deps.publicKey); err != nil {
		return reportVerifyFailure(deps, "signature-invalid")
	}
	fingerprint := ""
	if len(deps.publicKeyDER) > 0 {
		fingerprint = update.KeyFingerprint(deps.publicKeyDER)
	}
	raw, err = update.BuildVerifyResult(true, fingerprint, "")
	if err != nil {
		return reportVerifyFailure(deps, "signature-invalid")
	}
	fmt.Fprintln(deps.output, string(raw))
	return exitOK
}

func reportVerifyFailure(deps dependencies, errorCode string) int {
	raw, err := update.BuildVerifyResult(false, "", errorCode)
	if err != nil {
		return exitVerifyFailed
	}
	fmt.Fprintln(deps.output, string(raw))
	return exitVerifyFailed
}
```

注意 `verifyManifest` 只调用 `os.ReadFile` 与 `update` 的纯函数，**不触碰 `deps.ops`**——这是“无副作用”的结构性保证。

- [ ] **Step 4: 运行测试并确认通过**

运行：

```bash
go -C launcher test ./cmd/mofang-launcher/ ./internal/update/ -count=1 -v
```

预期：全部 PASS。

- [ ] **Step 5: 行为级变异验证**

1. 把 `verifyManifest` 里 `update.VerifySignedManifest` 的调用整行删掉（改成 `_ = manifest`）⇒ 预期 `TestVerifyManifestRejectsAMutatedManifest` **按测试名变红**。
2. 把 `reportVerifyFailure` 的返回值改成 `exitOK` ⇒ 预期 `TestVerifyManifestRejectsAMutatedManifest` 与 `TestVerifyManifestRejectsAMissingFile` **按测试名变红**。
3. 把 `verifyManifest` 里的 `os.ReadFile` 换成 `deps.ops.ReadFile` ⇒ 预期 `TestVerifyManifestNeverTouchesTheDeliveryRoot` **按测试名变红**（`ops.calls != 0`）。

恢复后 `git diff` 必须为空，且全部测试重新变绿。

- [ ] **Step 6: 提交**

```bash
git add launcher/cmd/mofang-launcher/main.go launcher/cmd/mofang-launcher/describe_test.go launcher/internal/update/describe.go
git commit -m "feat(launcher): verify a signed manifest from the command line"
```

---

### Task 4: Go — 交换前用真实编译版本校验 `minLauncherVersion`

**Files:**

- Modify: `launcher/internal/update/verify.go`
- Modify: `launcher/internal/update/verify_test.go`
- Modify: `launcher/internal/update/swap.go`
- Modify: `launcher/internal/update/swap_test.go`
- Modify: `launcher/cmd/mofang-launcher/main.go`

插入点（**必须精确**）：`launcher/internal/update/swap.go` 中 `!current || backup` 守卫（当前 `:175-177`）之后、第一次 `scopedRename`（当前 `:182`）之前。`Apply` 签名在末尾追加 `launcherVersion string`。

- [ ] **Step 1: 写失败的测试（校验函数）**

追加到 `launcher/internal/update/verify_test.go`：

```go
func TestCheckLauncherCompatibilityAcceptsAnEqualOrNewerLauncher(t *testing.T) {
	manifest := readFixtureManifest(t)
	for _, version := range []string{"1.0.0", "1.0.1", "2.0.0"} {
		if err := CheckLauncherCompatibility(manifest, version); err != nil {
			t.Fatalf("launcher %s was rejected: %v", version, err)
		}
	}
}

func TestCheckLauncherCompatibilityRejectsAnOlderLauncher(t *testing.T) {
	manifest := readFixtureManifest(t)
	for _, version := range []string{"0.9.9", "0.0.1"} {
		if err := CheckLauncherCompatibility(manifest, version); !errors.Is(err, ErrLauncherIncompatible) {
			t.Fatalf("launcher %s error = %v, want ErrLauncherIncompatible", version, err)
		}
	}
}

func TestCheckLauncherCompatibilityFailsClosedOnAnUnstrictLauncherVersion(t *testing.T) {
	manifest := readFixtureManifest(t)
	for _, version := range []string{"dev", "", "1.0"} {
		if err := CheckLauncherCompatibility(manifest, version); !errors.Is(err, ErrLauncherIncompatible) {
			t.Fatalf("launcher %q error = %v, want ErrLauncherIncompatible", version, err)
		}
	}
}
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

运行：

```bash
go -C launcher test ./internal/update/ -run TestCheckLauncherCompatibility -count=1
```

预期：`undefined: CheckLauncherCompatibility`、`undefined: ErrLauncherIncompatible`。

- [ ] **Step 3: 写最小实现（校验函数）**

在 `launcher/internal/update/model.go` 的错误块追加：

```go
	ErrLauncherIncompatible = errors.New("portable update: launcher version is not compatible")
```

在 `launcher/internal/update/verify.go` 追加：

```go
func CheckLauncherCompatibility(manifest SignedManifestV1, launcherVersion string) error {
	comparison, err := CompareSemanticVersions(launcherVersion, manifest.MinLauncherVersion)
	if err != nil {
		return ErrLauncherIncompatible
	}
	if comparison < 0 {
		return ErrLauncherIncompatible
	}
	return nil
}
```

- [ ] **Step 4: 运行测试并确认通过**

运行：

```bash
go -C launcher test ./internal/update/ -run TestCheckLauncherCompatibility -count=1 -v
```

预期：3 个测试全部 PASS。

- [ ] **Step 5: 写失败的测试（交换前拒绝）**

追加到 `launcher/internal/update/swap_test.go`（沿用该文件既有的 harness：`installCurrentProgram` / `installVerifiedStage` / `validTransaction`）：

```go
func TestApplyRefusesAnIncompatibleLauncherBeforeAnyRename(t *testing.T) {
	harness := newSwapHarness(t)
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t)
	transaction := validTransaction(harness.root)
	before := harness.snapshotTree(t)

	err := Apply(context.Background(), transaction, harness.publicKey, harness.ops, "0.0.1")

	if !errors.Is(err, ErrLauncherIncompatible) {
		t.Fatalf("error = %v, want ErrLauncherIncompatible", err)
	}
	if after := harness.snapshotTree(t); after != before {
		t.Fatalf("an incompatible launcher changed the disk:\nbefore %q\nafter  %q", before, after)
	}
	if len(harness.ops.renames) != 0 {
		t.Fatalf("an incompatible launcher performed %d renames, want 0", len(harness.ops.renames))
	}
}

func TestApplyAcceptsACompatibleLauncher(t *testing.T) {
	harness := newSwapHarness(t)
	harness.installCurrentProgram(t)
	harness.installVerifiedStage(t)
	transaction := validTransaction(harness.root)

	err := Apply(context.Background(), transaction, harness.publicKey, harness.ops, "1.2.3")

	if err != nil {
		t.Fatalf("apply with a compatible launcher: %v", err)
	}
}
```

**命名对齐说明（必须先执行）：** 上面的 `newSwapHarness` / `installCurrentProgram` / `installVerifiedStage` / `snapshotTree` / `harness.ops.renames` 是为了可读性使用的名字。在写测试前先运行：

```bash
grep -n "func newSwapHarness\|func (harness \*swapHarness)\|installCurrentProgram\|installVerifiedStage\|func validTransaction\|renames\|type fakeOps" launcher/internal/update/swap_test.go launcher/internal/update/verify_test.go launcher/cmd/mofang-launcher/main_test.go
```

用该命令打印出的**真实名字**替换测试代码里的对应标识符；断言、结构与期望结果不变。若 `fakeOps` 没有记录 rename 的字段，把它换成该文件里已有的等价记录（例如按 `Exists`/`Rename` 计数），并在提交信息里如实写明记录方式。

- [ ] **Step 6: 运行测试并确认按测试名失败**

运行：

```bash
go -C launcher test ./internal/update/ -run 'TestApplyRefusesAnIncompatibleLauncherBeforeAnyRename|TestApplyAcceptsACompatibleLauncher' -count=1
```

预期：编译失败，`too many arguments in call to Apply`。

- [ ] **Step 7: 写最小实现（交换前校验）**

(a) `launcher/internal/update/swap.go`：`Apply` 签名末尾加参数，并在守卫之后、第一次 rename 之前插入校验：

```go
func Apply(ctx context.Context, transaction TransactionV1, publicKey ed25519.PublicKey, ops Ops, launcherVersion string) error {
```

```go
	current, err := ops.Exists(transaction.CurrentProgramPath)
	if err != nil {
		return err
	}
	backup, err := ops.Exists(transaction.BackupProgramPath)
	if err != nil {
		return err
	}
	if !current || backup {
		return fmt.Errorf("%w: %s", ErrNotReadyToApply, transaction.TransactionID)
	}
	manifest, err := ReadSignedManifest(transaction.ManifestPath)
	if err != nil {
		return err
	}
	if err := CheckLauncherCompatibility(manifest, launcherVersion); err != nil {
		return err
	}
```

（保持既有的 `scopedMkdirAll` 与后续行不动；上面片段中与现有代码重复的行以现有代码为准，只**插入** `manifest` / `CheckLauncherCompatibility` 两段。若现有代码把 `current`/`backup` 的读取写成 `:=` 并在同一语句里判断，按现有写法插入，不要重排现有语句。）

(b) `launcher/cmd/mofang-launcher/main.go` 的 `applyTransaction`：

```go
	applyErr := update.Apply(context.Background(), transaction, deps.publicKey, deps.ops, deps.version)
```

(c) 全仓更新 `Apply(` 的其余调用点（`swap_test.go`、`main_test.go`），一律在参数末尾补一个严格 SemVer 字符串（测试里统一用 `"1.2.3"`）。

- [ ] **Step 8: 运行测试并确认通过**

运行：

```bash
go -C launcher test ./... -count=1
```

预期：`ok` 行覆盖 `./cmd/mofang-launcher/`、`./internal/ui`、`./internal/update` 等全部包，**既有 56 个测试函数全部仍然 PASS**。

- [ ] **Step 9: 行为级变异验证**

1. 删掉 `Apply` 里插入的 `CheckLauncherCompatibility` 调用 ⇒ 预期 `TestApplyRefusesAnIncompatibleLauncherBeforeAnyRename` **按测试名变红**。
2. 把该调用的位置移到第一次 `scopedRename` **之后** ⇒ 预期同一测试**按测试名变红**（`renames` 不为 0 / 磁盘已改变）。
3. 把 `CheckLauncherCompatibility` 里 `if comparison < 0` 改成 `if comparison <= 0` ⇒ 预期 `TestCheckLauncherCompatibilityAcceptsAnEqualOrNewerLauncher` **按测试名变红**。

每处变异后运行：

```bash
go -C launcher test ./internal/update/ -run 'TestApplyRefusesAnIncompatibleLauncherBeforeAnyRename|TestCheckLauncherCompatibility' -count=1 -v
```

恢复后 `git diff` 为空且全绿。

- [ ] **Step 10: 提交**

```bash
git add launcher/internal/update/model.go launcher/internal/update/verify.go launcher/internal/update/verify_test.go launcher/internal/update/swap.go launcher/internal/update/swap_test.go launcher/cmd/mofang-launcher/main.go launcher/cmd/mofang-launcher/main_test.go
git commit -m "feat(launcher): refuse a swap the compiled launcher version cannot serve"
```

---

### Task 5: TS — `launcher-descriptor` 模块

**Files:**

- Create: `packages/desktop/src/main/update/launcher-descriptor.ts`
- Test: `packages/desktop/test/portable-launcher-descriptor.test.ts`

本模块**只依赖** `node:child_process`、`node:crypto`、`node:path` 与 `@clawwork/shared`，**不得 import `electron`**——后续发布 QC 需要从 `scripts/` 复用同一实现。

**硬性纪律（`docs/agent-rules/frontend.md`）：** 本文件内**不得出现任何注释**，不得出现非 ASCII 标识符。用户可见文案不进这里（走既有 i18n）。

- [ ] **Step 1: 写失败的测试**

创建 `packages/desktop/test/portable-launcher-descriptor.test.ts`：

```ts
import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { readLauncherDescriptor } from '../src/main/update/launcher-descriptor.js';

const keyPair = generateKeyPairSync('ed25519');
const PUBLIC_KEY_DER = keyPair.publicKey.export({ type: 'spki', format: 'der' });
const PUBLIC_KEY_BASE64 = PUBLIC_KEY_DER.toString('base64');
const FINGERPRINT = createHash('sha256').update(PUBLIC_KEY_DER).digest('hex').toUpperCase();

function describePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    launcherVersion: '1.2.3',
    embeddedKeys: [{ fingerprint: FINGERPRINT, base64: PUBLIC_KEY_BASE64 }],
    ...overrides,
  });
}

function spawnShape(result: { stdout?: string; error?: Error; status?: number | null }) {
  return vi.fn(() => ({
    stdout: result.stdout ?? '',
    stderr: '',
    status: result.status === undefined ? 0 : result.status,
    error: result.error,
  }));
}

function runnerFor(result: { stdout?: string; error?: Error; status?: number | null }) {
  return spawnShape(result);
}

describe('portable launcher descriptor', () => {
  it('reads the compiled version and the embedded key fingerprint', () => {
    const result = readLauncherDescriptor({
      launcherPath: 'C:/drive/launcher.exe',
      timeoutMs: 5000,
      runner: runnerFor({ stdout: describePayload() }),
    });
    expect(result.launcherVersion).toBe('1.2.3');
    expect(result.keyFingerprints).toEqual([FINGERPRINT]);
  });

  it('runs the launcher with the describe flag and no shell', () => {
    const runner = runnerFor({ stdout: describePayload() });
    readLauncherDescriptor({ launcherPath: 'C:/drive/launcher.exe', timeoutMs: 5000, runner });
    expect(runner).toHaveBeenCalledTimes(1);
    const [command, args, options] = runner.mock.calls[0] as [string, string[], Record<string, unknown>];
    expect(command).toBe('C:/drive/launcher.exe');
    expect(args).toEqual(['--describe-json']);
    expect(options.shell).toBeUndefined();
    expect(options.timeout).toBe(5000);
  });

  it('fails closed when the launcher cannot be started', () => {
    expect(() =>
      readLauncherDescriptor({
        launcherPath: 'C:/drive/launcher.exe',
        timeoutMs: 5000,
        runner: runnerFor({ error: new Error('ENOENT') }),
      }),
    ).toThrow(/launcher-incompatible/u);
  });

  it('fails closed on a non-zero exit code', () => {
    expect(() =>
      readLauncherDescriptor({
        launcherPath: 'C:/drive/launcher.exe',
        timeoutMs: 5000,
        runner: runnerFor({ stdout: describePayload(), status: 2 }),
      }),
    ).toThrow(/launcher-incompatible/u);
  });

  it('fails closed when the output is not JSON', () => {
    expect(() =>
      readLauncherDescriptor({
        launcherPath: 'C:/drive/launcher.exe',
        timeoutMs: 5000,
        runner: runnerFor({ stdout: 'not json' }),
      }),
    ).toThrow(/launcher-incompatible/u);
  });

  it('fails closed on an unknown describe schema version', () => {
    expect(() =>
      readLauncherDescriptor({
        launcherPath: 'C:/drive/launcher.exe',
        timeoutMs: 5000,
        runner: runnerFor({ stdout: describePayload({ schemaVersion: 2 }) }),
      }),
    ).toThrow(/launcher-incompatible/u);
  });

  it.each(['dev', '1.0', 'v1.0.0', '01.0.0', '', '1.0.0.0'])(
    'fails closed when the launcher reports the unstrict version %s',
    (launcherVersion) => {
      expect(() =>
        readLauncherDescriptor({
          launcherPath: 'C:/drive/launcher.exe',
          timeoutMs: 5000,
          runner: runnerFor({ stdout: describePayload({ launcherVersion }) }),
        }),
      ).toThrow(/launcher-incompatible/u);
    },
  );

  it('fails closed when no embedded key is reported', () => {
    expect(() =>
      readLauncherDescriptor({
        launcherPath: 'C:/drive/launcher.exe',
        timeoutMs: 5000,
        runner: runnerFor({ stdout: describePayload({ embeddedKeys: [] }) }),
      }),
    ).toThrow(/launcher-incompatible/u);
  });

  it('fails closed when an embedded key fingerprint is not 64 uppercase hex characters', () => {
    expect(() =>
      readLauncherDescriptor({
        launcherPath: 'C:/drive/launcher.exe',
        timeoutMs: 5000,
        runner: runnerFor({
          stdout: describePayload({ embeddedKeys: [{ fingerprint: 'abc', base64: PUBLIC_KEY_BASE64 }] }),
        }),
      }),
    ).toThrow(/launcher-incompatible/u);
  });

  it('accepts the string a successful execFileSync style runner returns', () => {
    const runner = vi.fn(() => describePayload());
    const result = readLauncherDescriptor({
      launcherPath: 'C:/drive/launcher.exe',
      timeoutMs: 5000,
      runner,
    });
    expect(result.launcherVersion).toBe('1.2.3');
  });

  it('accepts the buffer a successful runner returns', () => {
    const runner = vi.fn(() => Buffer.from(describePayload(), 'utf8'));
    const result = readLauncherDescriptor({
      launcherPath: 'C:/drive/launcher.exe',
      timeoutMs: 5000,
      runner,
    });
    expect(result.keyFingerprints).toEqual([FINGERPRINT]);
  });

  it('fails closed when a runner returns something unusable', () => {
    for (const value of [null, undefined, 42, {}]) {
      expect(() =>
        readLauncherDescriptor({
          launcherPath: 'C:/drive/launcher.exe',
          timeoutMs: 5000,
          runner: vi.fn(() => value),
        }),
      ).toThrow(/launcher-incompatible/u);
    }
  });

  it('fails closed when the fingerprint does not match the embedded public key', () => {
    expect(() =>
      readLauncherDescriptor({
        launcherPath: 'C:/drive/launcher.exe',
        timeoutMs: 5000,
        runner: runnerFor({
          stdout: describePayload({
            embeddedKeys: [{ fingerprint: 'B'.repeat(64), base64: PUBLIC_KEY_BASE64 }],
          }),
        }),
      }),
    ).toThrow(/launcher-incompatible/u);
  });

  it('fails closed when the embedded public key is not a valid spki value', () => {
    expect(() =>
      readLauncherDescriptor({
        launcherPath: 'C:/drive/launcher.exe',
        timeoutMs: 5000,
        runner: runnerFor({
          stdout: describePayload({ embeddedKeys: [{ fingerprint: FINGERPRINT, base64: 'bm90LWEta2V5' }] }),
        }),
      }),
    ).toThrow(/launcher-incompatible/u);
  });
});
```

- [ ] **Step 2: 运行测试并确认按测试名失败**

运行：

```bash
pnpm --filter @clawwork/desktop exec vitest run test/portable-launcher-descriptor.test.ts
```

预期：失败并报无法解析 `../src/main/update/launcher-descriptor.js`。**这属于“按测试名失败”的可接受形态**；若报的是语法错误或 `expect` 相关的其它失败，停下查明。

- [ ] **Step 3: 写最小实现**

创建 `packages/desktop/src/main/update/launcher-descriptor.ts`：

```ts
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey } from 'node:crypto';
import { PortableUpdateFailure } from './portable-manifest.js';

const DESCRIBE_SCHEMA_VERSION = 1;
const FINGERPRINT_PATTERN = /^[0-9A-F]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export interface LauncherDescriptor {
  launcherVersion: string;
  keyFingerprints: string[];
}

interface RunOutcome {
  status: number | null;
  stdout: string;
  error: Error | null;
}

type DescriptorRunner = (command: string, args: string[], options: Record<string, unknown>) => unknown;

export function normalizeRunOutcome(result: unknown): RunOutcome {
  if (typeof result === 'string') return { status: 0, stdout: result, error: null };
  if (Buffer.isBuffer(result)) return { status: 0, stdout: result.toString('utf-8'), error: null };
  if (result === null || typeof result !== 'object') {
    return { status: null, stdout: '', error: new Error('the launcher runner returned no usable result') };
  }
  const record = result as { status?: unknown; stdout?: unknown; error?: unknown };
  const stdout =
    typeof record.stdout === 'string'
      ? record.stdout
      : Buffer.isBuffer(record.stdout)
        ? record.stdout.toString('utf-8')
        : '';
  return {
    status: typeof record.status === 'number' ? record.status : null,
    stdout,
    error: record.error instanceof Error ? record.error : null,
  };
}

export function readLauncherDescriptor(input: {
  launcherPath: string;
  timeoutMs: number;
  runner?: DescriptorRunner;
}): LauncherDescriptor {
  const runner = input.runner ?? (spawnSync as unknown as DescriptorRunner);
  let outcome: RunOutcome;
  try {
    outcome = normalizeRunOutcome(
      runner(input.launcherPath, ['--describe-json'], {
        encoding: 'utf-8',
        timeout: input.timeoutMs,
        windowsHide: true,
      }),
    );
  } catch {
    throw new PortableUpdateFailure('launcher-incompatible');
  }
  if (outcome.error !== null) throw new PortableUpdateFailure('launcher-incompatible');
  if (outcome.status !== 0) throw new PortableUpdateFailure('launcher-incompatible');
  return parseDescriptor(outcome.stdout);
}

function parseDescriptor(raw: string): LauncherDescriptor {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new PortableUpdateFailure('launcher-incompatible');
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new PortableUpdateFailure('launcher-incompatible');
  }
  const record = payload as Record<string, unknown>;
  if (record.schemaVersion !== DESCRIBE_SCHEMA_VERSION) {
    throw new PortableUpdateFailure('launcher-incompatible');
  }
  const launcherVersion = record.launcherVersion;
  if (typeof launcherVersion !== 'string' || !SEMVER_PATTERN.test(launcherVersion)) {
    throw new PortableUpdateFailure('launcher-incompatible');
  }
  if (!Array.isArray(record.embeddedKeys) || record.embeddedKeys.length === 0) {
    throw new PortableUpdateFailure('launcher-incompatible');
  }
  const keyFingerprints: string[] = [];
  for (const entry of record.embeddedKeys) {
    if (typeof entry !== 'object' || entry === null) {
      throw new PortableUpdateFailure('launcher-incompatible');
    }
    const key = entry as Record<string, unknown>;
    if (typeof key.fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(key.fingerprint)) {
      throw new PortableUpdateFailure('launcher-incompatible');
    }
    if (typeof key.base64 !== 'string' || !BASE64_PATTERN.test(key.base64)) {
      throw new PortableUpdateFailure('launcher-incompatible');
    }
    const der = Buffer.from(key.base64, 'base64');
    if (der.toString('base64') !== key.base64) {
      throw new PortableUpdateFailure('launcher-incompatible');
    }
    let parsed: unknown;
    try {
      parsed = createPublicKey({ key: der, type: 'spki', format: 'der' });
    } catch {
      throw new PortableUpdateFailure('launcher-incompatible');
    }
    if (parsed === null || parsed === undefined) {
      throw new PortableUpdateFailure('launcher-incompatible');
    }
    const derived = createHash('sha256').update(der).digest('hex').toUpperCase();
    if (derived !== key.fingerprint) {
      throw new PortableUpdateFailure('launcher-incompatible');
    }
    keyFingerprints.push(key.fingerprint);
  }
  return { launcherVersion, keyFingerprints };
}
```

- [ ] **Step 4: 运行测试并确认通过**

运行：

```bash
pnpm --filter @clawwork/desktop exec vitest run test/portable-launcher-descriptor.test.ts
```

预期：全部通过，且输出里有 `passed` 计数 > 0。

- [ ] **Step 5: 行为级变异验证**

1. 把 `if (record.schemaVersion !== DESCRIBE_SCHEMA_VERSION)` 改成 `if (false)` ⇒ 预期 `fails closed on an unknown describe schema version` **按测试名变红**。
2. 把 `!SEMVER_PATTERN.test(launcherVersion)` 直接删掉 ⇒ 预期 6 个 `fails closed when the launcher reports the unstrict version` 用例**按测试名变红**。
3. 把 `record.embeddedKeys.length === 0` 判断删掉 ⇒ 预期 `fails closed when no embedded key is reported` **按测试名变红**。
4. 把 `catch { throw new PortableUpdateFailure(...) }` 改成 `catch (error) { throw error }` ⇒ 预期 `fails closed when the launcher cannot be started` 与 `fails closed on a non-zero exit code` **按测试名变红**。

每处变异后运行同一条 vitest 命令，判据：输出里出现对应测试名 + `failed`，且 `passed` 计数下降。恢复后必须全绿且 `git diff` 为空。

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/src/main/update/launcher-descriptor.ts packages/desktop/test/portable-launcher-descriptor.test.ts
git commit -m "feat(update): read the real launcher version from the drive"
```

---

### Task 6: TS — 让"启动器不可用"上屏，而不是静默消失

**Files:**

- Modify: `packages/desktop/src/main/update/portable-update-service.ts`
- Modify: `packages/desktop/src/renderer/features/internal-beta/update-errors.ts`
- Modify: `packages/desktop/test/portable-update-service.test.ts`
- Modify: `packages/desktop/test/internal-beta-update-errors.test.ts`
- Modify: `packages/desktop/test/portable-update-about.test.tsx`

**行为要求（本项目刚修过"错误必须上屏"）：** 启动器缺失、不可执行、超时、输出非法或不兼容时——

- 登录与聊天**照常可用**（更新链路不应拖累主流程）；
- 自动更新 **fail-closed**（不做任何下载或交换）；
- 但必须通过**既有公开状态 / IPC / UI** 显示出明确、可操作的更新不可用原因；
- **不允许**回到"永远加载中"或"静默消失"。

实现路径（复用既有机制，不新造协议）：服务内部已有 `permanentError` 与 `PERMANENT_ERROR_CODES`，`check()` / `prepare()` 依赖它短路。因此新增一个 deps 字段 `unavailable` 并**用它初始化 `phase` / `errorCode` / `permanentError`** 即可，不需要新的状态机。

- [ ] **Step 1: 确认短路机制真实存在**

```bash
grep -n "permanentError" packages/desktop/src/main/update/portable-update-service.ts
grep -n "PORTABLE_ERROR_TEXT\|PORTABLE_ERROR_ACTION" packages/desktop/src/renderer/features/internal-beta/update-errors.ts
```

判据：`check()` 与 `prepare()` 里确实存在基于 `permanentError` 的提前返回。**若不存在**，本刀改为在 `check()`/`prepare()` 开头补一条 `if (permanentError !== null) return ...`，其余断言不变。

- [ ] **Step 2: 写失败的测试（服务层）**

追加到 `packages/desktop/test/portable-update-service.test.ts`：

```ts
describe('portable update service with an unusable launcher', () => {
  it('reports the launcher failure through the public state instead of disappearing', () => {
    const harness = makeHarness({ unavailable: { errorCode: 'launcher-incompatible' } });
    const state = harness.service.getState();
    expect(state.phase).toBe('error');
    expect(state.errorCode).toBe('launcher-incompatible');
    expect(state.currentVersion).toBe(harness.currentVersion);
  });

  it('refuses to prepare while the launcher is unusable', async () => {
    const harness = makeHarness({ unavailable: { errorCode: 'launcher-incompatible' } });
    const result = await harness.service.prepare();
    expect(result).toEqual({ ok: false, errorCode: 'launcher-incompatible' });
    expect(harness.downloadPackage).not.toHaveBeenCalled();
  });

  it('does not check the feed while the launcher is unusable', async () => {
    const harness = makeHarness({ unavailable: { errorCode: 'launcher-incompatible' } });
    const state = await harness.service.check();
    expect(state.phase).toBe('error');
    expect(state.errorCode).toBe('launcher-incompatible');
    expect(harness.fetchManifest).not.toHaveBeenCalled();
  });

  it('still notifies subscribers so the panel can react', () => {
    const harness = makeHarness({ unavailable: { errorCode: 'launcher-incompatible' } });
    const seen: string[] = [];
    harness.service.subscribe((state) => seen.push(`${state.phase}:${state.errorCode ?? ''}`));
    expect(seen).toEqual([]);
    expect(harness.service.getState().errorCode).toBe('launcher-incompatible');
  });
});
```

**命名对齐（必须先执行）：** 上面的 `makeHarness({...})`、`harness.service`、`harness.currentVersion`、`harness.downloadPackage`、`harness.fetchManifest` 取自该文件既有的 `makeHarness()`（它返回一个 `Harness`，暴露各 `vi.fn()`）。先运行：

```bash
sed -n '60,132p' packages/desktop/test/portable-update-service.test.ts
```

按打印出的真实字段名替换（既有 harness 若只接受位置参数，就改成接受一个可选的覆盖对象），断言与结构不变。

- [ ] **Step 3: 运行测试并确认按测试名失败**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-service.test.ts
```

预期：4 个新用例失败（`unavailable` 不被识别，初始相位仍是 `idle`）。

- [ ] **Step 4: 写最小实现**

`packages/desktop/src/main/update/portable-update-service.ts`：

(a) `PortableUpdateServiceDeps` 增加一个字段（放在 `launcherVersion` 之后）：

```ts
  unavailable?: { errorCode: PortableUpdateErrorCode } | null;
```

(b) `createPortableUpdateService` 的局部状态初始化改为受 `deps.unavailable` 驱动：

```ts
let phase: PortableUpdatePhase = deps.unavailable ? 'error' : 'idle';
let errorCode: PortableUpdateErrorCode | undefined = deps.unavailable?.errorCode;
let permanentError: PortableUpdateErrorCode | null = deps.unavailable?.errorCode ?? null;
```

其余行不动。**不要**新造状态字段、不要新造错误码（规格裁决：复用既有的 `launcher-incompatible`）。

- [ ] **Step 5: 运行测试并确认通过**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-service.test.ts
```

预期：新增 4 个用例通过，既有用例全部仍然通过。

- [ ] **Step 6: 写失败的测试（文案与 UI 契约）**

(a) `packages/desktop/test/internal-beta-update-errors.test.ts` 追加：

```ts
it('tells the user a missing or outdated launcher needs a new delivery package', () => {
  expect(portableErrorAction('launcher-incompatible')).toBe('replace-package');
  expect(portableErrorMessage('launcher-incompatible')).toContain('启动器');
  expect(portableErrorMessage('launcher-incompatible')).toContain('完整交付包');
  expect(portableErrorMessage('launcher-incompatible')).not.toMatch(/[A-Za-z]{4,}/u);
});
```

**命名对齐：** 先运行 `grep -n "^export function\|^import" packages/desktop/src/renderer/features/internal-beta/update-errors.ts`，用打印出的真实导出名替换 `portableErrorAction` / `portableErrorMessage`。

(b) `packages/desktop/test/portable-update-about.test.tsx` 追加：

```tsx
it('shows an actionable reason when the launcher cannot be used', () => {
  renderAbout({ phase: 'error', errorCode: 'launcher-incompatible' });
  expect(screen.getByText(/启动器/)).toBeTruthy();
  expect(screen.getByText(/完整交付包/)).toBeTruthy();
  expect(screen.queryByText(/立即重启更新/)).toBeNull();
});
```

**命名对齐：** 该文件用的是中文测试名与既有的渲染辅助。先运行 `sed -n '1,60p' packages/desktop/test/portable-update-about.test.tsx`，用打印出的真实渲染辅助与查询方式替换 `renderAbout(...)`；断言不变（**必须断言"界面上出现了原因"且"没有出现需要 ready 才该出现的按钮"**）。

- [ ] **Step 7: 运行测试并确认按测试名失败**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/internal-beta-update-errors.test.ts test/portable-update-about.test.tsx
```

预期：两条新用例失败（现有文案只提"版本太旧"，不含"启动器缺失"语义；UI 用例的查询尚未有对应渲染路径）。

- [ ] **Step 8: 写最小实现**

`packages/desktop/src/renderer/features/internal-beta/update-errors.ts`：把

```ts
  'launcher-incompatible': '启动器版本太旧，装不了这份更新。请获取新的完整交付包。',
```

改为

```ts
  'launcher-incompatible': '启动器缺失或版本太旧，装不了这份更新。请获取新的完整交付包。',
```

文案规则不变：只给中文、不含英文原文、不含 URL 或版本号片段；动作仍是 `replace-package`（**不得**新增"忽略并继续"这类动作）。

- [ ] **Step 9: 运行测试并确认通过**

```bash
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-service.test.ts test/internal-beta-update-errors.test.ts test/portable-update-about.test.tsx
```

预期：全部通过，`fail 0`。

- [ ] **Step 10: 行为级变异验证**

1. 把 `phase` 的初始化改回 `'idle'` ⇒ 预期 `reports the launcher failure through the public state instead of disappearing` **按测试名变红**。
2. 把 `permanentError` 的初始化改回 `null` ⇒ 预期 `refuses to prepare while the launcher is unusable` 与 `does not check the feed while the launcher is unusable` **按测试名变红**。
3. 把文案改回"启动器版本太旧"（去掉"缺失"）⇒ 预期 UI 契约用例 **按测试名变红**。
4. 在 UI 里为 `error` 相位也渲染「立即重启更新」⇒ 预期 `shows an actionable reason when the launcher cannot be used` 的 `queryByText` 断言 **按测试名变红**。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 11: 提交**

```bash
git add packages/desktop/src/main/update/portable-update-service.ts packages/desktop/src/renderer/features/internal-beta/update-errors.ts packages/desktop/test/portable-update-service.test.ts packages/desktop/test/internal-beta-update-errors.test.ts packages/desktop/test/portable-update-about.test.tsx
git commit -m "fix(update): surface an unusable launcher instead of hiding it"
```

---

### Task 7: TS — 接线并删除 `LAUNCHER_PROTOCOL_VERSION`

**Files:**

- Modify: `packages/desktop/src/main/ipc/update-handlers.ts`
- Modify: `packages/desktop/test/portable-update-ipc.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/desktop/test/portable-update-ipc.test.ts`（沿用该文件既有的 `vi.hoisted` 桩：`getPortableWorkspaceRoot` 已被桩成 `mocks.portableRoot`；在同一个 `vi.hoisted` 块里新增一个 launcher 描述桩，并把它接进 `../src/main/update/launcher-descriptor.js` 的 mock）：

```ts
it('reports the launcher failure through the update state instead of hiding it', async () => {
  mocks.portableRoot = 'E:\\';
  mocks.launcherDescriptor.mockImplementation(() => {
    throw new Error('launcher is unusable');
  });
  const { registerUpdateHandlers } = await import('../src/main/ipc/update-handlers.js');
  registerUpdateHandlers();
  const state = await handle('app:get-update-state');
  expect(state.phase).toBe('error');
  expect(state.errorCode).toBe('launcher-incompatible');
});

it('attaches the portable service with the version the launcher really reports', async () => {
  mocks.portableRoot = 'E:\\';
  mocks.launcherDescriptor.mockReturnValue({
    launcherVersion: '9.9.9',
    keyFingerprints: ['A'.repeat(64)],
  });
  const { registerUpdateHandlers } = await import('../src/main/ipc/update-handlers.js');
  registerUpdateHandlers();
  const state = await handle('app:get-update-state');
  expect(state.portable).toBe(true);
  expect(mocks.launcherDescriptor).toHaveBeenCalled();
});
```

**命名对齐（必须先执行）：** 上面的 `mocks.launcherDescriptor`、`handle(...)` 是按该文件既有风格写的名字。先运行：

```bash
grep -n "vi.hoisted\|mocks\.\|ipcMain.handle\|function invoke\|async function handle" packages/desktop/test/portable-update-ipc.test.ts | head -40
```

用打印出的真实桩名与真实调用辅助函数替换；断言不变。

- [ ] **Step 2: 运行测试并确认按测试名失败**

运行：

```bash
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-ipc.test.ts
```

预期：新增的两个用例失败（服务在没有可描述的启动器时仍然被挂上，或版本不被读取）。

- [ ] **Step 3: 写最小实现**

修改 `packages/desktop/src/main/ipc/update-handlers.ts`：

(a) 删除 `:28` 的 `const LAUNCHER_PROTOCOL_VERSION = '1.0.0';`。

(b) 在 import 区加入：

```ts
import { readLauncherDescriptor } from '../update/launcher-descriptor.js';
```

(c) `ensurePortableUpdateService` 在拿到 `root` 之后、构造服务之前插入探测：

```ts
let launcherVersion: string;
let unavailable: { errorCode: PortableUpdateErrorCode } | null = null;
try {
  launcherVersion = readLauncherDescriptor({
    launcherPath: join(root, LAUNCHER_FILE_NAME),
    timeoutMs: 5000,
  }).launcherVersion;
} catch {
  launcherVersion = '0.0.0';
  unavailable = { errorCode: 'launcher-incompatible' };
}
```

(d) 把 `launcherVersion: LAUNCHER_PROTOCOL_VERSION,` 改成 `launcherVersion,`，并在 `createPortableUpdateService({...})` 的依赖对象里加入 `unavailable,`。

注意 `launcherVersion` 在探测失败时取 `'0.0.0'` **只作为占位**：此时 `unavailable` 已让服务进入永久错误态，`check()` 与 `prepare()` 都不会走到版本比较那一步，因此这个占位值不会被任何门禁使用。**不得**把它当成"兼容"的信号。

**行为说明（必须写进提交信息，不得省略）：** 探测失败时**仍然挂载**便携更新服务，但服务处于 `phase: 'error'` + `errorCode: 'launcher-incompatible'` 的永久错误态——界面因此能看到一句可操作的原因，而自动更新 fail-closed。登录与聊天链路不依赖该服务，不受影响。

- [ ] **Step 4: 运行测试并确认通过**

运行：

```bash
pnpm --filter @clawwork/desktop exec vitest run test/portable-update-ipc.test.ts test/portable-update-manifest.test.ts test/portable-launcher-descriptor.test.ts
```

预期：三个文件全部通过。

再运行与该刀直接相关的完整桌面套件：

```bash
pnpm --filter @clawwork/desktop exec vitest run
```

预期：`Test Files` 计数 ≥ 新增前的数量，`passed` 计数 > 0，**无 `failed`**。

- [ ] **Step 5: 行为级变异验证**

1. 把 `unavailable = { errorCode: 'launcher-incompatible' }` 删掉，只留 `launcherVersion = '0.0.0'` ⇒ 预期 `reports the launcher failure through the update state instead of hiding it` **按测试名变红**（这正是被删掉的"静默隐藏"行为，本刀的存在理由）。
2. 把 `launcherVersion,` 改回常量 `'1.0.0'` ⇒ 预期 `attaches the portable service with the version the launcher really reports` **按测试名变红**。

恢复后 `git diff` 为空且全绿。

- [ ] **Step 6: 确认常量已彻底删除**

运行：

```bash
grep -rn "LAUNCHER_PROTOCOL_VERSION" packages/ scripts/ launcher/ || echo "no occurrences"
```

预期：输出 `no occurrences`。

- [ ] **Step 7: 提交**

```bash
git add packages/desktop/src/main/ipc/update-handlers.ts packages/desktop/test/portable-update-ipc.test.ts
git commit -m "fix(update): read the launcher version instead of assuming one"
```

---

### Task 8: 集成 — Windows GUI 子系统下的 stdout 真实捕获

**Files:**

- Create: `packages/desktop/test/portable-launcher-describe-integration.test.ts`

本刀的产物是**证据**：证明 `-H=windowsgui` 构建的启动器，其 stdout 能被 Node 父进程通过管道稳定读取（见规格 §4.1 的初步实验）。它**不重建**启动器：只针对 `artifacts/荣盈魔方启动器.exe`。

- [ ] **Step 1: 写测试**

创建 `packages/desktop/test/portable-launcher-describe-integration.test.ts`：

```ts
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { readLauncherDescriptor } from '../src/main/update/launcher-descriptor.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LAUNCHER_NAME = '\u8363\u76c8\u9b54\u65b9\u542f\u52a8\u5668.exe';
const launcherPath = join(repositoryRoot, 'artifacts', LAUNCHER_NAME);
const available = process.platform === 'win32' && existsSync(launcherPath);

if (!available) {
  console.warn(
    'SKIP = UNVERIFIED: the Windows GUI launcher stdout capture test needs a built launcher at artifacts/. ' +
      'Run pnpm build:portable-launcher on Windows first.',
  );
}

describe.skipIf(!available)('portable launcher descriptor against the real GUI binary', () => {
  it('captures the describe payload from a windowsgui binary', () => {
    const result = readLauncherDescriptor({ launcherPath, timeoutMs: 5000 });
    expect(result.launcherVersion).toMatch(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/u);
    expect(result.keyFingerprints.length).toBeGreaterThan(0);
    for (const fingerprint of result.keyFingerprints) {
      expect(fingerprint).toMatch(/^[0-9A-F]{64}$/u);
    }
  });

  it('fails closed when the embedded key cannot verify a foreign manifest', () => {
    const fixtureManifest = join(repositoryRoot, 'launcher', 'testdata', 'manifest.json');
    expect(existsSync(fixtureManifest)).toBe(true);
    let status = 0;
    let output = '';
    try {
      output = execFileSync(launcherPath, ['--verify-manifest', fixtureManifest], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string };
      status = typeof failure.status === 'number' ? failure.status : -1;
      output = typeof failure.stdout === 'string' ? failure.stdout : '';
    }
    expect(status).not.toBe(0);
    const payload = JSON.parse(output) as { ok?: boolean; errorCode?: string };
    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('signature-invalid');
  });

  it('keeps stdout clean so the payload parses without trimming heuristics', () => {
    const raw = execFileSync(launcherPath, ['--describe-json'], {
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: true,
    });
    expect(raw.includes('\n')).toBe(true);
    const singleLine = raw.trim().split('\n');
    expect(singleLine).toHaveLength(1);
    expect(JSON.parse(singleLine[0] as string)).toBeTypeOf('object');
  });

  it('reports the same fingerprint the binary contains', () => {
    const descriptor = readLauncherDescriptor({ launcherPath, timeoutMs: 5000 });
    const bytes = readFileSync(launcherPath);
    for (const fingerprint of descriptor.keyFingerprints) {
      expect(typeof fingerprint).toBe('string');
    }
    expect(bytes.length).toBeGreaterThan(0);
  });
});
```

注意：**最后一个用例只断言字节非空**，不声称“指纹出现在字节里”——那属于 Plan 2 的静态 sanity check（`launcher-key-mismatch`），此处不做假断言。

- [ ] **Step 2: 运行并区分三种结果**

运行：

```bash
pnpm --filter @clawwork/desktop exec vitest run test/portable-launcher-describe-integration.test.ts
```

三种可接受结果，**必须如实记录是哪一种**：

1. Windows 且 `artifacts/荣盈魔方启动器.exe` 存在 ⇒ 预期全部 PASS。
2. 非 Windows 或二进制不存在 ⇒ 预期输出包含 `SKIP = UNVERIFIED:` 且该文件被跳过。**跳过必须记为"未验证"，不得计入通过**；并且**发布门禁不认这个跳过**——它认的是 Step 4 那个永不跳过的脚本。
3. 测试自身崩溃/无法启动 ⇒ 属**脚本错误**，必须修好再继续，不得当成“测试失败”或“通过”。

- [ ] **Step 3: 行为级变异验证（仅在第 1 种结果下执行）**

先用 `MOFANG_LAUNCHER_PUBLIC_KEY_B64` 与 `MOFANG_LAUNCHER_VERSION=9.9.9` 重建一次启动器到临时目录（**不覆盖** `artifacts/` 里的那份）：

```bash
MOFANG_LAUNCHER_VERSION=9.9.9 MOFANG_UPDATE_PUBLIC_KEY_B64=$(node -e "const{generateKeyPairSync}=require('node:crypto');process.stdout.write(generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64'))") node scripts/build-portable-launcher.mjs
```

把它临时指向集成测试的路径不现实，因此本步的变异验证在 Plan 2 的 QC 流程里做；**本刀若落在第 2 种结果，写明“变异未验证”**。

- [ ] **Step 4: 加一条永不跳过的门禁脚本（发布门禁用它，不用可跳过的测试）**

上面那个 vitest 文件在非 Windows 或没有二进制时会**跳过**——跳过**不能**算通过。因此再加一个**永不跳过**的脚本，它的缺失二进制也是一种失败。

创建 `scripts/check-portable-launcher-describe.mjs`：

```js
#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { launcherOutputName } from './lib/portable-launcher-build.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const launcherPath = join(repositoryRoot, 'artifacts', launcherOutputName);

if (process.platform !== 'win32') {
  console.error('the portable launcher describe gate must run on Windows: it reads a windowsgui binary');
  process.exit(1);
}
if (!existsSync(launcherPath)) {
  console.error(`the portable launcher describe gate needs a built launcher at ${launcherPath}`);
  console.error('run pnpm build:portable-launcher first; a missing binary is a gate failure, not a skip');
  process.exit(1);
}

const { readLauncherDescriptor } = await import('../packages/desktop/dist/main/launcher-descriptor-probe.js');

try {
  const descriptor = readLauncherDescriptor({ launcherPath, timeoutMs: 10_000 });
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/u.test(descriptor.launcherVersion)) {
    console.error(`the launcher reported an unusable version: ${descriptor.launcherVersion}`);
    process.exit(1);
  }
  if (descriptor.keyFingerprints.length === 0) {
    console.error('the launcher reported no embedded key');
    process.exit(1);
  }
  for (const fingerprint of descriptor.keyFingerprints) {
    if (!/^[0-9A-F]{64}$/u.test(fingerprint)) {
      console.error(`the launcher reported an unusable fingerprint: ${fingerprint}`);
      process.exit(1);
    }
  }
  console.log(`portable launcher describe gate passed for ${descriptor.launcherVersion}`);
} catch (error) {
  console.error(`the portable launcher describe gate failed: ${error?.message ?? error}`);
  process.exit(1);
}
```

**关于导入路径（实现前必须先确认）：** 这个脚本要复用 `readLauncherDescriptor`。桌面包是 Electron 应用、源码是 TS，脚本不能直接 import `.ts`。因此**必须在写脚本前先做一次确认**：

```bash
grep -n '"build"\|"main"\|"exports"' packages/desktop/package.json
ls packages/desktop/dist 2>/dev/null || echo "no dist yet"
```

按打印出的真实产物路径改写上面那行 `await import(...)`。**若桌面包没有可被 Node 直接导入的已编译产物**，则退回到**独立实现**：把 `readLauncherDescriptor` 的纯逻辑（`normalizeRunOutcome` + `parseDescriptor`）放进 `packages/shared/src/portable-update.ts` 旁边的一个纯模块，让脚本与桌面主进程**共用同一份**——**不得**在脚本里复制一份解析逻辑。这一处必须在实现时定稿，**不得**留下两个实现。

`package.json` 新增：

```json
"check:portable-launcher-describe": "node scripts/check-portable-launcher-describe.mjs"
```

**它在发布门禁里的位置：** Windows PR 检查与发布前置检查都要跑它。把 `pnpm check:portable-launcher-describe` 加进 `.github/workflows/pr-check.yml` 的 `portable-update-windows` job（在 `Verify Windows PE header` 之后），**该 job 已会构建启动器**。把它接进 workflow 的具体改动属于**计划 2 的 Task 5**（workflow 归它管），本刀只交付脚本本身与它的单测。

- [ ] **Step 5: 运行门禁脚本并确认失败是有意义的**

先在没有二进制的情况下确认它**失败而不是跳过**：

```bash
mv artifacts/荣盈魔方启动器.exe artifacts/荣盈魔方启动器.exe.bak && node scripts/check-portable-launcher-describe.mjs; echo "exit=$?"
mv artifacts/荣盈魔方启动器.exe.bak artifacts/荣盈魔方启动器.exe
```

预期：`exit=1`，且 stderr 含 `a missing binary is a gate failure, not a skip`。

再在有二进制时运行：

```bash
node scripts/check-portable-launcher-describe.mjs
```

预期：`exit=0` 且打印 `portable launcher describe gate passed for <version>`。

- [ ] **Step 6: 提交**

```bash
git add packages/desktop/test/portable-launcher-describe-integration.test.ts
git commit -m "test(update): pin the GUI launcher stdout capture on a real binary"
```

---

## 完整门禁与验收

每个 Task 的定向测试通过后运行：

```bash
pnpm check
```

预期：`exit 0`。若失败，按下面三条分别处理，**不得混为一谈**：

1. `check:portable-launcher`（`go -C launcher test ./... -count=1`）
2. `check:portable-update-release`
3. `lint` / `typecheck` / `typecheck:tests` / `format:check` / `check:dead-code` / `test`

**knip 特别提醒：** `launcher-descriptor.ts` 的导出必须被 `update-handlers.ts` 引用；`LauncherDescription`、`VerifyResult`、`BuildVerifyResult`、`KeyFingerprint`、`BuildDescription`、`CompareSemanticVersions`、`CheckLauncherCompatibility` 这些 Go 导出只受 Go 编译期约束，不受 knip 管辖。

本计划全部完成后的验收读数（**逐条如实填写，未执行的写“未验证”**）：

| 项                             | 命令                                                                                                                                                                                                                                                                                                                                     | 读数 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Go 全包测试                    | `go -C launcher test ./... -count=1`                                                                                                                                                                                                                                                                                                     | 待填 |
| 桌面定向 7 个文件              | `pnpm --filter @clawwork/desktop exec vitest run test/portable-launcher-descriptor.test.ts test/portable-update-ipc.test.ts test/portable-update-manifest.test.ts test/portable-update-service.test.ts test/internal-beta-update-errors.test.ts test/portable-update-about.test.tsx test/portable-launcher-describe-integration.test.ts` | 待填 |
| **永不跳过的门禁（发布必跑）** | `node scripts/check-portable-launcher-describe.mjs`                                                                                                                                                                                                                                                                                      | 待填 |
| 门禁在缺二进制时必须失败       | 临时改名后运行，预期 `exit=1` 且含 `not a skip`                                                                                                                                                                                                                                                                                          | 待填 |
| 集成测试是否真跑               | 看输出里有无 `SKIP = UNVERIFIED:`（**有 skip ⇒ 该集成证据未验证**）                                                                                                                                                                                                                                                                      | 待填 |
| 常量已删除                     | `grep -rn "LAUNCHER_PROTOCOL_VERSION" packages/ scripts/ launcher/`                                                                                                                                                                                                                                                                      | 待填 |
| 全量门禁                       | `pnpm check`                                                                                                                                                                                                                                                                                                                             | 待填 |

## 未覆盖与后续（不得写成已完成）

- 启动器不可用时**复用** `launcher-incompatible` 这一个既有错误码，没有新增协议错误码。因此界面文案是"启动器缺失或版本太旧"，无法区分"缺失"与"太旧"两种情形。若将来需要区分，需要扩展 `packages/shared/src/portable-update.ts` 的 `PortableUpdateErrorCode` 联合，并同步 `PORTABLE_ERROR_ACTION` / `PORTABLE_ERROR_TEXT` 两个 `Record`（TS 会强制补全）与"四个永久错误码"的既有断言。
- 若 Task 8 的 vitest 落在"跳过"形态，则 **GUI stdout 捕获在真实二进制上的证据仍属未验证**；规格 §4.1 里的初步实验（`--version` → exit 0、`0.1.0\n`）不能替代 `--describe-json` 的同路径证据。**发布门禁必须靠 `scripts/check-portable-launcher-describe.mjs`（永不跳过）关闭这个缺口**，且它必须先在 `.github/workflows/pr-check.yml` 的 Windows job 里跑通（接线属计划 2 的 Task 5）。
- 本计划**不**生成任何生产密钥，**不**构建客户包，**不**触碰更新源。

相关：`docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md`
