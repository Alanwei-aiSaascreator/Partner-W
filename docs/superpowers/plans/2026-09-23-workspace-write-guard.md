# 工作区写入闸门（红线落实）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让助手的工具**写不出工作区**、工作区外的 shell 动作**必须先经用户批准**，并对**存量用户**（含用户自己那块 U 盘）同样生效。

**Architecture:** 全部落在客户端**既有的**合并点：`state-config.ts` 里已经在写 `openclaw.json` 的 `mergeToolsDefaults` + "已经一致就一个字节都不写"的提前返回判据（`:293-301`）。运行时的三个闸门是 `tools.fs.workspaceOnly` / `tools.exec.mode` / `tools.elevated.enabled`——2026.9.3 实测它们的默认值**都不设防**。

**Tech Stack:** TypeScript / Node、vitest（`packages/desktop`）、随包 openclaw 2026.9.3（只读）。

**Spec:** `docs/superpowers/specs/2026-09-23-workspace-write-guard-design.md`（唯一需求源；每条事实带 file:line）。

**工作区：** `D:\Desktop\new project\mofang-compass\mofang-compass-desktop\.worktrees\fix-local-credential-exposure`，分支 `fix/workspace-escape-guard`（基线 `f0361506`）。

---

## 通用纪律（每一刀都适用，别省）

- **TDD**：先写会红的测试 → 实跑确认它红 → 最小实现 → 实跑确认它绿。**不许先写实现**。
- **变异**：每条新守卫/接线都要有一条变异证明它必要。装置要求：锚点**恰好命中 1 次**否则拒绝执行；打印**整行 hunk**；跑完**逐字节还原**（sha256 前后一致）；记录**实跑读数**，不写预期值。
- **门禁**：`export PATH="/d/go-toolchain/go/bin:$PATH"` 再 `pnpm check`（第一步就是 Go）。
  ⚠️ **别用管道接它**（`pnpm check | tail` 会把失败翻成 `exit 0`）。正确写法：
  `pnpm check > "$TEMP/gate.txt" 2>&1 ; rc=$? ; echo "GATE_EXIT=$rc"`。
- **提交**：只 `git add` 具体文件；临时文件一律落仓库外（`$TEMP`）；不改 `.gitignore`；不降断言。
- **不碰**：0.0.26 产物、更新源、生产库、任何服务器。

---

### Task 1: 前置调查 —— 产品里有没有依赖"非交互 exec"的路径

**为什么先做这个：** `tools.exec.mode: "ask"` 在**审批通道不可达时默认拒绝**（fail-closed，运行时实测）。
cron / heartbeat / 后台任务都属于"没有交互面"⇒ 这些路径里的 shell 会**从能跑到跑不了**。
如果产品依赖它们，闸门的设计要改（而不是"上线后才发现"）。

**Files:** 只读，不改任何文件。

- [x] **Step 1: 盘客户端侧的非交互运行入口**

```bash
cd "/d/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/fix-local-credential-exposure"
grep -rn "heartbeat\|cron\|schedule" packages/desktop/src/main --include=*.ts | head -30
grep -rn "heartbeat\|cron" packages/desktop/src/renderer --include=*.ts --include=*.tsx | head -20
```

- [x] **Step 2: 盘运行时侧——这些入口能不能调 exec**

在随包运行时的文档里查 heartbeat / cron 回合的工具策略（是否本来就禁用 exec / 或走"无审批面"分支）：

```bash
R="/c/Users/29315/AppData/Roaming/@clawwork/desktop/runtime/deployed/2026.9.3-win32-x64-58ed077d9f52/node_modules/openclaw"
grep -rn "cannot wait for interactive exec approval\|initiating-platform-disabled\|initiating-platform-unsupported" "$R/docs" | head -10
grep -rn "heartbeat" "$R/docs" | grep -i "tool\|exec\|permission" | head -10
```

- [x] **Step 3: 把结论写成本计划的账本段落**

在**本文件末尾**追加一节 `## 账本（Task 1 前置调查）`，写清：① 客户端有哪些非交互入口；② 它们会不会调 exec；③ 有没有产品关键路径依赖 `exec` 在无审批面时的自动放行；④ 结论二选一：**「无依赖，按计划继续」** 或 **「有依赖 ⇒ 停下来重新决策」**（后者要写清依赖是什么、影响哪一档）。

- [x] **Step 4: 提交**

```bash
git add docs/superpowers/plans/2026-09-23-workspace-write-guard.md
git commit -m "docs(security): record the preflight on non-interactive exec paths"
```

---

### Task 2: 三个闸门 + 谓词 + 合并（TDD）

**Files:**

