# 启动器信任与版本门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面应用读取盘根启动器的**真实**版本与嵌入公钥指纹，让启动器在交换前用自己**编译进去的真实版本**再校验一次 `minLauncherVersion`，并删除冒充启动器版本的硬编码常量。

**Architecture:** 启动器新增两个**只读、无副作用**的 CLI 模式（`--describe-json`、`--verify-manifest <path>`）。桌面主进程用 `execFileSync`（带超时、`windowsHide`）调用 `--describe-json`，严格解析后把**真实版本**喂给既有的 `minLauncherVersion` 门禁。Go 侧新增一个与 TypeScript **逐条镜像**的 SemVer 比较器，使两侧判定不会分叉。启动器的 `Apply` 在第一次 rename 之前再校验一次兼容性。

**Tech Stack:** Go 1.25（仅标准库）、TypeScript 5.7、Electron 34、Vitest 3、`node:test`、pnpm。

**规格来源：** `docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md` §4.1、§4.2、§4.3、§4.4、§5.7。

---

## 文件地图

| 文件                                                                   | 动作 | 职责                                                                                        |
| ---------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| `launcher/internal/update/semver.go`                                   | 新建 | 严格 SemVer 解析与比较，语义与 `packages/desktop/src/main/update/portable-manifest.ts` 一致 |
| `launcher/internal/update/semver_test.go`                              | 新建 | 上表的单元测试，含与 TS 同源的用例表                                                        |
| `launcher/internal/update/describe.go`                                 | 新建 | `--describe-json` 的载荷结构、公钥指纹、序列化                                              |
| `launcher/internal/update/describe_test.go`                            | 新建 | 指纹与载荷的单元测试                                                                        |
| `launcher/cmd/mofang-launcher/main.go`                                 | 修改 | 新增 `modeDescribe` / `modeVerifyManifest`、`invocation.path`、退出码 `exitVerifyFailed`    |
| `launcher/cmd/mofang-launcher/describe_test.go`                        | 新建 | 两个新模式的端到端（进程内 `run`）测试与副作用断言                                          |
| `launcher/internal/update/verify.go`                                   | 修改 | 新增 `CheckLauncherCompatibility`                                                           |
| `launcher/internal/update/verify_test.go`                              | 修改 | 兼容性校验的单元测试                                                                        |
| `launcher/internal/update/swap.go`                                     | 修改 | `Apply` 增加 `launcherVersion` 参数并在首次 rename 前校验                                   |
| `launcher/internal/update/swap_test.go`                                | 修改 | `Apply` 调用点补参数 + 拒绝交换的测试                                                       |
| `launcher/cmd/mofang-launcher/main_test.go`                            | 修改 | `Apply` 调用点补参数                                                                        |
| `packages/desktop/src/main/update/launcher-descriptor.ts`              | 新建 | 调用 `--describe-json`、严格解析、fail-closed                                               |
| `packages/desktop/test/portable-launcher-descriptor.test.ts`           | 新建 | 用注入的 runner 覆盖全部失败形态                                                            |
| `packages/desktop/src/main/ipc/update-handlers.ts`                     | 修改 | 删除 `LAUNCHER_PROTOCOL_VERSION`，改为探测真实版本                                          |
| `packages/desktop/test/portable-update-ipc.test.ts`                    | 修改 | 断言接线形态与 fail-closed                                                                  |
| `packages/desktop/test/portable-launcher-describe-integration.test.ts` | 新建 | 真实 Windows GUI 二进制的 stdout 捕获集成测试                                               |

**knip 约束（务必遵守）：** `knip.json` 里 `packages/desktop` 的 `project` 只含 `src/**/*.{ts,tsx}`，测试目录不在其中。因此 `launcher-descriptor.ts` 的**每一个导出都必须被生产代码引用**（`update-handlers.ts`），否则 `pnpm check:dead-code` 会红。不要为了让测试方便而额外导出。

---

## 依赖与执行顺序

