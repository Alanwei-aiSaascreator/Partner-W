import { describe, expect, it } from 'vitest';
import { buildCapabilityRegistry } from '../src/capability/capability-registry.js';
import {
  CAPABILITY_BOUNDARY_PROMPT_VERSION,
  UNSUPPORTED_CAPABILITY_COPY_KEY,
  UNSUPPORTED_MODEL_COPY_KEY,
  buildCapabilityBoundaryPrompt,
  capabilityBoundaryEndMarker,
  capabilityBoundaryStartMarker,
  mergeCapabilityBoundaryBlock,
  recognizeUnsupportedCapabilityRequest,
} from '../src/capability/capability-boundary.js';

const MODELS = [
  { id: 'qwen3.7-flash', provider: 'clawrouter', input: ['text', 'image'] },
  { id: 'deepseek-v4-flash', provider: 'clawrouter', input: ['text'] },
];

describe('能力边界提示词（注入给模型的能力清单）', () => {
  const prompt = buildCapabilityBoundaryPrompt(buildCapabilityRegistry({ models: MODELS }));

  it('列出目录里的可用模型（模型名逐字来自目录）', () => {
    expect(prompt).toContain('qwen3.7-flash');
    expect(prompt).toContain('deepseek-v4-flash');
  });

  it('把"暂不支持"的规则写死：其它厂商模型 / 图片视频生成 / 语音', () => {
    expect(prompt).toContain('当前暂不支持该模型或能力');
    expect(prompt).toContain('GPT');
    expect(prompt).toContain('Claude');
    expect(prompt).toContain('图片生成');
    expect(prompt).toContain('视频生成');
    expect(prompt).toContain('语音');
  });

  it('禁止底层试错（不许调用工具试出来再报失败）', () => {
    expect(prompt).toMatch(/不要调用工具|不得调用工具|不要试/);
  });

  it('目录没拉到时（无模型输入）也要产出提示词，且不伪造模型名', () => {
    const bare = buildCapabilityBoundaryPrompt(buildCapabilityRegistry());
    expect(bare).toContain('当前暂不支持该模型或能力');
    expect(bare).not.toContain('qwen3.7-flash');
  });
});

describe('能力边界区块的注入/替换（幂等，不碰用户内容）', () => {
  const block = buildCapabilityBoundaryPrompt(buildCapabilityRegistry({ models: MODELS }));

  it('空文件 ⇒ 直接写入区块', () => {
    const merged = mergeCapabilityBoundaryBlock('', block);
    expect(merged.changed).toBe(true);
    expect(merged.content).toContain(capabilityBoundaryStartMarker(CAPABILITY_BOUNDARY_PROMPT_VERSION));
    expect(merged.content).toContain(capabilityBoundaryEndMarker(CAPABILITY_BOUNDARY_PROMPT_VERSION));
    expect(merged.content).toContain('当前暂不支持该模型或能力');
  });

  it('已有他人内容、没有我们的标记 ⇒ 追加区块，原文一字不动', () => {
    const original = '# AGENTS.md\n\n用户自己写的工作约定：先问清楚再动手。\n';
    const merged = mergeCapabilityBoundaryBlock(original, block);
    expect(merged.changed).toBe(true);
    expect(merged.content.startsWith(original)).toBe(true);
    expect(merged.content).toContain('用户自己写的工作约定：先问清楚再动手。');
  });

  it('已有旧版本区块 ⇒ 替换旧区块且只保留一份，周围内容保留', () => {
    const withOld = `# 头部\n\n${capabilityBoundaryStartMarker(0)}\n旧版本内容\n${capabilityBoundaryEndMarker(0)}\n\n# 尾部内容\n`;
    const merged = mergeCapabilityBoundaryBlock(withOld, block);
    expect(merged.changed).toBe(true);
    expect(merged.content).toContain('# 头部');
    expect(merged.content).toContain('# 尾部内容');
    expect(merged.content).not.toContain('旧版本内容');
    expect(merged.content).not.toContain(capabilityBoundaryStartMarker(0));
    expect(merged.content.match(capabilityBoundaryStartMarker(CAPABILITY_BOUNDARY_PROMPT_VERSION))?.length).toBe(1);
  });

  it('同一版本再并一次 = 一个字都不写（幂等）', () => {
    const first = mergeCapabilityBoundaryBlock('', block);
    const second = mergeCapabilityBoundaryBlock(first.content, block);
    expect(second.changed).toBe(false);
    expect(second.content).toBe(first.content);
  });
});

describe('请求前置识别（用户点名不存在的能力）', () => {
  it('点名其它厂商模型 ⇒ 模型文案键', () => {
    for (const text of ['帮我调用 GPT-5 写方案', '用 ChatGPT 翻译', '换成 Claude 来分析', '我要用 Gemini']) {
      const hit = recognizeUnsupportedCapabilityRequest(text);
      expect(hit?.reason, text).toBe('model');
      expect(hit?.copyKey, text).toBe(UNSUPPORTED_MODEL_COPY_KEY);
    }
  });

  it('点图片 / 视频生成、语音 ⇒ 能力文案键', () => {
    const image = recognizeUnsupportedCapabilityRequest('帮我生成一张图片');
    expect(image?.reason).toBe('image-generation');
    expect(image?.copyKey).toBe(UNSUPPORTED_CAPABILITY_COPY_KEY);
    const video = recognizeUnsupportedCapabilityRequest('生成一段视频给我');
    expect(video?.reason).toBe('video-generation');
    const voice = recognizeUnsupportedCapabilityRequest('克隆我的声音做一个旁白');
    expect(voice?.reason).toBe('voice');
  });

  it('正常请求不误伤（不许把普通任务判成"不支持"）', () => {
    for (const text of [
      '帮我画一张流程图的思路',
      '分析这段视频里的内容',
      '用 DeepSeek 写一份周报',
      '把这张表的错误找出来',
      '',
    ]) {
      expect(recognizeUnsupportedCapabilityRequest(text), text).toBeNull();
    }
  });

  it('目录里真有的模型不算"不存在"（按可用模型清单排除）', () => {
    expect(recognizeUnsupportedCapabilityRequest('用 Claude 分析')).not.toBeNull();
    expect(
      recognizeUnsupportedCapabilityRequest('用 Claude 分析', { availableModelIds: ['claude-opus-4'] }),
    ).toBeNull();
  });
});
