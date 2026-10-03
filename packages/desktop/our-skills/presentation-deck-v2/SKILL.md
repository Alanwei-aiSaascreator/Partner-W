---
name: 商务演示（模板版）
description: '用户明确指定本产品现成模板或要求模板填充时，用模板页产出商务演示（.pptx）：你挑模板页、填字段。普通汇报 / 方案 / 复盘 / 提案用「幻灯版面」。⚠️ 每个格子有字数上限；内容长时先拆页，不要承诺尚未生成的文件。'
metadata: { 'openclaw': { 'emoji': '📊', 'skillKey': 'presentation-deck-v2' } }
---

# 商务演示（模板版）

> ⚠️ 受控验证环境（`ROYIN_NATIVE_PPT_VALIDATION=1`）下，本文件的正文会被**整体替换**为
> 固定槽位契约——唯一真源见 `TEMPLATE-DECK.md`（`templateDeck` / 16 版式）。下面这套
> `business-deck-v4` 口径只适用于非受控（生产）路线。

用户**明确指定现成模板或模板填充**时用这条路。普通演示请求默认使用「幻灯版面」；
只有用户明确要简单草稿时才使用「文档生成」的标题与要点版式。

这里把内容填进随产品提供的模板槽位，配色、字号、分栏和页脚由模板决定。
它不能读取任意外部模板，也不代表填入内容就一定美观；须遵守字段容量并检查实际成品。

## 怎么写

在回复里放**一个**围栏代码块，语言标记是小写 `docgen`，内容是**一个 JSON 对象**：

````
```docgen
{
  "kind": "pptx",
  "title": "九月经营简报",
  "template": "business-deck-v4",
  "slides": [
    { "templateId": "cover",   "data": { "cover_title": "九月经营简报", "cover_subtitle": "私域增长与渠道结构", "date": "2026-09-27", "author": "增长组" } },
    { "templateId": "metrics", "data": { "slide_title": "关键指标", "value_1": "12.4%", "label_1": "转化率", "note_1": "较上月 +1.8pp" } },
    { "templateId": "actions", "data": { "slide_title": "下一步", "action_1": "补齐私域承接话术", "owner_1": "张", "due_1": "本周五" } }
  ]
}
```
````

⚠️ **`title` 是必填的**（和三种现画格式一样）—— 它同时是**文件名**。漏了它整份会被拒。

`template` 写 `business-deck-v4`（这一版只有这一套）；每一页用 `templateId` 挑版式、`data` 填字段。

## 提问规则

- 用户已经给出主题、受众和用途，或明确说“直接做 / 用通用框架”时，**立即生成**；缺失的公司名、金额、团队姓名用明显占位符，不要反复追问。
- `ask_user` 只用于 2–3 个**有固定选项**、答案会改变整份结构的问题，单次**最多 3 个**。公司名、姓名、金额这类自由文本 / 开放式问题不要用 `ask_user`，改成普通消息直接在对话里问；赶时间时直接用占位符。
- 工具调用失败不代表用户回答了，也不能当作“信息已经够了”。失败后不要编答案；能用占位符继续就继续，确实无法继续才用普通消息说明缺哪一项。

## 八种模板页

`templateId` **只能从这八个里挑**，别的会被拒：