- Modify: `packages/desktop/src/main/runtime/state-config.ts`（`mergeToolsDefaults` 在 `:201`；新增常量与谓词挨着 `readToolsDeny` 放，`:176-205` 那一带）
- Test: `packages/desktop/test/runtime-state-config.test.ts`（新增 describe 块；**并把 `:99-103` 那条整对象断言补全**）

- [x] **Step 1: 写会红的测试**

在 `runtime-state-config.test.ts` 里（`tools.deny` 那个 describe 之后）新增：

```ts
describe('红线：工具闸门（写不出工作区 + 工作区外先问）', () => {
  /**
   * 用户 2026-09-22 拍的红线：中间产物落工作区/临时目录，绝不落桌面；外面写必须先问。
   * 运行时的三个闸门在 2026.9.3 实测**默认都不设防**：
   *   - tools.fs.workspaceOnly 默认 false（且它是 FsToolsConfig 的唯一子键，读写一起锁）
   *   - tools.exec 默认 security:"full" + ask:"off"（等于无审批）
   *   - tools.elevated 未关
   */
  it('首跑就带上三个闸门，且不写 legacy security/ask', () => {
    const res = ensureStateConfig(userDataDir);
    const raw = JSON.parse(fs.readFileSync(res.configPath, 'utf-8'));

    expect(raw.tools.fs).toEqual({ workspaceOnly: true });
    expect(raw.tools.exec).toEqual({ mode: 'ask' });
    expect(raw.tools.elevated).toEqual({ enabled: false });
  });
});
```

同时把 `:99-103` 的整对象断言补成（它是"首跑写出来的东西"的完整快照）：

```ts
expect(raw).toEqual({
  gateway: { auth: { mode: 'token', token: res.token } },
  memory: { search: { provider: 'none' } },
  tools: {
    deny: ['memory_search', 'memory_get'],
    fs: { workspaceOnly: true },
    exec: { mode: 'ask' },
    elevated: { enabled: false },
  },
});
```

- [x] **Step 2: 实跑，确认它红**

```bash
cd packages/desktop && ./node_modules/.bin/vitest run test/runtime-state-config.test.ts
```

Expected: FAIL —— 首跑那条报 `raw.tools.fs` 是 `undefined`；整对象断言那条也会红。

- [x] **Step 3: 最小实现**

在 `state-config.ts` 的 `readToolsDeny`/`hasMemoryToolsDenied` 一带加常量与谓词（**放在 `mergeToolsDefaults` 之前**）：

```ts
/**
 * 红线闸门的确切值。三个键在运行时 2026.9.3 的默认值都不设防（实测，见设计文档 §1）。
 *
 * ⚠️ `exec.mode` 是**规范键**；旧写法 `security`/`ask` 与它**不能并存**（混合策略会被运行时拒绝），
 *    所以 `mergeToolsDefaults` 在写 `mode` 时必须把同对象的 `security`/`ask` 移掉。
 */
export const TOOL_GUARD_FS_WORKSPACE_ONLY = true;
export const TOOL_GUARD_EXEC_MODE = 'ask';
export const TOOL_GUARD_ELEVATED_ENABLED = false;

/** 从（任意的）配置里挖出 `tools.fs.workspaceOnly`；不是布尔则 null。 */
export function readFsWorkspaceOnly(raw: unknown): boolean | null {
  if (!isRecord(raw)) return null;
  const tools = raw.tools;
  if (!isRecord(tools)) return null;
  const fsSection = tools.fs;
  if (!isRecord(fsSection)) return null;
  const value = fsSection.workspaceOnly;
  return typeof value === 'boolean' ? value : null;
}

/** 从（任意的）配置里挖出 `tools.exec.mode`；不是字符串则 null。 */
export function readExecMode(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const tools = raw.tools;
  if (!isRecord(tools)) return null;
  const exec = tools.exec;
  if (!isRecord(exec)) return null;
  const mode = exec.mode;
  return typeof mode === 'string' && mode.length > 0 ? mode : null;
}

/** 从（任意的）配置里挖出 `tools.elevated.enabled`；不是布尔则 null。 */
export function readElevatedEnabled(raw: unknown): boolean | null {
  if (!isRecord(raw)) return null;
  const tools = raw.tools;
  if (!isRecord(tools)) return null;
  const elevated = tools.elevated;
  if (!isRecord(elevated)) return null;
  const enabled = elevated.enabled;
  return typeof enabled === 'boolean' ? enabled : null;
}

/** 三个闸门是不是都已经是红线值（提前返回的判据之一，Task 3 接上）。 */
export function hasToolGuard(raw: unknown): boolean {
  return (
    readFsWorkspaceOnly(raw) === TOOL_GUARD_FS_WORKSPACE_ONLY &&
    readExecMode(raw) === TOOL_GUARD_EXEC_MODE &&
    readElevatedEnabled(raw) === TOOL_GUARD_ELEVATED_ENABLED
  );
}
```

