# 分支地图（同事协作版）

> **English summary:** Two repos (this client repo + the sibling backend repo). Our product trunk is
> `fix/local-credential-exposure` — there is **no** `master`/`main` trunk here. Branch off the trunk, push to
> Gitee `origin` (never `upstream`), and always bypass the local git proxy (see §5). 0.0.26 artifacts are frozen.

**快照时间**：2026-09-23 · **值都会变**，动手前用 §5 的命令自己读一遍，别照抄本表里的 SHA。

---

## 1. 两个仓，不是一个

| 仓                 | 路径                                                 | 远端                                         | 装什么                                      |
| ------------------ | ---------------------------------------------------- | -------------------------------------------- | ------------------------------------------- |
| **客户端**（本仓） | `D:\Desktop\new project\partner-w\partner-w-desktop` | `origin` = Gitee `diguade/partner-w-desktop` | Electron 应用、运行时加载器、U 盘便携逻辑   |
| **后端**           | `..\`（同级目录 `partner-w`）                        | `origin` = Gitee `diguade/partner-w-backend` | `supabase/` 迁移、relay、发卡脚本、运营后台 |

⚠️ **本仓没有 `supabase/`** —— 找迁移/RLS/RPC 一律去后端仓，别在本仓里搜不到就以为不存在。

- `upstream` = GitHub `clawwork-ai/clawwork`（**上游项目，只读**；`git remote -v` 里它也有 push URL，别推）。
- `CONTRIBUTING.md` 与 `docs/agent-rules/` 里写的 "main" 是**上游的**约定；本仓的产品主线不叫 main。

## 2. 产品主线 = `fix/local-credential-exposure`

**一切新工作都从它切**：

```bash
cd "D:\Desktop\new project\partner-w\partner-w-desktop"
git worktree add .worktrees/<主题> -b fix/<主题> fix/local-credential-exposure
```

- `.worktrees/` 已被 `.gitignore` 覆盖 ⇒ 工作树本身永远不会被误提交。
- 快照时的主线指针是 **608882ff**；本文件由它之后的 `bbb4b8a7` 引入（即地图写的就是那一刻）。

## 3. 分支全表（本地 / Gitee）

| 分支                               | 尖端       | 与主线的关系                | 它是什么                                                              |
| ---------------------------------- | ---------- | --------------------------- | --------------------------------------------------------------------- |
| `fix/local-credential-exposure`    | `608882ff` | —                           | **产品主线**（0.0.26 之后的收口线）                                   |
| `fix/workspace-escape-guard`       | `4ae2c92f` | 主线 +12（可快进）          | 红线：三道工具闸门（fs 工作区锁 / exec 问询 / elevated 关）+ 存量迁移 |
| `fix/team-agent-directory-refresh` | `57c665f6` | 主线 +11（可快进）          | 装完团队先强刷助手目录再报成功                                        |
| `fix/stats-scope-labels`           | `bc4917a0` | 主线 +4（可快进）           | 统计页每个数字都带口径（本机 / 账号）                                 |
| `feat/assistant-task-workbench`    | `dadadac1` | 主线独有 239 / 它独有 1     | **开发线**（最近任务侧栏、语音权限等）；⚠️ 分叉已久，别整条合         |
| `build-0.0.23`                     | `58aaab35` | 主线独有 303 / 它独有 6     | 老构建线，仅留档                                                      |
| `feat/stage3b-demo-polish`         | `9623a44c` | 主线独有 596 / 它独有 **0** | **已完全包含在主线里**（是主线的祖先）⇒ 当废线看，别再往上提交        |
| `feat/demo-main-path`              | `3645d8a5` | 早于上述各线                | 演示主路径（历史）                                                    |
| `main`                             | `2906e773` | 上游线                      | 上游同步用，**不代表我们的产品**                                      |

⚠️ **只有本地、Gitee 上没有的**：`backup/internal-beta-ui-20260916`、`feat/local-file-artifact-loop`（后者的工作树就是开发线所在处）。要留给别人就得推。

## 4. 发版相关（版本线：0.0.26 已冻结 · 当前 **0.0.34 已发 internal**）

- **0.0.26 已冻结**：标签 `udisk-0.0.26` → `871675be`（annotated，已推 Gitee）；
  交付夹 `D:\Desktop\Partner-W生成outpu\Partner-WU盘交付-0.0.26\`（196 文件 / 781 MB）。
- **当前在测试频道 internal 上的是 `0.0.34`**（2026-09-26 发布，`integration/p0` @ `93f08b20`）：
  - 候选产物（含 `PROVENANCE.md` / `SHA256SUMS.txt`）= `D:\Desktop\Partner-W生成outpu\0.0.34-internal-candidate\`；
  - 线上 `/updates/internal/manifest.json` 的 sha256 = `68c4c341…`，与候选目录里那份**逐字节相同**；
  - `minLauncherVersion = 0.0.28`（= 盘上那把启动器，`--version` 当场跑过）；
  - 前面的 `0.0.28 / 0.0.29 / 0.0.30 / 0.0.31 / 0.0.32 / 0.0.33` 候选目录都还在，**回滚材料，别删别动**。
  - **`stable` 与 `beta` 目录仍然 404**，`/updates/latest.yml` 仍指 0.0.23（那是**装机版**的更新源，与便携链无关）。
- ⚠️ **便携态的可见性**：客户端默认频道是 `stable`，而 internal 只在**频道设成 `beta`** 时可见
  （`packages/desktop/src/main/ipc/update-handlers.ts`：`beta → internal`，其余 → `stable`）。
  所以"发了 internal"≠"盘上立刻能看到"。
- ⚠️ **发布用的 SSH 是 `root@47.119.120.28`**（`--host` 要带 `root@`）。
  只写 IP 会退化成 `29315@` ⇒ `Permission denied (publickey)`。
- **当前版本号在 `packages/desktop/package.json`**（唯一一处；根 `package.json` 没有 `version`）。
  ⛔ 发新版必须**升号**：`portable-manifest.ts` 的判据是 `compareSemanticVersions(manifest.version, currentVersion) <= 0`
  ⇒ **同版本号不算更新**，用 0.0.34 覆盖 0.0.34 谁都不动。
- **构建必须从 `D:\p4-rel` 这种短路径检出跑**（worktree 路径 >260 字符 ⇒ NSIS 必挂；
  且 worktree 没有 `runtime-out` ⇒ `beforePack` 硬失败），且**要 `build:win` 不是 `--dir`**
  （`--dir` 少 `resources/app-update.yml` 与 `resources/elevate.exe`，而前者正是更新检查要读的）。
  详见 `docs/runbooks/portable-update-release.md` 第 1 步。
- 另有几个裸检出 `D:\mfbuild`、`D:\mfr025b/c/d`：**只用于构建，别在里面提交**。

## 5. 本机推拉的三条硬规矩

```bash
# ① 全局 git 代理会掐断网络操作 ⇒ 每次都要绕（fetch/push/ls-remote 同理）
git -c http.proxy= -c https.proxy= push -u origin <分支>