| `templateId` | 用途                             | 可以填的字段                                                                                                                                                                                               |
| ------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cover`      | 封面                             | `cover_title`(必填) `cover_subtitle` `date` `author`                                                                                                                                                       |
| `section`    | 章节页（给一段内容起头）         | `section_title`(必填) `section_summary` `section_context`（最多 60 字）                                                                                                                                    |
| `insight`    | 观点页：一个主结论 + 三条证据    | `slide_title`(必填) `slide_subtitle` `takeaway` `evidence_1` `evidence_2` `evidence_3`                                                                                                                     |
| `comparison` | 左右对比                         | `slide_title`(必填) `slide_subtitle` `left_title` `right_title` `left_item_1` `left_item_2` `left_item_3` `right_item_1` `right_item_2` `right_item_3`                                                     |
| `metrics`    | 三个关键指标                     | `slide_title`(必填) `slide_subtitle` `value_1`(必填) `label_1`(必填) `note_1` `value_2` `label_2` `note_2` `value_3` `label_3` `note_3` `source_or_note`                                                   |
| `timeline`   | 最多五步的时间线                 | `slide_title`(必填) `slide_subtitle` `step_1_title`(必填) `step_1_desc` `step_2_title` `step_2_desc` `step_3_title` `step_3_desc` `step_4_title` `step_4_desc` `step_5_title` `step_5_desc`                |
| `actions`    | 行动计划或三列合作表（最多四条） | `slide_title`(必填) `slide_subtitle` `action_header` `owner_header` `due_header` `action_1`(必填) `owner_1` `due_1` `action_2` `owner_2` `due_2` `action_3` `owner_3` `due_3` `action_4` `owner_4` `due_4` |
| `closing`    | 结尾页                           | `closing_title`(必填) `closing_message` `contact_or_next_step`                                                                                                                                             |

## 五条硬规矩（违反了会被拒，而且会告诉你错在哪一页哪个字段）

1. **字段名一个字母都不能差**。写错了会被明确拒绝，并把你写错的那个名字回给你。
   ⚠️ 内页标题一律是 `slide_title` / `slide_subtitle`，**不是** `title` / `subtitle`。
2. **标"必填"的必须给**，只给空白也算没给。其余字段不给就留空，不会出错；例外是 `actions` 的三个表头字段，省略或只给空白时保留模板默认表头。
3. **别写样式**。没有地方写颜色、字号、坐标、字体、图片——这些字段在协议里**根本不存在**。
   版式是设计师定死的，你改不了，也不需要改。**也不要向用户承诺"帮你配图""设计感"。**
4. **数字要是结构化的值**（`"value_1": 12.4` 或 `"12.4"`），别把一段话塞进指标格。
   指标格很短（十几个字符），标题 60 字以内，`section_context` 最多 60 字，正文类字段按 catalog 上限写；长内容先拆页或压缩。
5. ⭐ **正文里要引用什么，别用英文双引号**：JSON 字符串**里面**再出现一个裸的 `"`，原始 JSON 就不合法。
   客户端会对「点击"仍要运行"」这种明确的正文引号做**一次受控修复**，但歧义写法和其它 JSON 结构错误仍会被拒绝，不要依赖修复。
   要引号就用**中文引号**「」或“”，或者写成 `\"`。

## 合作表的三列表头

`actions` 也能做「服务 / 适用对象 / 交付方式」这类合作表。三列从左到右仍用 `action_1` / `owner_1` / `due_1` 填第一行，后续行对应 `_2` 到 `_4`。
明确给出 `action_header` / `owner_header` / `due_header` 就能分别替换这三列表头，每个最多 40 字。
这三个字段都可选：省略、空字符串或只有空白时保留模板现有表头；只给其中一个就只改那一列。客户端不会根据正文猜表头，合作表应显式填写三列名称。

```docgen
{
  "kind": "pptx",
  "title": "合作方案",
  "template": "business-deck-v4",
  "slides": [
    {
      "templateId": "actions",
      "data": {
        "slide_title": "合作方案",
        "action_header": "合作方式",
        "owner_header": "适用对象",
        "due_header": "交付周期",
        "action_1": "单品诊断",
        "owner_1": "中小商家",
        "due_1": "3 个工作日"
      }
    }
  ]
}
```

## 怎么挑页、怎么写内容

一份正经的商务演示，通常是：

`cover` → `section`（可选，分几段）→ `insight` / `metrics` / `comparison` / `timeline` 若干 → `actions` → `closing`

- **一页只讲一件事**。塞不下就**拆成两页**，不要硬压。
- **标题写结论，不写"关于……的说明"**。"转化率比上月高 1.8 个点"比"本月数据"有用得多。
- **点要短**（每条大约 20 字以内），长的解释留给讲者备注（那是「文档生成」那条路的能力，这里没有备注字段）。
- **数据页的数字必须来自你手里真实的结构化输入**。没有数就不要编 —— 编出来的指标比空着更糟。

## 说给用户的话

文件是**客户端在这一轮结束后**生成的：

- ✅ 可以说：「内容已提交生成；请以**右侧「产物」实际出现 .pptx 为准**，出现后可直接打开继续改。」
- ❌ 不要说「已经生成了」「文件在你桌面上」——那一刻文件还不存在。
- ⚠️ 如果提示**某页字段不对 / 太长 / 模板名不认识**，照着提示里的那个名字改；不要擅自改走 `.slidegen` 兜底，也不要向用户询问“换路子行不行”。模板内部渲染异常由客户端自动降级成仍可编辑的 `.pptx`。

## 什么时候不要用它

- 用户要的是**随手能用的草稿**、不在乎版式 ⇒ 用「文档生成」里那种现画的 pptx，更自由。
- 用户要 **Word / Excel / PDF** ⇒ 那是「文档生成」的事，不是这条。
- 用户要**网页 / 可打印的报告页** ⇒ 那是「网页交付」的事。
- 用户要**图片**（照片、插画、海报图）⇒ 做不到，说清楚，别拿别的格式顶替。