把 `mergeToolsDefaults` 改成"确保并保留"（**只覆盖这三个键，别的原样**）：

```ts
/**
 * 工具段合并（纯函数）：deny 并集 + **红线三闸门**（确保并保留）。
 *
 * 与 deny 一样是"确保"而不是"没有才补"：红线是产品决定，不是用户偏好 ——
 * 用户设过 `workspaceOnly:false` 也会被改回 true（设计文档 §2.1）。
 */
export function mergeToolsDefaults(existing: Record<string, unknown> | null): Record<string, unknown> {
  const tools = existing && isRecord(existing.tools) ? existing.tools : {};
  const deny = readToolsDeny(existing) ?? [];
  const fsSection = isRecord(tools.fs) ? tools.fs : {};
  const execSection = isRecord(tools.exec) ? tools.exec : {};
  const elevatedSection = isRecord(tools.elevated) ? tools.elevated : {};

  // ⚠️ 写 `mode` 时**必须**移除旧写法：运行时会拒绝"混合策略"（mode + security/ask 并存）。
  //    `mode:"ask"` 与 `security:"allowlist" + ask:"on-miss"` 等价，所以移除是无损的。
  const execRest: Record<string, unknown> = { ...execSection };
  delete execRest.security;
  delete execRest.ask;

  return {
    ...tools,
    deny: [...new Set([...deny, ...MEMORY_TOOLS_DENIED])],
    fs: { ...fsSection, workspaceOnly: TOOL_GUARD_FS_WORKSPACE_ONLY },
    exec: { ...execRest, mode: TOOL_GUARD_EXEC_MODE },
    elevated: { ...elevatedSection, enabled: TOOL_GUARD_ELEVATED_ENABLED },
  };
}
```

- [x] **Step 4: 实跑，确认全绿**

```bash
cd packages/desktop && ./node_modules/.bin/vitest run test/runtime-state-config.test.ts
```

Expected: PASS（这一轮**只有**新增那条 + 改过的整对象断言会变绿；其余原样）。

- [x] **Step 5: 提交**

```bash
git add packages/desktop/src/main/runtime/state-config.ts packages/desktop/test/runtime-state-config.test.ts
git commit -m "feat(security): write the workspace write guard into the runtime config"
```

---

### Task 3: 存量用户判据（最容易漏的一刀）

**Files:**

- Modify: `packages/desktop/src/main/runtime/state-config.ts:293-301`（提前返回条件）
- Test: `packages/desktop/test/runtime-state-config.test.ts`

- [x] **Step 1: 写会红的测试**

```ts
it('⭐ 存量用户（token/memory/deny 都早就对了）也必须补上 —— 提前返回不能漏了它', () => {
  // 与 memory / deny 那两条同源的坑：这条提前返回是**存量用户每次启动的必经之路**。
  // 判据里漏了闸门 ⇒ token 本来就对的用户（包括用户那块 U 盘）**永远拿不到**。
  const stateDir = stateDirFor(userDataDir);
  fs.mkdirSync(stateDir, { recursive: true });
  const first = ensureStateConfig(userDataDir);

  // 模拟"这一版修复之前写下的文件"：token 对、memory 与 deny 都设过，但没有闸门
  const cfg = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
  delete cfg.tools.fs;
  delete cfg.tools.exec;
  delete cfg.tools.elevated;
  fs.writeFileSync(stateConfigPath(stateDir), JSON.stringify(cfg));

  ensureStateConfig(userDataDir);

  const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
  expect(raw.gateway.auth.token).toBe(first.token); // token 不许漂
  expect(raw.tools.fs).toEqual({ workspaceOnly: true });
  expect(raw.tools.exec.mode).toBe('ask');
  expect(raw.tools.elevated.enabled).toBe(false);
});
```

- [x] **Step 2: 实跑，确认它红**

```bash
cd packages/desktop && ./node_modules/.bin/vitest run test/runtime-state-config.test.ts -t "存量用户"
```

Expected: FAIL —— `raw.tools.fs` 是 `undefined`（提前返回跳过了写盘）。

- [x] **Step 3: 最小实现**

在提前返回条件里加一项（`state-config.ts:293-301`）：

```ts
if (
  existingToken === store.token &&
  existing &&
  readMemorySearchProvider(existing) !== null &&
  hasMemoryToolsDenied(existing) &&
  hasToolGuard(existing) &&
  (!splitState || hasPortableBootstrapDisabled(existing))
) {
  return { token: store.token, created: false, configPath, stateDir };
}
```