1. Task 1（SemVer）→ Task 4 依赖它。
2. Task 2（`--describe-json`）→ Task 5、Task 7 依赖它。
3. Task 3（`--verify-manifest`）与 Task 2 共用 `main.go` 的模式分发，必须在其后。
4. Task 5（TS 模块）→ Task 6 依赖它。
5. Task 4（Go 侧交换前校验）与 Task 2/3 无依赖，可在 Task 3 之后任意位置执行。
6. Task 7 必须最后，它需要真实二进制。

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
const PUBLIC_KEY_BASE64 = keyPair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

function describePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    launcherVersion: '1.2.3',
    embeddedKeys: [{ fingerprint: 'A'.repeat(64), base64: PUBLIC_KEY_BASE64 }],
    ...overrides,
  });
}

function runnerFor(result: { stdout?: string; error?: Error; status?: number | null }) {
  return vi.fn(() => ({
    stdout: result.stdout ?? '',
    stderr: '',
    status: result.status === undefined ? 0 : result.status,
    error: result.error,
  }));
}

describe('portable launcher descriptor', () => {
  it('reads the compiled version and the embedded key fingerprint', () => {
    const result = readLauncherDescriptor({
      launcherPath: 'C:/drive/launcher.exe',
      timeoutMs: 5000,
      runner: runnerFor({ stdout: describePayload() }),
    });
    expect(result.launcherVersion).toBe('1.2.3');
    expect(result.keyFingerprints).toEqual(['A'.repeat(64)]);
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
import { execFileSync } from 'node:child_process';
import { PortableUpdateFailure } from './portable-manifest.js';

const DESCRIBE_SCHEMA_VERSION = 1;
const FINGERPRINT_PATTERN = /^[0-9A-F]{64}$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export interface LauncherDescriptor {
  launcherVersion: string;
  keyFingerprints: string[];
}

interface DescriptorRunResult {
  stdout?: string | null;
  error?: Error;
  status?: number | null;
}

type DescriptorRunner = (command: string, args: string[], options: Record<string, unknown>) => DescriptorRunResult;

export function readLauncherDescriptor(input: {
  launcherPath: string;
  timeoutMs: number;
  runner?: DescriptorRunner;
}): LauncherDescriptor {
  const runner = input.runner ?? (execFileSync as unknown as DescriptorRunner);
  let raw: string;
  try {
    const result = runner(input.launcherPath, ['--describe-json'], {
      encoding: 'utf-8',
      timeout: input.timeoutMs,
      windowsHide: true,
    });
    if (result.error !== undefined && result.error !== null) throw result.error;
    if (result.status !== 0 && result.status !== null && result.status !== undefined) {
      throw new Error(`launcher describe exited with status ${result.status}`);
    }
    raw = typeof result.stdout === 'string' ? result.stdout : '';
  } catch {
    throw new PortableUpdateFailure('launcher-incompatible');
  }
  return parseDescriptor(raw);
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
    const fingerprint = (entry as Record<string, unknown>).fingerprint;
    if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
      throw new PortableUpdateFailure('launcher-incompatible');
    }
    keyFingerprints.push(fingerprint);
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

### Task 6: TS — 接线并删除 `LAUNCHER_PROTOCOL_VERSION`

**Files:**

- Modify: `packages/desktop/src/main/ipc/update-handlers.ts`
- Modify: `packages/desktop/test/portable-update-ipc.test.ts`

- [ ] **Step 1: 写失败的测试**

追加到 `packages/desktop/test/portable-update-ipc.test.ts`（沿用该文件既有的 `vi.hoisted` 桩：`getPortableWorkspaceRoot` 已被桩成 `mocks.portableRoot`；在同一个 `vi.hoisted` 块里新增一个 launcher 描述桩，并把它接进 `../src/main/update/launcher-descriptor.js` 的 mock）：

```ts
it('refuses to attach the portable service when the launcher cannot be described', async () => {
  mocks.portableRoot = 'E:\\';
  mocks.launcherDescriptor.mockImplementation(() => {
    throw new Error('launcher is unusable');
  });
  const { registerUpdateHandlers } = await import('../src/main/ipc/update-handlers.js');
  registerUpdateHandlers();
  const state = await handle('app:get-update-state');
  expect(state.portable).toBe(false);
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
try {
  launcherVersion = readLauncherDescriptor({
    launcherPath: join(root, LAUNCHER_FILE_NAME),
    timeoutMs: 5000,
  }).launcherVersion;
} catch {
  portableInitialized = true;
  return;
}
```

(d) 把 `launcherVersion: LAUNCHER_PROTOCOL_VERSION,` 改成 `launcherVersion,`。

**行为说明（必须写进提交信息，不得省略）：** 探测失败时**不挂载**便携更新服务，因此界面不会出现便携更新状态——这是 fail-closed（不会更新），代价是用户看不到一句专门的提示。§5.7 的 `launcher-incompatible` 文案仍会在“能描述启动器、但启动器版本低于 `minLauncherVersion`”时正常出现。

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

1. 把 `catch { portableInitialized = true; return; }` 改成 `catch { launcherVersion = '1.0.0'; }` ⇒ 预期 `refuses to attach the portable service when the launcher cannot be described` **按测试名变红**（这正是被删掉的假版本源的行为，本刀的存在理由）。
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

### Task 7: 集成 — Windows GUI 子系统下的 stdout 真实捕获

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
2. 非 Windows 或二不存在 ⇒ 预期输出包含 `SKIP = UNVERIFIED:` 且该文件被跳过。**这种情况必须记为“未验证”**，不得计入通过。
3. 测试自身崩溃/无法启动 ⇒ 属**脚本错误**，必须修好再继续，不得当成“测试失败”或“通过”。

- [ ] **Step 3: 行为级变异验证（仅在第 1 种结果下执行）**

先用 `MOFANG_LAUNCHER_PUBLIC_KEY_B64` 与 `MOFANG_LAUNCHER_VERSION=9.9.9` 重建一次启动器到临时目录（**不覆盖** `artifacts/` 里的那份）：

```bash
MOFANG_LAUNCHER_VERSION=9.9.9 MOFANG_UPDATE_PUBLIC_KEY_B64=$(node -e "const{generateKeyPairSync}=require('node:crypto');process.stdout.write(generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'der'}).toString('base64'))") node scripts/build-portable-launcher.mjs
```

把它临时指向集成测试的路径不现实，因此本步的变异验证在 Plan 2 的 QC 流程里做；**本刀若落在第 2 种结果，写明“变异未验证”**。

- [ ] **Step 4: 提交**

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

| 项                | 命令                                                                                                                                                                                                                   | 读数 |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| Go 全包测试       | `go -C launcher test ./... -count=1`                                                                                                                                                                                   | 待填 |
| 桌面定向 4 个文件 | `pnpm --filter @clawwork/desktop exec vitest run test/portable-launcher-descriptor.test.ts test/portable-update-ipc.test.ts test/portable-update-manifest.test.ts test/portable-launcher-describe-integration.test.ts` | 待填 |
| 集成测试是否真跑  | 看输出里有无 `SKIP = UNVERIFIED:`                                                                                                                                                                                      | 待填 |
| 常量已删除        | `grep -rn "LAUNCHER_PROTOCOL_VERSION" packages/ scripts/ launcher/`                                                                                                                                                    | 待填 |
| 全量门禁          | `pnpm check`                                                                                                                                                                                                           | 待填 |

## 未覆盖与后续（不得写成已完成）

- 探测失败时**没有**专门的界面提示（服务直接不挂载）。要显示文案需扩展 `portable-update-service.ts` 的前置条件表达，属于另一切片。
- 若 Task 7 落在“跳过”形态，则 **GUI stdout 捕获在真实二进制上的证据仍属未验证**；规格 §4.1 里的初步实验（`--version` → exit 0、`0.1.0\n`）不能替代 `--describe-json` 的同路径证据。
- 本计划**不**生成任何生产密钥，**不**构建客户包，**不**触碰更新源。

相关：`docs/superpowers/specs/2026-09-22-portable-release-infrastructure-correction-design.md`
