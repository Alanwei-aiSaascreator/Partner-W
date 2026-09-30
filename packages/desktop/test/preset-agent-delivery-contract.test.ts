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
    // 版本号是"将来能不能安全升级已发出去的盘"的唯一依据
    // （见 preset-agents.ts 里 PRESET_PROMPT_VERSION 的注释）——
    // ⚠️ 所以**改了合同文本就必须动它**，否则已装的盘拿不到新合同。
    expect(PRESET_PROMPT_VERSION).toBe('2026-09-30.3');
  });
});