- [x] **Step 4: 实跑，确认全绿**

```bash
cd packages/desktop && ./node_modules/.bin/vitest run test/runtime-state-config.test.ts
```

Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add packages/desktop/src/main/runtime/state-config.ts packages/desktop/test/runtime-state-config.test.ts
git commit -m "fix(security): let existing installs receive the workspace write guard"
```

---

### Task 4: 保留 / 覆盖 / legacy / 幂等 四条

**Files:** Test: `packages/desktop/test/runtime-state-config.test.ts`（同一个 describe 块内）

- [x] **Step 1: 写四条测试**

```ts
it('用户自己的其它 tools/exec 键不被覆盖', () => {
  const stateDir = stateDirFor(userDataDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    stateConfigPath(stateDir),
    JSON.stringify({
      gateway: { auth: { mode: 'token', token: 'existing-token' } },
      memory: { search: { provider: 'none' } },
      tools: {
        deny: ['some_other_tool', 'memory_search', 'memory_get'],
        profile: 'coding',
        exec: { strictInlineEval: true },
      },
    }),
  );

  ensureStateConfig(userDataDir);

  const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
  expect(raw.tools.deny).toContain('some_other_tool');
  expect(raw.tools.profile).toBe('coding');
  expect(raw.tools.exec.strictInlineEval).toBe(true);
  expect(raw.tools.exec.mode).toBe('ask');
});

it('用户显式设过 false/"full" ⇒ 被改回红线值（always-ensure，不是 only-fill）', () => {
  const stateDir = stateDirFor(userDataDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    stateConfigPath(stateDir),
    JSON.stringify({
      gateway: { auth: { mode: 'token', token: 'existing-token' } },
      memory: { search: { provider: 'none' } },
      tools: {
        deny: ['memory_search', 'memory_get'],
        fs: { workspaceOnly: false },
        exec: { mode: 'full' },
        elevated: { enabled: true },
      },
    }),
  );

  ensureStateConfig(userDataDir);

  const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
  expect(raw.tools.fs.workspaceOnly).toBe(true);
  expect(raw.tools.exec.mode).toBe('ask');
  expect(raw.tools.elevated.enabled).toBe(false);
});

it('已有 legacy security/ask ⇒ 写 mode 时移除它们（混合策略会被运行时拒绝）', () => {
  const stateDir = stateDirFor(userDataDir);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    stateConfigPath(stateDir),
    JSON.stringify({
      gateway: { auth: { mode: 'token', token: 'existing-token' } },
      memory: { search: { provider: 'none' } },
      tools: { deny: ['memory_search', 'memory_get'], exec: { security: 'full', ask: 'off', strictInlineEval: true } },
    }),
  );

  ensureStateConfig(userDataDir);

  const raw = JSON.parse(fs.readFileSync(stateConfigPath(stateDir), 'utf-8'));
  expect(raw.tools.exec).toEqual({ strictInlineEval: true, mode: 'ask' });
  expect(raw.tools.exec.security).toBeUndefined();
  expect(raw.tools.exec.ask).toBeUndefined();
});

it('幂等：连跑两次，文件字节不变', () => {
  const first = ensureStateConfig(userDataDir);
  const bytes = fs.readFileSync(first.configPath, 'utf-8');

  const second = ensureStateConfig(userDataDir);

  expect(second.created).toBe(false);
  expect(fs.readFileSync(first.configPath, 'utf-8')).toBe(bytes);
});
```

- [x] **Step 2: 实跑四条**

```bash
cd packages/desktop && ./node_modules/.bin/vitest run test/runtime-state-config.test.ts
```

Expected: 全绿。**若"用户显式 false 被改回"那条红** ⇒ 说明合并写成了 only-fill（`??` 而不是覆盖），按 Task 2 的实现改回来。

- [x] **Step 3: 提交**

```bash
git add packages/desktop/test/runtime-state-config.test.ts
git commit -m "test(security): pin preserve, override, legacy and idempotence for the guard"
```

---

### Task 5: 变异验证（4 条 + 1 条对照，逐条实跑）

**Files:** 临时装置落仓库外（`$TEMP/guard-mutate.mjs`），**不进仓库**。

- [x] **Step 1: 写装置（落仓库外）**

`$TEMP/guard-mutate.mjs`：

```js
// 一次跑一条变异：锚点必须恰好命中 1 次、打印 hunk、跑完逐字节还原。
// 用法：node "$TEMP/guard-mutate.mjs" <源文件> <锚点> <替换文本> [测试文件]
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const [FILE, ANCHOR, REPLACEMENT, TESTFILE = 'test/runtime-state-config.test.ts'] = process.argv.slice(2);
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const before = sha(FILE);
const original = fs.readFileSync(FILE, 'utf-8');
const hits = original.split(ANCHOR).length - 1;
if (hits !== 1) {
  console.error(`ANCHOR_HITS=${hits} —— 拒绝执行（必须恰好 1 次）`);
  process.exit(2);
}
console.log(`--- hunk ---\n- ${ANCHOR}\n+ ${REPLACEMENT || '(deleted)'}\n------------`);
fs.writeFileSync(FILE, original.replace(ANCHOR, REPLACEMENT));