# ② 查"远端到底有没有这个分支"要用 ls-remote ——
#    git rev-parse --verify origin/<b> 只测**本地跟踪引用**，会给你假结论
git -c http.proxy= -c https.proxy= ls-remote --heads origin

# ③ 所有 git 文本用英文（提交信息 / PR 标题 / 分支名；docs/agent-rules/git-conventions.md 第 0 条）
```

⚠️ **写含 `D:/...` 的提交/标签信息时加 `MSYS_NO_PATHCONV=1`**：Git Bash 会把 `D:/p4-rel` 改写成
`D;F:\Program Files\Git\p4-rel`（实测发生在 0.0.26 标签正文上，已改正）。路径被改写的东西是**永久记录**。

## 6. 提交纪律（踩过的都在这）

- **别 `git add -A`**、别把临时文件写进仓（脚本用 `mktemp`，收尾用 `;` 不用 `&&`）。只 `git add` 具体文件。
- **别动 `.gitignore`**；`.gitattributes` 已把换行统一成 LF ⇒ 提交前先 `prettier --write` 你改过的文件（autocrlf 会让内容对不上）。
- **不进仓**：真实口令 / token / host-key 指纹、审计日志、构建产物。
- 每个改动都要有**按名钉住的测试**，并且至少一条变异能证明它（本项目的既有纪律，见各刀账本）。
- 提交信息结尾署名：`Co-Authored-By: Claude Code <noreply@anthropic.com>`。

## 7. 各刀的账本在哪

`docs/superpowers/plans/` 下：`2026-09-23-workspace-write-guard.md`（红线）、
`2026-09-23-team-agent-directory-refresh.md`（团队）、`2026-09-23-stats-scope-labels.md`（统计页）、
`2026-09-22-portable-feed-uploader.md`（feed 上传器）。每份都含：判据、按名测试、变异读数、门禁读数、未做项。

## 8. 别人留下的、还没收尾的东西（别当成你的）

- 主检出（`feat/stage3b-demo-polish`）有 **9 个 locale 文件未提交** —— 不是本线的工作，别提交也别还原。
- 后端仓有 **3 项未跟踪**（一份 Codex 接管说明、`partner-w`、`open-source-agent-references/`）—— 未处置。
