import { describe, expect, it } from 'vitest';
import { REDACTED_CONTENT, isSecretKeyName, sanitizeForLog, summarizePayload } from '../src/debug.js';

/** 与既有 `debug-observability.test.ts` 里的字面量一致（那是**密钥**被摘的标记）。 */
const REDACTED = '***redacted***';

/**
 * 日志里**不许出现用户原话与模型正文**（外部审计 P3）。
 *
 * 加固前实测（本机 `logs/debug-*.ndjson`，不是推测）：网关帧被整包记进日志 ——
 *   - `chat.history` 的应答里 `messages[].content` 是**用户打过的原话**；
 *   - 流式事件 `content[].text` / `content[].thinking` 是**模型正文**；
 *   - `chat.send` 的参数里 `message` 就是**当前这句**。
 * 所以"截断到 500 字符 + 摘 token"不够：正文**整段**在里面。
 *
 * ⚠️ 这一组用例里**同权重**的是两条**负对照**（见文件下半部分）：
 *    摘错了比不摘更糟 —— 日志是我们查实机故障的唯一手段（[[desktop-debug-log-forensics]]），
 *    把我们的日志行 `message` 也一起摘掉，等于把"为什么失败"从日志里挖走。
 */

describe('sanitizeForLog —— 正文类字段一律摘掉', () => {
  it('⭐ chat.history 的 messages[].content：用户原话不落盘', () => {
    const frame = {
      messages: [
        { idempotencyKey: 'u1:user', message: { role: 'user', content: '我的身份证号是 330102199001011234' } },
        {
          idempotencyKey: 'u1:assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: '好的，我记住了' }] },
        },
      ],
    };

    const out = JSON.stringify(sanitizeForLog(frame));

    expect(out).not.toContain('330102199001011234');
    expect(out).not.toContain('好的，我记住了');
    expect(out).toContain(REDACTED_CONTENT);
  });

  it('⭐ 流式正文：content[].text 与 content[].thinking', () => {
    const frame = {
      type: 'content',
      content: [
        { type: 'thinking', thinking: '先看看他问的是不是计费问题' },
        { type: 'text', text: '这是模型的回答正文' },
      ],
    };

    const out = JSON.stringify(sanitizeForLog(frame));

    expect(out).not.toContain('先看看他问的是不是计费问题');
    expect(out).not.toContain('这是模型的回答正文');
  });

  it('键名大小写与嵌套深度都不影响（Content / TEXT 同样摘）', () => {
    const out = JSON.stringify(sanitizeForLog({ a: { b: [{ Content: '秘密正文', TEXT: '另一段' }] } }));

    expect(out).not.toContain('秘密正文');
    expect(out).not.toContain('另一段');
  });
});

describe('summarizePayload —— 聊天参数里的 message 是正文', () => {
  it('⭐ chat.send 的 params：用户这一句被摘掉，而结构还在', () => {
    const params = { sessionKey: 'sess-1', message: '帮我删掉 C 盘那个目录', idempotencyKey: 'req-1', deliver: false };

    const out = summarizePayload(params) as Record<string, unknown>;

    expect(out.message).toBe(REDACTED_CONTENT);
    // 结构必须留着 —— 查故障时要知道"当时是往哪个会话发的哪条请求"
    expect(out.sessionKey).toBe('sess-1');
    expect(out.idempotencyKey).toBe('req-1');
    expect(out.deliver).toBe(false);
  });
});

describe('负对照 —— 别把诊断信息一起摘掉（摘错了比不摘更糟）', () => {
  it('⭐ 我们自己的日志行：sessionKey + message 是**说明文字**，必须原样留下', () => {
    // 这是 DebugEvent 的形状（实测 `logger.info({domain:'gateway', event:'...', message:'...'})`）
    const event = {
      ts: '2026-09-20T00:00:00.000Z',
      level: 'warn',
      domain: 'gateway',
      event: 'gateway.res.error',
      sessionKey: 'sess-1',
      message: 'Heartbeat has no delivery route yet',
    };

    const out = summarizePayload(event) as Record<string, unknown>;

    expect(out.message, '说明文字被摘掉 = 日志不再能查故障').toBe('Heartbeat has no delivery route yet');
  });

  it('⭐ `contentLength` / `contentType` 这种"长得像"的键不许误伤', () => {
    const out = summarizePayload({ data: { contentLength: 42, contentType: 'text/plain', attachmentCount: 2 } }) as {
      data: Record<string, unknown>;
    };

    expect(out.data.contentLength).toBe(42);
    expect(out.data.contentType).toBe('text/plain');
    expect(out.data.attachmentCount).toBe(2);
  });

  it('既有行为不许回退：密钥仍然被摘、长字符串仍然截断', () => {
    const long = 'x'.repeat(900);
    const out = summarizePayload({ token: 'sekret', authorization: 'Bearer abc', note: long }) as Record<
      string,
      unknown
    >;

    expect(out.token).toBe(REDACTED);
    expect(out.authorization).toBe(REDACTED);
    expect(out.note).toBe('x'.repeat(500) + '…<truncated len=900>');
  });
});