let rc = 0;
let out = '';
try {
  // ⚠️ 用 process.execPath + vitest.mjs：Windows 上 execFile 不解析 `.cmd` 垫片。
  out = execFileSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', TESTFILE], {
    cwd: 'packages/desktop',
    encoding: 'utf-8',
  });
} catch (error) {
  rc = error.status ?? 1;
  out = String(error.stdout ?? '') + String(error.stderr ?? '');
}

fs.writeFileSync(FILE, original);
console.log(`MUTATION_RC=${rc}`);
console.log(
  `READING=${out
    .split('\n')
    .filter((l) => /Tests\s+\d|Test Files\s+\d/.test(l))
    .join(' | ')}`,
);
console.log(`RESTORE_SHA256_EQUAL=${sha(FILE) === before}`);
```

用法（**锚点从文件里逐字复制**，不要手打）：

```bash
cd "/d/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/fix-local-credential-exposure"
SC=packages/desktop/src/main/runtime/state-config.ts
node "$TEMP/guard-mutate.mjs" "$SC" 'workspaceOnly: TOOL_GUARD_FS_WORKSPACE_ONLY' 'workspaceOnly: false'
```

- [x] **Step 2: 实跑五条，逐条记录读数**

| #      | 变异（锚点）                                                                                   | 预期红（按测试名）                                       |
| ------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| M1     | `fs: { ...fsSection, workspaceOnly: TOOL_GUARD_FS_WORKSPACE_ONLY },` ⇒ `workspaceOnly: false,` | 首跑那条 + 存量那条 + always-ensure 那条（3 条），其余绿 |
| M2     | 删提前返回里的 `hasToolGuard(existing) &&`（1 处）                                             | **只有**存量那条红                                       |
| M3     | 删 `delete execRest.security;` 与 `delete execRest.ask;`（2 行）                               | **只有** legacy 那条红                                   |
| M4     | `mode: TOOL_GUARD_EXEC_MODE` ⇒ `mode: 'full'`                                                  | 首跑那条 + always-ensure 那条（2 条）                    |
| M-CTRL | 只改一句注释里的文字（必须留绿）                                                               | 0 条红（证明这批红是真信号，不是"什么都红"）             |

**每条都要写"实跑读数"，不许照抄上表**；读数与预期不符 ⇒ 先查装置（锚点是否唯一、是否真的还原），再查代码。

- [x] **Step 3: 确认工作树干净**

```bash
git status --short   # 必须是空的
```

---

### Task 6: 门禁 + 提交（若有源码改动回来）

- [ ] **Step 1: 跑门禁**

```bash
export PATH="/d/go-toolchain/go/bin:$PATH"
cd "/d/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/fix-local-credential-exposure"
pnpm check > "$TEMP/guard-gate.txt" 2>&1 ; rc=$? ; echo "GATE_EXIT=$rc"
```

Expected: `GATE_EXIT=0`。⚠️ **别用管道**；失败要先分清是"环境"（Go 不在 PATH）还是"代码回归"。

- [ ] **Step 2: 写账本**

在本文件末尾追加 `## 账本（Task 2–6 落地与读数）`：每条测试的**名字**、每条变异的**实跑读数**、门禁的 `GATE_EXIT`。数字必须来自当场跑出来的输出。

---

### Task 7: 客户端配套确认（只读，不改代码）

**为什么：** 设计文档 §2.4 要求确认两件事 —— 审批弹窗在"命令要写工作区外"时**文案与操作可读**，
以及用户把产物**拿到工作区外**的出口（导出）在界面上**存在**。这两条不确认，红线落地后会留下"闸门拧上了但用户没有出口"的产品洞。

**Files:** 只读。

- [x] **Step 1: 审批弹窗**

```bash
cd "/d/Desktop/new project/mofang-compass/mofang-compass-desktop/.worktrees/fix-local-credential-exposure"
sed -n '1,80p' packages/desktop/src/renderer/components/ApprovalDialog.tsx
grep -rn "approval\." packages/desktop/src/renderer/i18n 2>/dev/null | head -10
```

