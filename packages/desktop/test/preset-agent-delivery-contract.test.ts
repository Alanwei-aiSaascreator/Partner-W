import { describe, expect, it } from 'vitest';
import {
  COMMON_OPERATING_CONTRACT,
  PRESET_AGENT_DEFINITIONS,
  PRESET_PROMPT_VERSION,
} from '../src/renderer/lib/preset-agents';

/**
 * 交付合同（`COMMON_OPERATING_CONTRACT`）会**每一轮全文注入**给每个预置助手，
 * 而它的"交付边界"是一张**封闭清单**。
 *
 * ⭐ 为什么必须钉死：2026-09-27 真机反馈里「生成 html 出不来、让我自己复制」的**头号原因**
 *    就是这张清单**只列了 pptx/docx/xlsx/pdf、没有 html** ——
 *    而 `htmlgen` 通道的用法只写在一份 `SKILL.md` 里，**技能正文不进系统提示词**
 *    （运行时只注入一份"名字 + 一行描述"的技能目录，模型得**自己决定**去读那个文件）。
 *    一边是每轮全额的封闭清单，一边是要主动去翻的文档 ⇒ **模型按清单走完全合理**，
 *    错的是清单没把通道列进去。
 *
 * ⇒ **加任何新的交付通道，都必须同时改这里。** 漏了 = 那条通道在用户侧等于不存在，
 *    而且表现成"产品做不到"，不是"没接线"。
 */