/**
 * BUG-056⑤：密钥键名家族缺口 —— 原正则只有 token/password/secret/authorization/cookie/
 * pairingcode/bootstraptoken，**不含 apiKey / relayKey**。
 *
 * ⚠️ 口径：这是**机制缺口**（relay key 以 `apiKey` 键写入网关配置，见
 *    `main/commercial/relay-config.ts`），本组测试不声称已发生泄漏。
 */
describe('BUG-056⑤ —— apiKey / relayKey 家族（含大小写与分隔符变体）必须被摘', () => {
  const SECRET_KEYS: Record<string, string> = {
    apiKey: 'sk-family-1',
    APIKEY: 'sk-family-2',
    ApiKey: 'sk-family-3',
    api_key: 'sk-family-4',
    API_KEY: 'sk-family-5',
    'api-key': 'sk-family-6',
    relayKey: 'rly-family-1',
    RelayKey: 'rly-family-2',
    RELAY_KEY: 'rly-family-3',
    relay_key: 'rly-family-4',
    'relay-key': 'rly-family-5',
  };

  it('⭐ 键名家族一个不漏：每种写法对应的值都不落盘', () => {
    const out = JSON.stringify(sanitizeForLog(SECRET_KEYS));

    for (const [key, secret] of Object.entries(SECRET_KEYS)) {
      expect(out, `键 ${key} 的密钥漏了`).not.toContain(secret);
    }
    expect(out.match(/\*\*\*redacted\*\*\*/g) ?? []).toHaveLength(Object.keys(SECRET_KEYS).length);
  });

  it('深层 object / array 里的变体同样命中（不看深度）', () => {
    const frame = {
      data: {
        gateways: [{ config: { apiKey: 'deep-secret-1' } }],
        snapshot: [{ relay_key: 'deep-secret-2' }],
      },
    };

    const out = JSON.stringify(sanitizeForLog(frame));

    expect(out).not.toContain('deep-secret-1');
    expect(out).not.toContain('deep-secret-2');
  });

  it('公共规则以函数形式导出：`isSecretKeyName` 与 sanitize 的行为同源', () => {
    for (const key of Object.keys(SECRET_KEYS)) expect(isSecretKeyName(key), key).toBe(true);
    for (const key of ['token', 'password', 'secret', 'authorization', 'cookie', 'pairingCode', 'bootstrapToken']) {
      expect(isSecretKeyName(key), key).toBe(true);
    }
  });

  it('⭐ 负对照：正常业务字段不误抹（键名里出现 key/api 但不是密钥名）', () => {
    const business = {
      apiVersion: 'v1',
      capacity: 42,
      keyboard: 'ctrl',
      monkey: 'chunky',
      keyResult: 'ok',
      relayLatency: 12,
      apiName: 'catalog',
    };

    const out = summarizePayload(business) as Record<string, unknown>;

    expect(out).toMatchObject(business);
    expect(JSON.stringify(out)).not.toContain(REDACTED);
  });

  it('⭐ 不修改原对象：脱敏返回新对象，输入逐字不变', () => {
    const input = {
      apiKey: 'sk-keep-original',
      nested: { relayKey: 'rly-keep-original', list: [{ api_key: 'sk-nested' }] },
    };
    const snapshot = JSON.stringify(input);

    const out = sanitizeForLog(input);

    expect(JSON.stringify(input), '脱敏不得原地改写调用方的对象').toBe(snapshot);
    expect(out).not.toBe(input);
    expect(JSON.stringify(out)).not.toContain('sk-keep-original');
    expect(JSON.stringify(out)).not.toContain('rly-keep-original');
  });
});