要看：显示的是命令什么部分（`commandPreview`?）、有没有"允许一次 / 始终允许 / 拒绝"三档、拒绝是否可达。
**把看到的三点写进账本**（命令摘要字段名、三档是否存在、文案 key）。

- [x] **Step 2: 导出出口**

```bash
grep -rn "artifact:copy\|copyArtifactToDestination\|另存\|save-as\|saveAs" packages/desktop/src/renderer --include=*.ts --include=*.tsx | head -15
```

判据：界面上**有没有**用户可点的"把产物保存到工作区外"的入口。有 ⇒ 账本记下入口位置；没有 ⇒ **登记为后续项**（不塞进本期），并在账本写明"当前用户拿到工作区外文件的唯一途径是 X"。

---

### Task 8: 真运行时探针（唯一真证据；两级，先便宜后贵）

**为什么：** 单测只能钉住"我们写对了配置"。**"运行时真的把它当闸门了吗"** 与 **"写到桌面真的被拒了吗"**，只有真网关能证。
⚠️ 本 worktree **没有 `runtime-out`**（打包陷阱：worktree 里没有）；真运行时在 `D:\p4-rel\runtime-out`（`win32-x64/openclaw-runtime-2026.9.3.7z` + `node/node.exe`，**只读引用**）。

**Files:** 探针落仓库外（`$TEMP/guard-probe/`）。

- [x] **Step 1（静态，便宜且决定性）：运行时**自己**读出这三个键**

用真运行时的 CLI 对着"我们合并出来的那份配置"读回键值。这一步能抓到两类单测抓不到的事：
配置被运行时**拒绝**（键不存在 / 格式不对），或**写进去的键不是它认的那个**（例如 `askFallback` 不被识别）。

```bash
R="/c/Users/29315/AppData/Roaming/@clawwork/desktop/runtime/deployed/2026.9.3-win32-x64-58ed077d9f52/node_modules/openclaw"
PROBE="$TEMP/guard-probe"; mkdir -p "$PROBE/state"
# ① 用本计划产出的合并逻辑写一份 state（可直接复用 ensureStateConfig 的输出，手工粘一份也行）
# ② 让运行时从**这个** state 目录读
OPENCLAW_STATE_DIR="$PROBE/state" node "$R/openclaw.mjs" config get tools.fs --json
OPENCLAW_STATE_DIR="$PROBE/state" node "$R/openclaw.mjs" config get tools.exec --json
OPENCLAW_STATE_DIR="$PROBE/state" node "$R/openclaw.mjs" config get tools.elevated --json
```

（入口文件名以 `$R` 下实际存在的 CLI 入口为准；先 `ls "$R" | grep -i "mjs\|bin"` 确认。）
**判据：** 三条都能读出我们写的值；`tools.exec` 里 `askFallback` 若读不出来 ⇒ 在设计文档 §2.1 把那句"显式钉"改成"依赖默认值"，并写明实测。

**✅ 实际结果（2026-09-23 实跑，见账本）：** 三条闸门**原样读回**；而 `askFallback` **比预判更糟** ——
不是"读不出来"，是**整份配置被判非法**（`Unrecognized key: "askFallback"`）⇒ 已从实现里**移除**，
设计文档 §2.1/§4 同步改过。入口是 `openclaw.mjs`（实测）；⚠️ 给 node.exe 传路径要用 `cygpath -w`。

- [ ] **Step 2（行为，贵）：桩模型 + 真网关，写桌面必须被拒**

形态：`freshProfile`（复用 `e2e/helpers/temp-root.ts`）里造 state + 用真实编排 `bootstrapLocalGatewayRuntime` 起网关
（`e2e/runtime-e2e.test.ts:113-130` 就是这条链，`RUNTIME_OUT` 指向 `D:\p4-rel\runtime-out`）

- 一个**本地 HTTP 桩模型 provider**（OpenAI 兼容端点，回一次带 `write` 工具调用的响应，目标
  `%USERPROFILE%\Desktop\clawwork-guard-probe-<rand>.txt`）⇒ 发一条消息 ⇒ 读工具结果。

**判据（两条都要）：** ① 桌面上**没有**该文件；② 工具结果是**拒绝**（不是成功、也不是"没跑"）。
⚠️ **同一回合顺带验 shell 那条**：桩模型第二条工具调用走 `exec`（如 `echo probe`）⇒ 预期**出现审批请求**；断开审批面 ⇒ **被拒**。

⚠️ 硬边界：只用临时 profile + 桩模型；**不许**连生产 relay、不许写真实 `%APPDATA%`/`openclaw-state`、
不许动用户桌面上任何**既存**文件（探针只断言它自己命名的那个不存在）。

- [ ] **Step 3: 结论写回**