describe('预置助手的交付合同：每条通道都要在清单里', () => {
  it('requires in-turn generation and bounded diagnostic repair for every preset', () => {
    for (const definition of PRESET_AGENT_DEFINITIONS) {
      expect(definition.soulMd).toContain('scripts/generate.cjs');
      expect(definition.soulMd).toContain('Do not end the turn at source-valid');
      expect(definition.soulMd).toContain('at most two targeted correction rounds');
      expect(definition.soulMd).toContain('output-unconfirmed');
      expect(definition.soulMd).toContain('artifactIndexed:false');
      expect(definition.soulMd).toContain('visualReview:not-performed');
      expect(definition.soulMd).toContain('referenced image versions');
    }
  });
  it('only requests video generation when the real tool is available and never invents acceptance', () => {
    expect(COMMON_OPERATING_CONTRACT).toMatch(/video_generate` is available, use that tool/);
    expect(COMMON_OPERATING_CONTRACT).toContain('If unavailable, state the missing');
    expect(COMMON_OPERATING_CONTRACT).toContain(
      'capability without claiming that a video is running or offering fictitious links',
    );
    expect(COMMON_OPERATING_CONTRACT).toContain('An accepted background job is still running, not a completed video');
    expect(COMMON_OPERATING_CONTRACT).toContain('Never automatically resubmit after a timeout');
    for (const definition of PRESET_AGENT_DEFINITIONS) {
      expect(definition.soulMd).toContain('video_generate');
    }
  });

  it('allows an available real-file generator when a skill route is unavailable or fails', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain('another available document-generation tool or installed library');
    expect(COMMON_OPERATING_CONTRACT).toContain('verify that the final file exists and is readable');
    expect(COMMON_OPERATING_CONTRACT).not.toMatch(/neither skill is available, say plainly that you can only/);
    expect(COMMON_OPERATING_CONTRACT).not.toMatch(/skill is \*\*not\*\* available, say plainly that you can only/);
  });
  it('⭐ 网页（html）必须在清单里，并点名 htmlgen 与那个技能', () => {
    expect(COMMON_OPERATING_CONTRACT, '没写网页交付这一条').toMatch(/Web pages \(\.html\)/);
    expect(COMMON_OPERATING_CONTRACT, '没点名 htmlgen 这条 fence 通道').toContain('htmlgen');
    expect(COMMON_OPERATING_CONTRACT, '没点名技能 slug，模型不知道去翻哪一份').toContain('html-deliverable');
  });

  it('allows verified workspace HTML without making the user save markup manually', () => {
    expect(COMMON_OPERATING_CONTRACT).toMatch(/Do not hand the\s+user markup to save by hand/);
    expect(COMMON_OPERATING_CONTRACT).toMatch(/file-writing tool may also create a self-contained HTML file/);
    expect(COMMON_OPERATING_CONTRACT).toContain('verify the actual output file and give its real path');
    expect(COMMON_OPERATING_CONTRACT).not.toMatch(/not\*?\s*a 产物/);
  });

  /**
   * ⭐⭐ **这一条曾经把错的策略钉成绿色**（2026-09-27 改动前它写着
   * 「要提醒它内容装得下时优先用模板（填格子更快）」）。
   *
   * 那段合同的原文是：
   * > Reach for the 商务演示（模板版）template route when the content fits a template —
   * > filling slots is faster and it is already designed.
   *
   * 助手照做了 —— 用户真机上它原话是「太好了！有这个模板技能可以直接用专业设计的版式」——
   * 然后撞上模板**每格约 40 字**的硬上限，**整份被拒**，产物里什么都没有。
   * 更糟的是它没有改走幻灯版面，而是**手搓 Python 脚本**把文件写进工作区（面板里永远看不见）。
   *
   * ⇒ 所以现在要钉的是**两件事**：「哪条是默认」和「被拒了怎么办」。
   *    少了任何一条，同一场事故可以原样重演。
   */
  it('⭐⭐ 幻灯版面是**默认路**，且被拒时要**换路**而不是缩内容', () => {
    expect(COMMON_OPERATING_CONTRACT, '没点名 slidegen 这条围栏').toContain('slidegen');
    expect(COMMON_OPERATING_CONTRACT, '没点名技能 slug，助手不知道去翻哪一份').toContain('deck-layout');
    // ⚠️ 合同正文里有 Markdown 粗体（`**default route**`）⇒ 正则必须容忍那对星号，
    //    否则查的是一个不存在于文本里的形状（本文件上面那条注释记过同一个坑）。
    expect(COMMON_OPERATING_CONTRACT, '⭐ 要说清它是**默认路**，不是兜底').toMatch(
      /default route\*{0,2},\s*not a fallback/,
    );
    // ⭐ 2026-09-28 改：原来这里钉的是「**It has no character limit**」。
    //    那句话在部署版里**是假的** —— 回复正文会被网关截断，长 deck 贴进正文
    //    会**从中间断掉、整份作废**。所以现在钉的是**准确的那三件事**。
    expect(COMMON_OPERATING_CONTRACT, '要说清**版式本身**没有逐格字数上限').toMatch(/not capped per slot/);
    expect(COMMON_OPERATING_CONTRACT, '要说清一页装不下是**分页**、不是被拒').toMatch(/split\*\*, never rejected/);
    expect(COMMON_OPERATING_CONTRACT, '⭐ 必须说清**回复正文有上限**，所以长版面要写成文件').toMatch(
      /reply body has its own length limit/,
    );
    expect(COMMON_OPERATING_CONTRACT, '⭐ 要指明落在**文件**里').toMatch(/write the layout to a \*\*file\*\*/);
    expect(COMMON_OPERATING_CONTRACT, '⭐ 不许让用户自己拆几轮：一条指令一份 deck').toMatch(
      /one instruction must produce one deck/,
    );
    expect(COMMON_OPERATING_CONTRACT, '要说清模板**每格有上限、超一格整份被拒**').toMatch(/caps every slot/);
    expect(COMMON_OPERATING_CONTRACT, '⭐ 被拒 = **换路**的信号，不是缩用户内容的理由').toMatch(
      /signal to switch routes, not to shorten/,
    );
    expect(COMMON_OPERATING_CONTRACT).toContain('Do not substitute source code or a renamed text file');
  });

  it('⭐ 模板那条**仍然在清单里**（不是把它删掉，是把它收窄）', () => {
    // 反方向也要钉：谁把模板那条整段删掉，这条要红 —— 用户确实有"内容很短、正好套模板"的场景。
    expect(COMMON_OPERATING_CONTRACT, '模板那条被删了').toMatch(/模板版/);
  });

  it('四件文档那条**还在**（加新的别把旧的挤掉）', () => {
    expect(COMMON_OPERATING_CONTRACT).toMatch(/\.pptx \/ \.docx \/ \.xlsx \/ \.pdf/);
    expect(COMMON_OPERATING_CONTRACT).toContain('docgen');
  });

  it('requires actual file verification before claiming delivery success', () => {
    expect(COMMON_OPERATING_CONTRACT).toMatch(/verify the actual output file\s+before claiming success/);
    expect(COMMON_OPERATING_CONTRACT).toContain('not that the final file');
    expect(COMMON_OPERATING_CONTRACT).toContain('already exists or is guaranteed to appear');
  });

  it('委派前后必须如实说明 worker 是否真的启动', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain(
      'Do not say a worker or subagent is ready, working, or started until its corresponding `sessions_spawn` call succeeds.',
    );
    expect(COMMON_OPERATING_CONTRACT).toContain('If `sessions_spawn` fails, say plainly that no worker was started.');
  });

  it('桌面用户的故障建议只能走应用内入口，不能被要求运行 OpenClaw CLI', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain(
      'Do not tell desktop users to run `openclaw doctor`, any other OpenClaw CLI command, or terminal commands.',
    );
    expect(COMMON_OPERATING_CONTRACT).toContain(
      'Offer only in-app next steps such as retrying, reconnecting, or opening Settings.',
    );
  });

  it('⭐ 合同真的被拼进了每个助手的 SOUL（否则改了也不生效）', () => {
    const needle = 'Web pages (.html)';
    for (const agent of PRESET_AGENT_DEFINITIONS) {
      expect(agent.soulMd, `${agent.id} 的 SOUL 里没有交付合同片段`).toContain(needle);
    }
  });

  it('提示词版本号是当前那一版（改了合同就该动它）', () => {
    // 这一版删掉了「**It has no character limit**」那句假话，改成"正文有上限、
    // 长版面要写成文件、一条指令一份 deck"。
    // 2026-10-07 再次提版：演示条款从条件句改成**硬约束**（见上一组用例），
    // 同一版还引入了主罗盘（`main`）的交付合同文件。
    // 2026-10-08 提版：合同新增「ask_user 形态规范」（B8 实证：自由文本问句 /
    // 选项超量会被内核校验 blocked，问题到不了用户）。
    // 版本号是"将来能不能安全升级已发出去的盘"的唯一依据
    // （见 preset-agents.ts 里 PRESET_PROMPT_VERSION 的注释）——
    // ⚠️ 所以**改了合同文本就必须动它**，否则已装的盘拿不到新合同。
    expect(PRESET_PROMPT_VERSION).toBe('2026-10-08.1');
  });

  it('⭐ ask_user 形态规范：固定选项、≤3 问、禁自由文本、失败回退普通消息（B8）', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain('Structured questions (`ask_user`)');
    // 固定选项 + 数量上限
    expect(COMMON_OPERATING_CONTRACT).toContain('about 2–4');
    expect(COMMON_OPERATING_CONTRACT).toContain('at most 3 questions');
    // 禁自由文本 / 禁"其他"选项（B8 两次 blocked 的确切形状）
    expect(COMMON_OPERATING_CONTRACT).toContain('**Never** use it for free-text or open questions');
    expect(COMMON_OPERATING_CONTRACT).toContain('"other / 其他" free-text option');
    // 失败不许瞎重试
    expect(COMMON_OPERATING_CONTRACT).toContain('do not retry with guessed options');
  });

  it('⭐ 技能读取是可执行读法（BUG-060 预防）：<location> + read；"打开技能"式旧措辞已清', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain('## Using skills');
    expect(COMMON_OPERATING_CONTRACT).toContain('read that exact path with the `read` tool');
    expect(COMMON_OPERATING_CONTRACT).toContain('no tool that "opens" or "loads" a skill');
    // 旧措辞（模型"去打开技能"的指令来源，客户演示事故 BUG-060）必须不再出现
    expect(COMMON_OPERATING_CONTRACT).not.toContain('open it and follow it');
    expect(COMMON_OPERATING_CONTRACT).not.toContain('open its SKILL.md');
  });
});

/**
 * 2026-10-07 加固：演示条款从**条件句**（"*If* the 幻灯版面 skill is available…"）
 * 改成**硬约束**。
 *
 * 为什么：条件句读起来是"有就用、没有就算了"，而真机上的形状是模型**根本没去读**
 * 那份 SKILL.md —— 转头用 docgen 出白底素版，或**自写脚本**把文件写进工作区
 * （产物面板之外，用户什么都拿不到）。收口批次的红线是「不谎报、不给简约垃圾版」，
 * 这三条不写成"必须 / 禁止"，就还是软的。
 */
describe('演示硬约束（2026-10-07）：必须读 SKILL.md / 禁 docgen pptx / 禁自写脚本 / 禁链接式交付', () => {
  it('给人看的演示必须先读「幻灯版面」的 SKILL.md 并遵循（BUG-060 改为可执行读法）', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain('Before you write a presentation, read the 幻灯版面 skill file');
    expect(COMMON_OPERATING_CONTRACT).toContain(
      "read the `SKILL.md` at that entry's `<location>` with the `read` tool",
    );
    expect(COMMON_OPERATING_CONTRACT, '条件句（If available）会把硬约束读软').not.toMatch(
      /\*If\* the 幻灯版面 skill is available/,
    );
  });

  it('禁止用 docgen 的 pptx 出正式演示（素版只留给用户明确要的草稿）', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain('Never compose it through the 文档生成 (`document-deck`) route');
    expect(COMMON_OPERATING_CONTRACT).toContain('plain draft deck');
  });

  it('禁止自写脚本生成 .pptx（PptxGenJS / python-pptx / 裸 OOXML 都点名）', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain('no ad-hoc script');
    expect(COMMON_OPERATING_CONTRACT).toContain('PptxGenJS');
    expect(COMMON_OPERATING_CONTRACT).toContain('python-pptx');
    expect(COMMON_OPERATING_CONTRACT, '唯一被授权的生成器是技能自己的 generate.cjs').toContain(
      "no CLI other than the 幻灯版面 skill's own `scripts/generate.cjs`",
    );
  });

  it('⭐ 禁止"下载链接 / 文件路径"式交付：生成好了 = 产物面板真的出现了', () => {
    expect(COMMON_OPERATING_CONTRACT).toContain('download link or a bare file path');
    expect(COMMON_OPERATING_CONTRACT).toMatch(
      /A deck counts as\s+generated only when it appears in this task's 产物 panel/,
    );
    expect(COMMON_OPERATING_CONTRACT, '没注册进产品的路径不算交付').toContain('is not delivery');
  });

  it('⭐ 硬约束真的进了每个预置助手的 SOUL（主罗盘的合同走的是同一份文本）', () => {
    for (const agent of PRESET_AGENT_DEFINITIONS) {
      expect(agent.soulMd, `${agent.id} 拿不到演示硬约束`).toContain('PptxGenJS');
    }
  });
});
