import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  collapseDiscoveredMessages,
  normalizeAssistantTurns,
  normalizeContentBlocks,
} from '../src/protocol/normalize-history';
import type { RawHistoryMessage } from '../src/protocol/types';

describe('normalizeAssistantTurns', () => {
  it.each([
    ['run-a', undefined],
    [undefined, 'run-a'],
  ])('matches unique legacy tool ownership with one unknown run %s / %s', (callRun, resultRun) => {
    const history = [
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: callRun },
        content: [{ type: 'toolCall', id: 'legacy-id', name: 'exec' }],
      },
      {
        role: 'toolResult',
        timestamp: 2000,
        __openclaw: { runId: resultRun },
        toolCallId: 'legacy-id',
        content: [{ type: 'text', text: 'legacy-result' }],
      },
    ];
    expect(normalizeAssistantTurns(history)[0].toolCalls[0]).toMatchObject({ status: 'done', result: 'legacy-result' });
  });

  it('does not assign an unknown-run result to either of two possible tool owners', () => {
    const history = [
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-a' },
        content: [{ type: 'toolCall', id: 'same-id', name: 'exec' }],
      },
      {
        role: 'assistant',
        timestamp: 2000,
        __openclaw: { runId: 'run-b' },
        content: [{ type: 'toolCall', id: 'same-id', name: 'exec' }],
      },
      { role: 'toolResult', timestamp: 3000, toolCallId: 'same-id', content: [{ type: 'text', text: 'ambiguous' }] },
    ];
    expect(normalizeAssistantTurns(history).map((turn) => turn.toolCalls[0].result)).toEqual([undefined, undefined]);
  });

  it('keeps the actual asynchronous video runs and message-level tool result separate', () => {
    const history = JSON.parse(readFileSync(new URL('./fixtures/video-async-history.json', import.meta.url), 'utf8'));
    const turns = normalizeAssistantTurns(history, 'http://127.0.0.1:18789');
    expect(turns).toHaveLength(3);
    expect(turns[0]).toMatchObject({
      timestamp: '2026-09-29T19:53:53.323Z',
      runId: '6c0b1c10-3e13-4d84-aa0b-8db0f6ab60ef',
      toolCalls: [{ id: 'qa-video-call-1', status: 'done', completedAt: '2026-09-29T19:53:55.897Z' }],
    });
    expect(turns[0].toolCalls[0].result).toContain('Background task started');
    expect(turns[1]).toMatchObject({
      content: '视频已生成。',
      runId: 'video_generate:eaebdb9c-f6e3-46cb-94a9-fa3e2718eff8:ok:agent-loop',
      toolCalls: [],
    });
    expect(turns[2].toolCalls).toEqual([]);
    expect(turns[2].attachments?.[0].mimeType).toBe('video/mp4');
  });

  it('does not match reused tool ids across explicit runs', () => {
    const history = [
      {
        role: 'assistant',
        timestamp: 1000,
        __openclaw: { runId: 'run-a' },
        content: [{ type: 'toolCall', id: 'same-id', name: 'exec' }],
      },
      {
        role: 'toolResult',
        timestamp: 2000,
        __openclaw: { runId: 'run-a' },
        toolCallId: 'same-id',
        content: [{ type: 'text', text: 'result-a' }],
      },
      {
        role: 'assistant',
        timestamp: 3000,
        __openclaw: { runId: 'run-b' },
        content: [{ type: 'toolCall', id: 'same-id', name: 'exec' }],
      },
      {
        role: 'toolResult',
        timestamp: 4000,
        __openclaw: { runId: 'run-b' },
        toolCallId: 'same-id',
        isError: true,
        content: [{ type: 'text', text: 'result-b' }],
      },
    ];
    const turns = normalizeAssistantTurns(history);
    expect(turns).toHaveLength(2);
    expect(turns[0].toolCalls[0]).toMatchObject({ status: 'done', result: 'result-a' });
    expect(turns[1].toolCalls[0]).toMatchObject({ status: 'error', result: 'result-b' });
  });

  it('preserves the delayed delivery-mirror video history message after its text completion', () => {
    const turns = normalizeAssistantTurns(
      [
        { role: 'assistant', timestamp: 1000, content: [{ type: 'text', text: 'Your video is ready.' }] },
        {
          role: 'assistant',
          timestamp: 2000,
          model: 'delivery-mirror',
          content: [
            {
              type: 'video',
              url: '/api/chat/media/outgoing/session/video/full',
              openUrl: '/api/chat/media/outgoing/session/video/full',
              fileName: 'clip.mp4',
              mimeType: 'video/mp4',
            },
          ],
        },
      ],
      'http://127.0.0.1:18789',
    );
    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({
      content: '',
      timestamp: '1970-01-01T00:00:02.000Z',
      attachments: [
        {
          fileName: 'clip.mp4',
          dataUrl: 'http://127.0.0.1:18789/api/chat/media/outgoing/session/video/full',
          mimeType: 'video/mp4',
        },
      ],
    });
  });

  it('normalizes the observed native video display block through the gateway media route', () => {
    const block = {
      type: 'video',
      artifactId: 'artifact_managed_media_fixture',
      url: '/api/chat/media/outgoing/encoded-session/video-id/full',
      openUrl: '/api/chat/media/outgoing/encoded-session/video-id/full',
      fileName: 'generated.mp4',
      mimeType: 'video/mp4',
      playback: 'native',
      sizeBytes: 6186,
      durationMs: 5000,
      width: 854,
      height: 480,
    };
    expect(normalizeContentBlocks([block], 'http://127.0.0.1:18789')).toEqual({
      content: '',
      attachments: [
        {
          fileName: 'generated.mp4',
          artifactId: 'artifact_managed_media_fixture',
          dataUrl: 'http://127.0.0.1:18789/api/chat/media/outgoing/encoded-session/video-id/full',
          mimeType: 'video/mp4',
        },
      ],
    });
  });

  it('keeps the result timestamp without treating the assistant message time as a tool start', () => {
    const [turn] = normalizeAssistantTurns([
      { role: 'assistant', timestamp: 1000, content: [{ type: 'toolCall', id: 't1', name: 'agents_list' }] },
      { role: 'toolResult', timestamp: 25000, content: [{ type: 'toolResult', id: 't1', result: 'ok' }] },
    ]);
    expect(turn.timestamp).toBe('1970-01-01T00:00:01.000Z');
    expect(turn.toolCalls[0].startedAt).toBe('');
    expect(turn.toolCalls[0].completedAt).toBe('1970-01-01T00:00:25.000Z');
  });

  it.each([
    [0, '1970-01-01T00:00:00.000Z'],
    [Number.NaN, undefined],
    [Number.POSITIVE_INFINITY, undefined],
    [Number.NEGATIVE_INFINITY, undefined],
    [8_640_000_000_000_001, undefined],
    [undefined, undefined],
  ])('handles the tool result timestamp %s without fabricating a completion', (timestamp, expected) => {
    const [turn] = normalizeAssistantTurns([
      { role: 'assistant', timestamp: 1000, content: [{ type: 'toolCall', id: 't1', name: 'exec' }] },
      { role: 'toolResult', timestamp, content: [{ type: 'toolResult', id: 't1', result: 'ok' }] },
    ]);
    expect(turn.timestamp).toBe('1970-01-01T00:00:01.000Z');
    expect(turn.toolCalls[0].completedAt).toBe(expected);
    expect(turn.toolCalls[0].status).toBe('done');
  });

  it('deduplicates repeated raw history messages within one payload', () => {
    const rawMsgs: RawHistoryMessage[] = [
      { role: 'user', timestamp: 1000, content: [{ type: 'text', text: '/model_usage' }] },
      {
        role: 'assistant',
        timestamp: 2000,
        content: [{ type: 'toolCall', id: 'tool-1', name: 'model_usage', arguments: { scope: 'session' } }],
      },
      { role: 'toolResult', timestamp: 2500, content: [{ type: 'toolResult', id: 'tool-1', result: 'usage data' }] },
      { role: 'assistant', timestamp: 3000, content: [{ type: 'text', text: 'Usage: 10 tokens' }] },
      { role: 'user', timestamp: 1000, content: [{ type: 'text', text: '/model_usage' }] },
      {
        role: 'assistant',
        timestamp: 2000,
        content: [{ type: 'toolCall', id: 'tool-1', name: 'model_usage', arguments: { scope: 'session' } }],
      },
      { role: 'toolResult', timestamp: 2500, content: [{ type: 'toolResult', id: 'tool-1', result: 'usage data' }] },
      { role: 'assistant', timestamp: 3000, content: [{ type: 'text', text: 'Usage: 10 tokens' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('Usage: 10 tokens');
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0]).toMatchObject({ id: 'tool-1', name: 'model_usage', status: 'done' });
  });

  it('keeps consecutive visible assistant finals as separate turns', () => {
    const rawMsgs: RawHistoryMessage[] = [
      { role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: 'Usage: 10 tokens' }] },
      { role: 'assistant', timestamp: 3000, content: [{ type: 'text', text: 'Providers: openai' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ content: 'Usage: 10 tokens', timestamp: '1970-01-01T00:00:02.000Z' });
    expect(turns[1]).toMatchObject({ content: 'Providers: openai', timestamp: '1970-01-01T00:00:03.000Z' });
  });

  // 推理块只在 agent 通道上实时流过（见 gateway-dispatcher 的 `case 'thinking'`），
  // 落库是主路径；这里是**从网关历史重建**那条，供换设备/清库后用。
  // 形状是实测的（2026-09-12 打网关 chatHistory）：
  // blocks = [{type:'thinking', thinking}, {type:'text', text}]
  it('从历史里恢复推理块 —— 取 thinking 块，不混进正文', () => {
    const rawMsgs: RawHistoryMessage[] = [
      {
        role: 'assistant',
        timestamp: 2000,
        content: [
          { type: 'thinking', thinking: '设鸡 x 只、兔 y 只……' },
          { type: 'text', text: '鸡 23 只、兔 12 只。' },
        ],
      },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      content: '鸡 23 只、兔 12 只。',
      thinkingContent: '设鸡 x 只、兔 y 只……',
    });
  });

  it('正文为空、整条回复都在推理里的，也要留下（生产实测过这种）', () => {
    const rawMsgs: RawHistoryMessage[] = [
      { role: 'assistant', timestamp: 2000, content: [{ type: 'thinking', thinking: '整条回复都是推理' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ content: '', thinkingContent: '整条回复都是推理' });
  });

  it('merges an assistant tool call with its visible final text', () => {
    const rawMsgs: RawHistoryMessage[] = [
      {
        role: 'assistant',
        timestamp: 2000,
        content: [{ type: 'toolCall', id: 'tool-1', name: 'read_file', arguments: '{"path":"README.md"}' }],
      },
      { role: 'toolResult', timestamp: 2500, content: [{ type: 'toolResult', id: 'tool-1', result: 'file contents' }] },
      { role: 'assistant', timestamp: 3000, content: [{ type: 'text', text: 'Read README.md' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('Read README.md');
    expect(turns[0].timestamp).toBe('1970-01-01T00:00:03.000Z');
    expect(turns[0].toolCalls).toHaveLength(1);
    expect(turns[0].toolCalls[0]).toMatchObject({
      id: 'tool-1',
      name: 'read_file',
      status: 'done',
      args: { path: 'README.md' },
      result: 'file contents',
    });
  });

  it('extracts line-start MEDIA directives as image attachments', () => {
    const rawMsgs: RawHistoryMessage[] = [
      {
        role: 'assistant',
        timestamp: 2000,
        content: [{ type: 'text', text: 'MEDIA:/Users/x/.openclaw/media/out.png\n\nImage ready' }],
      },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('Image ready');
    expect(turns[0].attachments).toEqual([
      {
        fileName: 'out.png',
        dataUrl: 'file:///Users/x/.openclaw/media/out.png',
        mimeType: 'image/png',
        sourcePath: '/Users/x/.openclaw/media/out.png',
      },
    ]);
  });

  it('decodes file URL media paths before reading from sourcePath', () => {
    const normalized = normalizeContentBlocks([
      { type: 'text', text: 'MEDIA:file:///Users/x/.openclaw/media/generated%20image.png' },
    ]);

    expect(normalized.attachments?.[0]).toMatchObject({
      fileName: 'generated image.png',
      dataUrl: 'file:///Users/x/.openclaw/media/generated%20image.png',
      sourcePath: '/Users/x/.openclaw/media/generated image.png',
    });
  });

  it.each([
    ['/Users/x/.openclaw/media/clip.mp4', 'file:///Users/x/.openclaw/media/clip.mp4', 'video/mp4'],
    ['C:\\qa\\media\\clip.mp4', 'file:///C:/qa/media/clip.mp4', 'video/mp4'],
    ['D:/qa/media/clip.webm', 'file:///D:/qa/media/clip.webm', 'video/webm'],
    ['C:\\qa\\media\\image.png', 'file:///C:/qa/media/image.png', 'image/png'],
  ])('normalizes a supported local MEDIA directive %s', (sourcePath, dataUrl, mimeType) => {
    const normalized = normalizeContentBlocks([{ type: 'text', text: `MEDIA:${sourcePath}` }]);
    expect(normalized.content).toBe('');
    expect(normalized.attachments).toEqual([expect.objectContaining({ sourcePath, dataUrl, mimeType })]);
  });

  it('decodes Windows file URLs without turning the drive into a POSIX path', () => {
    const normalized = normalizeContentBlocks([{ type: 'text', text: 'MEDIA:file:///C:/qa/media/my%20clip.mp4' }]);
    expect(normalized.attachments).toEqual([
      {
        fileName: 'my clip.mp4',
        dataUrl: 'file:///C:/qa/media/my%20clip.mp4',
        sourcePath: 'C:/qa/media/my clip.mp4',
        mimeType: 'video/mp4',
      },
    ]);
  });

  it.each([
    '\\\\server\\share\\clip.mp4',
    '//server/share/clip.mp4',
    '\\\\?\\C:\\qa\\clip.mp4',
    '\\\\.\\C:\\qa\\clip.mp4',
    'C:clip.mp4',
    'C:\\qa\\..\\clip.mp4',
    'file:///C:/qa/%2e%2e/clip.mp4',
    'file://server/share/clip.mp4',
    'file:///C:/qa/%00clip.mp4',
    'C:/qa/clip.mp4:stream.mp4',
    'ftp://example.com/clip.mp4',
    'https://127.0.0.1/clip.mp4',
    'http://example.com/clip.mp4',
  ])('leaves unsafe video directives unconsumed: %s', (source) => {
    const text = `MEDIA:${source}`;
    expect(normalizeContentBlocks([{ type: 'text', text }])).toEqual({ content: text });
  });

  it('keeps prose MEDIA mentions as text', () => {
    const normalized = normalizeContentBlocks([{ type: 'text', text: 'Use MEDIA:/tmp/out.png in a tool result' }]);

    expect(normalized).toEqual({ content: 'Use MEDIA:/tmp/out.png in a tool result' });
  });

  it('extracts supported image content blocks', () => {
    const normalized = normalizeContentBlocks([
      { type: 'text', text: 'Image ready' },
      { type: 'image', url: 'https://example.com/result.webp', alt: 'result.webp', mimeType: 'image/webp' },
    ]);

    expect(normalized).toEqual({
      content: 'Image ready',
      attachments: [{ fileName: 'result.webp', dataUrl: 'https://example.com/result.webp', mimeType: 'image/webp' }],
    });
  });

  it('resolves OpenClaw relative image blocks through the gateway HTTP base', () => {
    const normalized = normalizeContentBlocks(
      [
        {
          type: 'image',
          url: '/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full',
          alt: 'generated.png',
          mimeType: 'image/png',
        },
      ],
      'http://127.0.0.1:18789',
    );

    expect(normalized.attachments).toEqual([
      {
        fileName: 'generated.png',
        dataUrl:
          'http://127.0.0.1:18789/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full',
        mimeType: 'image/png',
      },
    ]);
  });

  it('treats OpenClaw same-origin MEDIA paths as gateway media instead of local files', () => {
    const normalized = normalizeContentBlocks(
      [{ type: 'text', text: 'MEDIA:/media/inbound/test-image.png' }],
      'http://127.0.0.1:18789',
    );

    expect(normalized.attachments).toEqual([
      {
        fileName: 'test-image.png',
        dataUrl: 'http://127.0.0.1:18789/media/inbound/test-image.png',
        mimeType: 'image/png',
      },
    ]);
  });

  it('does not treat OpenClaw gateway media paths as local files without an HTTP base', () => {
    const normalized = normalizeContentBlocks([{ type: 'text', text: 'MEDIA:/media/inbound/test-image.png' }]);

    expect(normalized).toEqual({ content: 'MEDIA:/media/inbound/test-image.png' });
  });

  it('rejects third-party HTTP image blocks even when MIME says image', () => {
    const normalized = normalizeContentBlocks([
      { type: 'image', url: 'http://example.com/result.png', alt: 'result.png', mimeType: 'image/png' },
    ]);

    expect(normalized).toEqual({ content: '' });
  });

  it('allows HTTP image blocks only on the configured gateway origin', () => {
    const normalized = normalizeContentBlocks(
      [
        {
          type: 'image',
          url: 'http://127.0.0.1:18789/media/inbound/test-image.png',
          alt: 'test-image.png',
          mimeType: 'image/png',
        },
      ],
      'http://127.0.0.1:18789',
    );

    expect(normalized.attachments).toEqual([
      {
        fileName: 'test-image.png',
        dataUrl: 'http://127.0.0.1:18789/media/inbound/test-image.png',
        mimeType: 'image/png',
      },
    ]);
  });

  it('preserves media-only assistant turns', () => {
    const rawMsgs: RawHistoryMessage[] = [
      {
        role: 'assistant',
        timestamp: 2000,
        content: [{ type: 'text', text: 'MEDIA:/Users/x/.openclaw/media/out.png' }],
      },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0].content).toBe('');
    expect(turns[0].attachments?.[0]?.fileName).toBe('out.png');
  });

  it('carries discovered assistant attachments through collapse', () => {
    const messages = collapseDiscoveredMessages(
      [
        {
          role: 'assistant',
          content: 'Image ready',
          timestamp: '2026-04-27T17:03:05.234Z',
          attachments: [{ fileName: 'out.png', dataUrl: 'file:///Users/x/out.png', mimeType: 'image/png' }],
        },
      ],
      'task-1',
    );

    expect(messages).toHaveLength(1);
    expect(messages[0].attachments).toEqual([
      { fileName: 'out.png', dataUrl: 'file:///Users/x/out.png', mimeType: 'image/png' },
    ]);
  });

  // 消息级 model —— 「这条回复到底是谁生成的」的唯一可信来源。
  // 形状是**实测**的（2026-09-13 打网关 chat.history + 读 transcript）：
  // assistant 记录带 role/content/api/provider/model/usage/stopReason/timestamp；
  // **user 记录没有 model**。模型自述不可信（会照抄历史），所以 UI 只认这个字段。
  it('每条 assistant 记录各带自己的 model，落到各自的 turn 上', () => {
    const rawMsgs: RawHistoryMessage[] = [
      { role: 'user', timestamp: 1000, content: [{ type: 'text', text: '第一个问题' }] },
      { role: 'assistant', timestamp: 2000, model: 'glm-4.7', content: [{ type: 'text', text: '回答一' }] },
      { role: 'user', timestamp: 3000, content: [{ type: 'text', text: '第二个问题' }] },
      { role: 'assistant', timestamp: 4000, model: 'qwen-turbo', content: [{ type: 'text', text: '回答二' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({ content: '回答一', model: 'glm-4.7' });
    expect(turns[1]).toMatchObject({ content: '回答二', model: 'qwen-turbo' });
  });

  it('同一次回复由多条记录拼成时，取最后一条带 model 的（产出最终正文的那次调用）', () => {
    const rawMsgs: RawHistoryMessage[] = [
      {
        role: 'assistant',
        timestamp: 2000,
        model: 'glm-4.7',
        content: [{ type: 'toolCall', id: 't1', name: 'read_file', arguments: {} }],
      },
      { role: 'toolResult', timestamp: 2500, content: [{ type: 'toolResult', id: 't1', result: 'ok' }] },
      { role: 'assistant', timestamp: 3000, model: 'kimi-k2-thinking', content: [{ type: 'text', text: '读完了' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ content: '读完了', model: 'kimi-k2-thinking' });
  });

  it('同一次回复里缺 model 的记录**不清空**已记下的值', () => {
    const rawMsgs: RawHistoryMessage[] = [
      {
        role: 'assistant',
        timestamp: 2000,
        model: 'glm-4.7',
        content: [{ type: 'toolCall', id: 't1', name: 'read_file', arguments: {} }],
      },
      { role: 'toolResult', timestamp: 2500, content: [{ type: 'toolResult', id: 't1', result: 'ok' }] },
      { role: 'assistant', timestamp: 3000, content: [{ type: 'text', text: '读完了' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0].model).toBe('glm-4.7');
  });

  it('没有 model 就是 undefined —— 不猜、不用会话级模型兜底', () => {
    const rawMsgs: RawHistoryMessage[] = [
      { role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: '老记录' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0].model).toBeUndefined();
  });

  it('gateway-injected 不是真模型，清洗掉', () => {
    const rawMsgs: RawHistoryMessage[] = [
      { role: 'assistant', timestamp: 2000, model: 'gateway-injected', content: [{ type: 'text', text: '默认注入' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0].model).toBeUndefined();
  });

  it('collapse 逐条保留 model（从网关整会话导入的那条路径）', () => {
    const messages = collapseDiscoveredMessages(
      [
        { role: 'user', content: '第一个问题', timestamp: '2026-04-27T17:03:05.000Z' },
        { role: 'assistant', content: '回答一', timestamp: '2026-04-27T17:03:05.100Z', model: 'glm-4.7' },
        { role: 'user', content: '第二个问题', timestamp: '2026-04-27T17:03:06.000Z' },
        { role: 'assistant', content: '回答二', timestamp: '2026-04-27T17:03:06.100Z', model: 'qwen-turbo' },
        { role: 'user', content: '第三个问题', timestamp: '2026-04-27T17:03:07.000Z' },
        { role: 'assistant', content: '注入的', timestamp: '2026-04-27T17:03:07.100Z', model: 'gateway-injected' },
      ],
      'task-1',
    );

    expect(messages.map((m) => m.model)).toEqual([undefined, 'glm-4.7', undefined, 'qwen-turbo', undefined, undefined]);
  });
});

/**
 * 推理**混在正文里**的模型（2026-09-14 线上实测 qwen3.5-27b）。
 *
 * 同一轮对话里各模型形状并不一致：
 *   deepseek / glm / kimi → `[{thinking}, {text}]`                    ← 规范形状，正文干净
 *   qwen3.5-27b           → `[{text: "<推理></think>\n<答案>"}]`      ← 只有闭标签、无 thinking 块
 *
 * 不切开的话，用户看到的正文就是一整段推理 —— 这正是「切模型后思考内容显示成正文」。
 */
describe('normalizeAssistantTurns —— 行内 </think> 分隔的推理', () => {
  const userMsg: RawHistoryMessage = { role: 'user', timestamp: 1000, content: [{ type: 'text', text: '你好' }] };

  it('⭐ 把 `推理</think>答案` 切成 thinkingContent + 干净的正文', () => {
    const rawMsgs: RawHistoryMessage[] = [
      userMsg,
      {
        role: 'assistant',
        timestamp: 2000,
        model: 'qwen3.5-27b',
        content: [
          {
            type: 'text',
            text: 'The user asked what model I am; I should answer directly. </think>\n你好，我是 clawrouter/qwen3.5-27b 模型。',
          },
        ],
      },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns).toHaveLength(1);
    expect(turns[0]!.thinkingContent).toBe('The user asked what model I am; I should answer directly.');
    expect(turns[0]!.content).toBe('你好，我是 clawrouter/qwen3.5-27b 模型。');
    expect(turns[0]!.content).not.toContain('</think>');
  });

  it('有结构化 thinking 块时**不动** text（那条路径本来就是对的）', () => {
    const rawMsgs: RawHistoryMessage[] = [
      userMsg,
      {
        role: 'assistant',
        timestamp: 2000,
        content: [
          { type: 'thinking', thinking: '结构化推理' },
          // 正文里也出现 </think>，但既然有 thinking 块，正文就按原样保留
          { type: 'text', text: '答案里提到 </think> 这个词' },
        ],
      },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns[0]!.thinkingContent).toBe('结构化推理');
    expect(turns[0]!.content).toBe('答案里提到 </think> 这个词');
  });

  it('没有 </think> 的普通正文不受影响', () => {
    const rawMsgs: RawHistoryMessage[] = [
      userMsg,
      { role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: '就是一句普通回复' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns[0]!.content).toBe('就是一句普通回复');
    expect(turns[0]!.thinkingContent).toBeFalsy();
  });

  it('闭标签在开头（没有推理可分离）⇒ 原样保留，不造空思考块', () => {
    const rawMsgs: RawHistoryMessage[] = [
      userMsg,
      { role: 'assistant', timestamp: 2000, content: [{ type: 'text', text: '</think>答案' }] },
    ];

    const turns = normalizeAssistantTurns(rawMsgs);

    expect(turns[0]!.content).toBe('</think>答案');
    expect(turns[0]!.thinkingContent).toBeFalsy();
  });
});