- 跑通 ⇒ 设计文档 §5.2 写"已验 + 读数"；e2e 固化**登记为后续**（不阻塞本次交付）。
- 跑不通 ⇒ 保留"**未验**"，把手工验收步骤写进账本，**明说这不算证据**；不许把静态那步的读数冒充行为证据。

---

### Task 9: 收口

- [x] **Step 1: 更新设计文档的状态段**（§4/§5.2 的"未验"逐条改成"已验 + 读数"或保留"未验"）
- [ ] **Step 2: 更新记忆**：`no-writes-outside-the-workspace`（状态：已拍未实施 ⇒ 已实施 + 提交号）、`resume-here`
- [ ] **Step 3: 向用户汇报**：三条闸门的确切值、存量用户判据、变异读数、探针结论（含"未验"的部分要明说）

---

## 账本

（各 Task 落地后把名字级读数写在这里；**没有实跑读数的数字不许写**。）

### Task 1 前置调查：产品里有没有依赖"非交互 exec"的路径（2026-09-23）

**① 客户端有哪些非交互入口**

- **cron 是用户能力，不是产品内部机制**：客户端只做 IPC 透传（`main/ipc/ws-handlers.ts:905-933` 的
  `ws:cron-list/status/add/update/remove/run/runs` → `main/ws/gateway-client.ts:1148-1174` 的 `cron.*`）。
  **全客户端搜不到任何"自己建 cron 任务"的调用点**（除透传层外 `cronAdd|cron.add` 0 命中）。
- 客户端里那个 `heartbeat` 是 **WS 健康探针**（`gateway-client.ts:1203-1213`，每 N 秒发 `health` 请求），
  **不是**运行时的 agent heartbeat。
- 但客户端**确实**往运行时配置里写了 `agents.defaults.heartbeat`（本机真实 state 文件里就有）
  ⇒ 运行时的 agent 心跳回合在这个产品里是存在的。

**②③ 它们会不会调 exec / 有没有关键路径依赖"无审批面自动放行"**

运行时文档给出了决定性的路由规则（`docs/tools/exec-approvals.md:518-527`）：

- 自动化的审批卡**只投给"已连接的审批客户端"**（Control UI / macOS·iOS·Android / 声明 `approvals` 或
  `exec-approvals` 能力的 API 客户端）；
- **有审批面连着 ⇒ 定时运行像交互运行一样等着裁决**（automations 单飞，一个 job 同时最多一张卡）；
- **没有审批面 ⇒ 立即拒绝**，并在运行的错误里说明怎么修（fail-closed）；
- 自动化里点"始终允许"**不写全局白名单**，而是铸一张**绑定到该 agent + 该 automation 的 scoped standing grant**。

⇒ **结论：「无依赖，按计划继续」**。理由：① 产品内部**没有**自动建任务/自动跑 shell 的通路；
② App 开着时用户自建的定时任务**照样能等到审批卡**，不会静默失败；③ App 关着时被拒 —— 这是红线的
fail-closed 语义、不是回归；④"始终允许"能按 job 预授权，用户有自助路径。

**④ 要登记的行为变化（不是缺陷，但必须写进交付说明）**

- 用户自建的**定时任务在 App 关闭时**若需要跑 shell，会**被拒并给出原因**（今天是能跑的）。
- 运行时 agent 心跳回合里的 shell 同理。
  ⇒ 登记为**后续文案/手册项**（不是本期的代码任务）。

### Task 2–5 落地与读数（2026-09-23）

**测试名字级读数**（跑法：`cd packages/desktop && ./node_modules/.bin/vitest run test/runtime-state-config.test.ts`）

| 时点                           | 实跑读数                                  | 红名单（按名）                                                                                           |
| ------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Task 2 Step 2（实现前）        | `2 failed \| 28 passed (30)`              | `首跑：建 openclaw.json，token 是 32 字节的 base64url`；`首跑就带上三个闸门，且不写 legacy security/ask` |
| Task 2 Step 4（实现后）        | `30 passed (30)`                          | —                                                                                                        |
| Task 3 Step 2（`-t 存量用户`） | `1 failed \| 2 passed \| 28 skipped (31)` | `⭐ 存量用户（token/memory/deny 都早就对了）也必须补上`（另两条同名过滤命中的是 memory/deny 那两条，绿） |
| Task 3 Step 4                  | `31 passed (31)`                          | —                                                                                                        |
| Task 4                         | `35 passed (35)`                          | —（+4 条）                                                                                               |

**变异读数（第二纪元：`askFallback` 移除之后）** —— 装置 `$TEMP/guard-mutate.mjs`，每条都 `RESTORE_SHA256_EQUAL=true`：

