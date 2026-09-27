# PPTX 模板资源

这套模板是**商务演示的版式骨架**：设计师把每页的版式、配色、字体、留白都定死，
程序只负责把结构化内容填进那些**文本框**。模型不碰样式，一个字节都不碰。

## 文件

| 文件                    | 用途                                   | SHA-256                                                            |
| ----------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| `business-deck-v4.pptx` | 8 张模板页（见下表）                   | `348995833def2f1ab3fa31a0907bca570d9813000f629b94712f3919dae5cff9` |
| `blank-root.pptx`       | **零页**根模板：只有母版 / 版式 / 主题 | `f7c7950a01dc2f9a269a27373367777e9292b5d1b8536d18eca6b953c777b4ae` |

### 为什么还要一个"零页根"

`pptx-automizer` 需要一个**根**演示文稿来提供主题与母版，然后再从模板里 `addSlide` 复制页。

不直接拿 `business-deck-v4.pptx` 当根，有两条实测原因：

1. **孤儿页**。拿它当根就得靠 `removeExistingSlides: true` 把自带的 8 页清掉，
   而那个开关**只从 `p:sldIdLst` 删条目、部件留在包里**（库自己的注释写明是已知行为，
   issue #166）。成品里于是躺着 8 页孤儿，每页还带着 `{{占位符}}` —— 包更大，
   而且按部件列表读就会读到它们。
2. **`xmlns:r` 未声明**（更要命）。WPS 把命名空间**下推到各元素**上，
   `presentation.xml` 的根元素只有 `xmlns:p`；而 automizer 追加幻灯片时会写
   `<p:sldId r:id="…">`，那个 `r:` 前缀**没有任何地方声明**
   ⇒ 文档不是命名空间良构的 ⇒ **WPS 直接判 0 页**（而所有单测全绿 ——
   单测验的是 XML 内容，验不了"这份文件 Office 认不认"）。

零页根是干净重打包出来的，这两个问题在源头就不存在，也就不需要在运行时打补丁。

## 模板页与占位符

形状名（`cNvPr name`）**大小写敏感、一字不差**，由
`src/main/docgen/pptx-template/catalog.ts` 声明，
并由 `test/pptx-template-catalog.test.ts` 打开**这份真实文件**逐页核对。

| 页  | templateId   | 形状名（= 占位符 token）                                                                                                  |
| --- | ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | `cover`      | `COVER_TITLE`(封面标题，必填) · `COVER_SUBTITLE` · `COVER_DATE` · `COVER_AUTHOR`                                          |
| 2   | `section`    | `SECTION_TITLE`(必填) · `SECTION_SUMMARY` · `SECTION_CONTEXT`                                                             |
| 3   | `insight`    | `SLIDE_TITLE`(必填) · `SLIDE_SUBTITLE` · `TAKEAWAY` · `EVIDENCE_1..3`                                                     |
| 4   | `comparison` | `SLIDE_TITLE`(必填) · `SLIDE_SUBTITLE` · `LEFT_TITLE` · `RIGHT_TITLE` · `LEFT_ITEM_1..3` · `RIGHT_ITEM_1..3`              |
| 5   | `metrics`    | `SLIDE_TITLE`(必填) · `SLIDE_SUBTITLE` · `METRIC_1..3_VALUE` · `METRIC_1..3_LABEL` · `METRIC_1..3_NOTE` · `METRIC_SOURCE` |
| 6   | `timeline`   | `SLIDE_TITLE`(必填) · `SLIDE_SUBTITLE` · `STEP_1..5_TITLE` · `STEP_1..5_DESC`                                             |
| 7   | `actions`    | `SLIDE_TITLE`(必填) · `SLIDE_SUBTITLE` · `ACTION_1..4` · `OWNER_1..4` · `DUE_1..4`                                        |
| 8   | `closing`    | `CLOSING_TITLE`(必填) · `CLOSING_MESSAGE` · `CLOSING_CONTACT`                                                             |

⚠️ 形状名**不等于** token 名：token 是 `value_1`，形状是 `METRIC_1_VALUE`。
这层映射推不出来，只能写死 —— 所以那条对齐测试是必须的：漂移了产物上那一格**永远是空的**
（`modifyElement` 找不到元素只记日志、不抛），而所有单测会绿。

## 来源与许可

- 原始文件：`荣盈魔方-商务PPT模板库-v4.pptx`（**自制**，公司自有）
  SHA-256 `b83fde17af54a535a3484581c2773cef17d526895f8e08c5c55da4b4998170d2`，37,494 字节。
- 随包这两份是它的**常态化重打包**，不含任何第三方素材（无图片、无外链）。
- ⚠️ **不许**从网上下载来源不明的模板放进来。

## 换模板文件时必须重新满足的三条（`test/pptx-template-catalog.test.ts` 会强制）

从 WPS / PowerPoint 直接导出并**不能**直接用，要过三步：

1. **去掉所有部件的 UTF-8 BOM**。源文件里 23 个部件带 BOM，`@xmldom/xmldom`
   解析时直接抛 `ParseError`（automizer 依赖它）。
2. **去掉备注页与备注母版**（`ppt/notesSlides/`、`ppt/notesMasters/`，
   连同 `[Content_Types].xml` 里的 Override 与 `.rels` 里的关系）。
   复制页之后它们的反向引用会错位。
3. **`presentation.xml` 的根元素补上 `xmlns:a` 与 `xmlns:r`**（见上文第 2 条原因）。

做完这三步，另存为 `blank-root.pptx`：把 `ppt/slides/` 整个去掉、
`[Content_Types].xml` 里去掉对应的 Override、`presentation.xml.rels` 里去掉 slide 关系、
`presentation.xml` 里去掉 `<p:sldIdLst>`。

改完跑 `pnpm --filter @clawwork/desktop exec vitest run test/pptx-template-catalog.test.ts`，
那三条不变量会被逐条检查。
