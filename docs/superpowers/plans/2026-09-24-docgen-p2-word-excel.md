# 文档生成 P2（Word / Excel）—— 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让助手除了 `.pptx` 还能产出真 `.docx` 与 `.xlsx` —— 同一条通道（回复里的 `docgen` 块 → 客户端渲染 → 现成产物链），不新增 UI / 表 / 事件。

**Architecture:** `kind` 从闭集 `['pptx']` 扩成 `['pptx','docx','xlsx']`，请求契约仍是**一个纯函数**（`main/docgen/request.ts`，可穷举测试）。渲染层按格式拆文件（`render-pptx.ts` / `render-docx.ts` / `render-xlsx.ts`），`render.ts` 只做按 `kind` 分发 —— 于是"契约"、"排版"、"分发"三层各自可独立定位故障。

**Tech Stack:** TypeScript / `docx@9.7.2` / `exceljs@4.4.0`（都纯 JS、无原生依赖）/ vitest / yauzl 解包断言

**依据 spec:** `docs/superpowers/specs/2026-09-24-local-docgen-design.md`（§5 的 P2 行；§9 是 P1 落地记录）

**纪律（本仓踩出来的）：**

- 客户端测试放 `packages/desktop/test/`；跑单文件先 `cd packages/desktop`。
- 每刀 TDD：RED → GREEN → **变异验证** → 门禁 → 独立提交（提交文案**英文**）。
- `pnpm check` 前 `export PATH="/d/go-toolchain/go/bin:$PATH"`；本工作树 `format:check` 是**真信号**。
- 临时文件不写进仓库、不 `git add -A`、不降断言。
- ⛔ 本次**不发版、不打更新包、不动 feed / `latest.yml` / `/updates`**；不推远端（等用户发话）。

---

## 契约（先定死，代码照这个写）

```jsonc
// pptx（P1，已存在）
{ "kind": "pptx", "title": "…", "subtitle": "…", "slides": [{ "title": "…", "bullets": ["…"], "notes": "…" }] }

// docx（新）
{ "kind": "docx", "title": "…", "sections": [{ "heading": "…", "paragraphs": ["…"], "bullets": ["…"] }] }

// xlsx（新）
{ "kind": "xlsx", "title": "…", "sheets": [{ "name": "…", "rows": [["文本", 1200, true]] }] }
```

`title` 三种 kind 都必填（它同时是**文件名**的词干）。

---

### Task 1: 契约扩三种 kind

**Files:** Modify `packages/desktop/src/main/docgen/request.ts`
**Test:** Modify `packages/desktop/test/docgen-request.test.ts`；Create `docgen-request-docx.test.ts` / `docgen-request-xlsx.test.ts`