| #      | 变异                                                         | 实跑读数                     | 与计划的差                                                                   |
| ------ | ------------------------------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------- |
| M1     | `workspaceOnly: true` ⇒ `false`                              | `4 failed \| 31 passed (35)` | 计划写 3 条 ⇒ 实测 4 条（整对象快照那条也钉着它）                            |
| M2     | 删提前返回里的 `hasToolGuard(existing) &&`                   | `4 failed \| 31 passed (35)` | 计划写"只有存量那条" ⇒ 实测 4 条（那三条的夹具**也是**"已经一致"的存量配置） |
| M3     | 删 `delete execRest.security/ask` 两行                       | `1 failed \| 34 passed (35)` | 与计划一致（只有 legacy 那条）                                               |
| M4     | `mode` `'ask'` ⇒ `'full'`                                    | `6 failed \| 29 passed (35)` | 计划写 2 条 ⇒ 实测 6 条                                                      |
| M-CTRL | `[...new Set(...)]` ⇒ `Array.from(new Set(...))`（等价重写） | `35 passed`（0 红）          | 与计划一致 ⇒ 上面那批红是真信号                                              |

**⚠️ M4 的第一次读数是"空"（本刀最值得记的一次）**：移除 `askFallback` 后那一行变成
`exec: { ...execRest, mode: TOOL_GUARD_EXEC_MODE },` ⇒ 旧锚点 `mode: TOOL_GUARD_EXEC_MODE,`
**不再是文件里的子串** ⇒ 装置拒跑（`ANCHOR_HITS=0`），而我把 stderr 重定向掉了 ⇒ 看到的是**空读数**。
⭐ **空读数与"变异存活"长得一模一样** ⇒ 纪律：装置拒跑必须在**可见通道**留痕；拿到空读数先查装置，别当结论。

**装置自身的一处修正**：读汇总前先剥 ANSI（`Tests` 后面插着颜色码 ⇒ `/Tests\s+\d/` 匹配不到，
读数会变成空串）。计划里的草稿没有这一步。

### Task 6 门禁读数

⬜ 已启动（`pnpm check`，`export PATH="/d/go-toolchain/go/bin:$PATH"`，重定向取 RC）—— **读数待回填**。

### Task 7 客户端配套确认（只读，✅）

- **审批弹窗**（`src/renderer/components/ApprovalDialog.tsx`）：显示 **`request.command`（完整命令）** + `cwd` + `host`；
  三档**都在**（`deny`＝危险按钮 / `allow-always` / `allow-once`）；120 秒倒计时 + 进度条；模态（禁 outside-click 与 Esc）；
  多条排队时显示剩余条数。文案 key 前缀 `approval.*`。
- **T7-F1（登记，非本期修）**：弹窗**无条件**渲染"始终允许"，**从不读**运行时给的
  `allowedDecisions` / `unavailableDecisions`（载荷里**有**这两个字段）⇒ 在 `ask:"always"` 或一次性场景下
  运行时会把它放进 unavailable 集，用户仍能看到并点它（点了不生效）。**不是本刀引入的**，
  但本刀让这个弹窗出现得更频繁 ⇒ 登记。
- **导出出口存在且端到端接好**：`ArtifactCard.tsx:135-143`（"另存为"）→ preload `artifact:save-as`
  （`preload/index.ts:162`）→ main `artifact-handlers.ts:109` → `dialog.showSaveDialog`（**用户显式选落点**）
  → `copyArtifactToDestination`。⇒ 硬闸不会让用户拿不到产物。

### Task 8 静态级探针（✅ 已做，2026-09-23）

命令（真运行时 CLI、临时 state、**无服务器、无端口**）：

```bash
R=".../node_modules/openclaw"
CLI="$(cygpath -w "$R/openclaw.mjs")"           # ⚠️ 给 node.exe 传路径必须 cygpath -w，POSIX 路径会 MODULE_NOT_FOUND
STATE="$(cygpath -w "$TEMP/guard-probe/state")"
OPENCLAW_STATE_DIR="$STATE" node "$CLI" config get tools --json
```

读数：`tools.fs` ⇒ `{"workspaceOnly":true}`、`tools.exec` ⇒ `{"mode":"ask"}`、
`tools.elevated` ⇒ `{"enabled":false}` —— **三条原样读回**；
带 `askFallback` 的那版 ⇒ `cli_error: OpenClaw config is invalid` + `Unrecognized key: "askFallback"`。

⚠️ 本探针的 state 文件是**手写**成"测试钉住的那份合并输出"的字节（不是拿客户端代码生成的）。
它证明的是"**运行时认得这三个键、且不拒收**"，**不是**行为上真的拦住了 —— 行为级（Task 8 Step 2）**仍未做**。