- [x] `DOCGEN_KINDS = ['pptx','docx','xlsx']`；`DocgenRequest` 变成判别联合（`DocgenPptxRequest | DocgenDocxRequest | DocgenXlsxRequest`）。
- [x] 每种 kind 各自的校验分支 + 各自的 `DOCGEN_LIMITS`（pptx 的上限**一个都不许变**）。
- [x] docx：`sections` 非空；每条 `heading?`（≤120）、`paragraphs[]`（空串丢）、`bullets[]`（空串丢）；**全文都空 ⇒ 拒**（别产空白文档）。
- [x] xlsx：`sheets` 非空；`name` 必填、≤31 字、不含 `[]:*?/\`、**同名（忽略大小写）⇒ 拒**（Excel 会判文件要修复）；`rows[][]` 单元 = 字符串/数字/布尔；全空行丢；全空表 ⇒ 拒。
- [x] 上限：docx `maxSections 40 / maxParagraphsPerSection 60 / maxBulletsPerSection 40 / maxParagraphChars 2000`；xlsx `maxSheets 12 / maxRowsPerSheet 2000 / maxColumnsPerSheet 50 / maxCellChars 1000`。
- [x] `DOCGEN_OUTPUT_BY_KIND`：kind ⇒ `{ extension, fallbackStem }`（`演示文稿` / `文档` / `表格`）—— 文件名与产物扩展名的**唯一真源**。

### Task 2: 渲染层拆三种 + 分发

**Files:** `git mv render.ts render-pptx.ts`；Create `render.ts`（分发）/ `render-docx.ts` / `render-xlsx.ts`
**Test:** `git mv docgen-render.test.ts docgen-render-pptx.test.ts`；Create `docgen-render-docx.test.ts` / `docgen-render-xlsx.test.ts` / `docgen-render-dispatch.test.ts`

- [x] `renderDocument(request)` 按 `kind` 分发（穷尽性检查，不许静默返回空 buffer）。
- [x] docx：解包看 `word/document.xml`；**`w:eastAsia` 必须显式写上**（只写 `font.name` 时 WPS 会用西文字体渲染中文 —— `cn-docx-writer` 的教训）；正文/标题/要点文字真的在；负对照。
      ⚠️ 后半句对本库**不成立**，见「执行期发现」第 1 条。
- [x] xlsx：解包看 `xl/worksheets/sheet1.xml`（+ `workbook.xml` 的表名）；表名/文本/数字（数字必须还是数字，不是字符串）真的在；负对照。

### Task 3: 落盘层三种 kind

**Files:** Modify `packages/desktop/src/main/docgen/generate.ts`、`packages/desktop/src/main/ipc/data-handlers.ts`
**Test:** Modify `packages/desktop/test/docgen-generate.test.ts`

- [x] `deckFileNameFor` → `documentFileNameFor(title, kind)`（扩展名/兜底名来自 `DOCGEN_OUTPUT_BY_KIND`）。
- [x] `generateDecksFromMessage` → `generateDocumentsFromMessage`（三种 kind 都走同一条）。
- [x] `sourceKey` 带上 kind + **内容哈希**（原来只带 `title+页数`：同标题同页数的两份不同内容会互相去重掉）。

### Task 4: 技能扩三种 kind

**Files:** Modify `packages/desktop/our-skills/document-deck/SKILL.md`（slug 与 `skillKey` **不动**）

- [x] 三种 kind 的写法、各自的写作规范（Word 论文章节感 / Excel 表头+一行一记录）、"说给用户的话"。
- [x] `name` 与 `description` 改成覆盖三种格式（都是中文、单行、≤200 字 —— 由 `our-skills-packaging-gate.test.ts` 钉）。
- [x] 回收旧文案：「Word / Excel 还做不到，让他粘进 Word」这类句子全部删掉。
- [x] ⭐ 额外加了一条测试（`test/document-deck-skill.test.ts`）：技能里写的**上限数字**必须与 `DOCGEN_LIMITS` 一致
      （技能写 60 页、契约改成 50 ⇒ 助手越界 ⇒ 整份被拒，而这条通路**没有别的东西守着**）。

### Task 5: 交付边界与界面文案

**Files:** Modify `src/renderer/lib/preset-agents.ts`（`COMMON_OPERATING_CONTRACT`、`PRESET_PROMPT_VERSION`）、`src/renderer/components/MarkdownContent.tsx`（若需要）、9 份 locale

- [x] `cannot produce .docx/.xlsx` 改成**与 pptx 同构的有条件能力**（技能可见才承诺；看不到就说只能给文字稿）。
- [x] 图片仍然做不到（不许一起松口）。
- [x] 版本标记 `2026-09-24.1` → `2026-09-24.2`（正文变了就必须换版本，否则将来的升级判据认不出来）。
- [x] 消息里那张卡片的文案 `chatMessage.docgenBlock` 从"演示文稿内容"改成覆盖三种格式的说法（9 语言同步）。

### Task 6: 门禁 + 变异电池 + 打包实测 + 账本

- [x] 变异电池：逐条改坏实现 ⇒ 指定测试必须红（含 1–2 条对照）。**23 条 = 18 杀 + 5 对照，RC=0**。
- [x] **asar 实测**：`docx` / `exceljs` 在打包产物里、无原生依赖、抠出来真跑一次（照 P1 那套）。
      ⭐ **抓到并修掉一个真缺陷**（打包态 `require('exceljs')` 直接炸）—— 见下面那一节。
- [x] `pnpm check` **RC=0**（desktop 3196 passed + 2 skipped / core 673 / shared 124 / pwa 61）。
      （首轮只栽在**本文件**的 `format:check`；第二轮栽在 `typecheck:tests`（新测试里一个可空类型）；
      第三轮栽在 `eslint`（垫片是 CommonJS，已加进 eslint ignores 并写明理由）。）
- [x] 本文件补「完成记录 / 执行期发现」。

---

## 完成记录

（做完逐条填，写**真实读数**）

### 提交

| 提交       | 内容                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------- |
| `b9120bf3` | `chore(desktop)`：装 `docx@9.7.2` + `exceljs@4.4.0`（都是 dependencies —— electron-builder 只打这个字段）              |
| `85644daf` | `feat(docgen)`：契约三种 kind + 渲染层拆分发 + 落盘层泛化 + 去重键带 kind 与内容哈希                                   |
| `33e358cc` | `feat(docgen)`：技能教三种格式 + 交付边界放开 docx/xlsx（图片/PDF 仍回绝）+ 版本标记 `2026-09-24.2` + 9 语言的卡片文案 |

### 读数（全部是本机实跑）

- 新增/改动的测试：`docgen-*` 共 **9 个文件 / 110 条**（契约 43、渲染 23、落盘 20、技能 6，其余为既有 P1 用例）
- 变异电池 **23 条 = 18 杀 + 5 对照**，RC=0，基线（干净树）110 全绿
- `typecheck` RC=0、`typecheck:tests` RC=0（首轮红：移动后的 pptx 渲染测试没跟着收窄类型）
- `pnpm check` **RC=0**：desktop **3196 passed** / 2 skipped、core 673、shared 124、pwa 61
- **asar 实测**（`electron-builder --win --x64 --dir`，产物 136,940,752 B）：
  - 三个库都在包里：`docx` 8 件 / `exceljs` 561 件 / `pptxgenjs` 9 件；
  - 依赖闭包只缺 `@types/node`（**纯类型**，本就不该随包）；
  - 包里**没有**新增原生模块（`.node` 只有既有的 sharp / better-sqlite3 / onnxruntime-node / win-ca）；
  - **解包后真跑**：docx 8,584 B（含 `word/document.xml`）、xlsx 6,434 B（含 `xl/workbook.xml`）。

### 执行期发现（计划与现实的出入 / 踩到的坑）

1. ⭐ **`docx` 库**没有 python-docx 那个"只写 `font.name` 就漏 `w:eastAsia`"的坑。
   我最初照 `cn-docx-writer` 的结论把这条写进了注释与测试名，**对本库是错的** ——
   查了 `docx@9.7.2` 的 `createRunFonts`：传**字符串**时 `ascii`/`cs`/`eastAsia`/`hAnsi` 四个属性同写。
   变异电池第一条 M7（把对象换成字符串）因此是**等价变异**，改不出红 ⇒ 才发现。
   已改：注释与断言名改成事实口径（这条断言钉的是"换库/对象漏字段"的回归），
   变异改成"把 `eastAsia` 从对象里拿掉"（现在能杀死）。
2. 🔴 **变异电池自己有个洞**：一条变异把 TS 写成**语法错误**时，vitest 的 JSON 报告里
   该文件的 `assertionResults` 是空的 ⇒ 脚本把"**根本没验**"记成了"**存活**"。
   已加运行完整性守卫（收集到的用例数必须等于基线，否则报"未验证"）。
   —— 与 `[[verify-your-own-verifier]]` 里"读错输出通道"同形状。
3. 🔴 **控制字符又写进源文件一次**：在 `generate.ts` 的注释里举"正则字符类"的例子时，
   写进去的是**真字节**，于是 `grep` 把整个文件当二进制（`Binary file … matches`）。
   已改成纯文字描述，并扫过全部 15 个 docgen 文件确认 **0 个控制字节**。
4. ⚠️ **产物名字带随机后缀**（P1 就有，不是本轮引入）：`saveArtifactFromBuffer` →
   `uniqueFileName()` **总是**追加 `-<8位十六进制>`，所以用户在「产物」里看到的是
   `内测汇报-3f9c2a1b.pptx`。本轮**没改**（改 `uniqueFileName` 会牵动导入与 reconcile 的既有行为），
   但把技能文案改成不承诺"干净文件名"。要不要改是单独一刀。
5. ⚠️ **pptx 数量的语义保持不变**：`parseStringList` 按**原样条数**（含空串）判上限，
   与 P1 逐字一致（我一度改成"丢掉空串再数"，又改回来了 —— 上限值是契约，不该顺手改语义）。
6. ℹ️ 上一轮的 `pnpm add` 其实**已经把锁文件解析好了**（`docx@9.7.2`、`exceljs@4.4.0` 都在 lock 里），
   失败只发生在下载/链接阶段 ⇒ 本轮重试一次，48.5s 通过。
7. ℹ️ `request.ts` 里的 `presentationPathFor` 是**文件通道的遗留**（P1 改走消息后就没用了），
   只有测试在养着它（`knip` 抓不到"被测试养着的死代码"）。本轮**没动**，已在源码注释里写明。
   要不要删是单独的决定。

### 🔴 打包实测抓到的真缺陷（P2 最值钱的一条）

**现象**：把打包产物解包、`require` 里面那份 `exceljs` ⇒
`Cannot find module 'readable-stream/passthrough'`（**模块顶层就炸**，不是写文件时才炸）
⇒ **打包态里一个 `.xlsx` 都产不出来**，而开发态与全部单测（110 条）**全绿**。

**根因链**（每步都实测过，不是推断）：

1. `exceljs` → `archiver` → `archiver-utils` → `lazystream` 在顶层 `require('readable-stream/passthrough')`；
2. `lazystream@1.0.1` 要 `readable-stream@^2`，**v2 有**这个根级入口（内容就是
   `module.exports = require('./readable').PassThrough`）；
3. **v3 删掉了它** —— 用 `curl` 拉上游 `readable-stream-3.6.2.tgz` 逐文件看过（根级只有
   `errors*.js` / `experimentalWarning.js` / `readable*.js`），**所以不是本机 store 坏了**；
4. 开发树没事：pnpm 给 `lazystream` 配了旁边的 v2（实测 `require.resolve` 命中 `readable-stream@2.3.8`）；
5. **打包后**：electron-builder 把 pnpm 的树压平，asar 里 `/node_modules/lazystream/` 只有 4 个文件、
   **没有嵌套 `node_modules`**（实测）⇒ 它向上解析到顶层那份 v3 ⇒ 炸。
   （对照：`jszip` 的嵌套 v2 副本**在** asar 里 —— 所以不是"一律不嵌套"，是压平时的取舍漏了这条边。）

**修法**：`packages/desktop/packaging-shims/readable-stream/passthrough.js`（与 v2 逐字相同的一行）

- `electron-builder.yml` 四个 `files` 列表（顶层 + mac/win/linux）里的 FileSet 映射
  → `node_modules/readable-stream/passthrough.js`；`test/readable-stream-shim-packaging-gate.test.ts` 钉住。

**验证闭环**（先证伪再证真，全程在同一个解包树上）：

- 解包打包产物 → 不带垫片跑 ⇒ `PROBE FAILED`；
- 只在解包树里补那一个文件 → 再跑 ⇒ **docx 8,582 B、xlsx 6,434 B**；
- 改完配置**重新打包** → 见下（重跑同一脚本）。

**顺带结论**：`docx` **没有**这个问题（依赖浅、全是纯 JS；解包树里直接就跑通了）。

**备选（留给用户拍）**：`exceljs` 在 asar 里是 **561 个文件**，本次 asar 从 106.9 MB 涨到
**136.9 MB（+30 MB）**。若嫌大，可以自己用 `jszip`（已在包里、pptxgenjs 与 docx 都在用）
手搓一个最小 xlsx 写入器替掉 exceljs —— 那份依赖链与这条垫片就都不需要了。
本轮**没做**（选型是用户定的，且换掉要重验 Excel 兼容性）。

### 已知限制（本轮刻意不做 / 做不到）

- ⛔ **改动到不了已发出的盘**：`skills:our-ensure` 是"缺了就补"、**不覆盖已装**；预设提示词只在
  **缺文件**时才写。⇒ 老盘上助手仍然只会说"Word 做不到"。这与 P1 记在
  `[[local-docgen-capability]]` 里的是同一条通道问题，解法（技能内容版本判据 / 提示词版本迁移）**尚未拍板**。
- ⛔ **真机验收未做**：说"做个 Word" → 产物里出现 `.docx` → 双击能用 Word/WPS 打开且内容正确。**要一块盘**。
- ⚠️ asar 实测只证明"库里在、抠出来能跑"，**真机上的 Electron asar 透明读仍未验**（与 P1 同一条残留风险）。
