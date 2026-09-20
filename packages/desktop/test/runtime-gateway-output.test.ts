import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { attachGatewayOutputStreams, createGatewayOutputDrain } from '../src/main/runtime/gateway-output.js';
import type { GatewayOutputLine } from '../src/main/runtime/gateway-output.js';

/**
 * 网关子进程的 stdout/stderr **今天没有任何人排空**（`gateway-process.ts:360` 开了两条 pipe，
 * `toGatewayChild()` 只挂 `exit`）⇒ ①诊断黑洞 ②理论上管道写满会把子进程堵在 write。
 *
 * 这一组测试钉住"消费"那一侧的四件事，**按重要性排序**：
 * ①**脱敏**（网关是自由文本，`sanitizeForLog` 只按 key 名摘 ⇒ 值必须另抹）
 * ②有界（单行上限 + 尾部上限）
 * ③折叠（同一行刷屏）
 * ④限速（日志文件每天有 50 MB 上限，无限速会把当天的证据顶掉）
 */

/** 收集 sink 收到的行，方便断言"发了几条、长什么样"。 */
function collector() {
  const lines: GatewayOutputLine[] = [];
  return { lines, sink: (line: GatewayOutputLine) => lines.push(line) };
}

/** 固定时钟：默认不动，测试里手动推进。 */
function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe('网关输出：切行', () => {
  it('一个 chunk 里的多行各自成一条，残行留到下一个 chunk（不早发、不丢）', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({}, sink);

    drain.push('stdout', '第一行\n第二行\n没有换行的残');
    expect(lines.map((l) => l.text)).toEqual(['第一行', '第二行']);

    drain.push('stdout', '行\n');
    expect(lines.map((l) => l.text)).toEqual(['第一行', '第二行', '没有换行的残行']);
  });

  it('CRLF 当成一个换行，行尾不留 \\r', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({}, sink);
    drain.push('stderr', 'a\r\nb\r\n');
    expect(lines.map((l) => l.text)).toEqual(['a', 'b']);
  });

  it('flush 把没有换行结尾的残行吐出来（子进程退出时用）', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({}, sink);
    drain.push('stdout', '最后一行没有换行');
    expect(lines).toHaveLength(0);
    drain.flush();
    expect(lines.map((l) => l.text)).toEqual(['最后一行没有换行']);
  });

  it('带上流名（stdout / stderr 要分得开）', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({}, sink);
    drain.push('stdout', '出\n');
    drain.push('stderr', '错\n');
    expect(lines.map((l) => l.stream)).toEqual(['stdout', 'stderr']);
  });
});

describe('网关输出：脱敏（值，不只是 key 名）', () => {
  it('已知的 token 值在行里出现时被抹成 ***redacted***', () => {
    const { lines, sink } = collector();
    const token = 'tok_abcdefghijklmnop1234567890';
    const drain = createGatewayOutputDrain({ secrets: [token] }, sink);

    drain.push('stderr', `connect failed: authorization=${token} retry\n`);
    expect(lines[0]!.text).toBe('connect failed: authorization=***redacted*** retry');
    expect(lines[0]!.text).not.toContain(token);
  });

  it('Bearer 头与 URL 里的密码按模式抹（网关会把命令行/URL 原样打出来）', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({}, sink);

    drain.push('stdout', 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz\n');
    drain.push('stdout', 'ws://user:hunter2@127.0.0.1:18789/?token=x\n');

    expect(lines[0]!.text).toBe('Authorization: Bearer ***redacted***');
    expect(lines[1]!.text).toBe('ws://***redacted***@127.0.0.1:18789/?token=***redacted***');
  });

  it('未知的 query / JSON 凭据也抹掉，不能只依赖已知本地 token', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({}, sink);

    drain.push('stderr', 'GET https://x.test/?api_key=provider-secret&mode=1\n');
    drain.push('stderr', '{"password":"hunter2","message":"启动失败"}\n');

    expect(lines[0]!.text).toBe('GET https://x.test/?api_key=***redacted***&mode=1');
    expect(lines[1]!.text).toBe('{"password":"***redacted***","message":"启动失败"}');
  });

  it('太短的 secret 不当模式用（免得把正常文本抹成马赛克）', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({ secrets: ['ok', ''] }, sink);
    drain.push('stdout', 'look ok, book ok\n');
    expect(lines[0]!.text).toBe('look ok, book ok');
  });
});

describe('网关输出：有界（单行 + 尾部）', () => {
  it('超长行被截断并留下标记（网关会打整包 JSON，一行几十 KB）', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({ maxLineBytes: 64 }, sink);

    drain.push('stdout', `${'x'.repeat(5000)}\n`);
    const text = lines[0]!.text;
    expect(text.length).toBeLessThan(200);
    expect(text).toContain('<truncated len=5000>');
  });

  it('尾部缓冲按字节有界：只留最近的若干行', () => {
    const { sink } = collector();
    const drain = createGatewayOutputDrain({ tailBytes: 40 }, sink);

    for (let i = 1; i <= 10; i += 1) drain.push('stdout', `行-${i}-${'y'.repeat(6)}\n`);
    const tail = drain.tail();
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.join('\n').length).toBeLessThanOrEqual(40 + 12);
    expect(tail.at(-1)).toContain('行-10');
    expect(tail.join('\n')).not.toContain('行-1-');
  });

  it('尾部里存的是**脱敏之后**的文本（不能留一个能读到秘密的旁路）', () => {
    const { sink } = collector();
    const token = 'tok_abcdefghijklmnop1234567890';
    const drain = createGatewayOutputDrain({ secrets: [token] }, sink);
    drain.push('stdout', `using ${token}\n`);
    expect(drain.tail().join('\n')).not.toContain(token);
  });
});

describe('网关输出：折叠重复行', () => {
  it('连续重复行只在组结束时补一条摘要（首个立刻发，不为了折叠而延迟诊断）', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({}, sink);

    drain.push('stdout', '重试中\n重试中\n重试中\n换了个\n');

    expect(lines.map((l) => [l.text, l.repeat, l.summary])).toEqual([
      ['重试中', 1, false],
      ['重试中', 3, true],
      ['换了个', 1, false],
    ]);
  });

  it('flush 也会把"还没结束的重复组"摘要出来', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({}, sink);
    drain.push('stderr', 'e\ne\n');
    drain.flush();
    expect(lines.map((l) => [l.text, l.repeat, l.summary])).toEqual([
      ['e', 1, false],
      ['e', 2, true],
    ]);
  });

  it('不同流之间不互相折叠（stdout 的重复不该吃掉 stderr 的行）', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({}, sink);
    drain.push('stdout', '同\n');
    drain.push('stderr', '同\n');
    expect(lines.map((l) => [l.stream, l.text, l.summary])).toEqual([
      ['stdout', '同', false],
      ['stderr', '同', false],
    ]);
  });
});

describe('网关输出：限速（不丢信息，只丢条目并记账）', () => {
  it('重复摘要也占额度，交替刷 a,a,b,b 时不能绕过限速', () => {
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({ maxLinesPerSecond: 3 }, sink);

    drain.push('stdout', 'a\na\nb\nb\nc\nc\nd\n');

    expect(lines).toHaveLength(3);
    expect(drain.stats().dropped).toBeGreaterThan(0);
  });

  it('同一秒内超过上限的条数被计数，并在下一次可写时补进 dropped', () => {
    const c = clock();
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({ maxLinesPerSecond: 3, now: c.now }, sink);

    for (let i = 1; i <= 5; i += 1) drain.push('stdout', `n${i}\n`);

    expect(lines.map((l) => l.text)).toEqual(['n1', 'n2', 'n3']);
    expect(lines.every((l) => l.dropped === 0)).toBe(true);

    c.advance(1000);
    drain.push('stdout', 'n6\n');

    expect(lines.at(-1)!.text).toBe('n6');
    expect(lines.at(-1)!.dropped).toBe(2);
  });

  it('跨过一秒之后额度恢复', () => {
    const c = clock();
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({ maxLinesPerSecond: 1, now: c.now }, sink);

    drain.push('stdout', 'a\n');
    drain.push('stdout', 'b\n');
    c.advance(1001);
    drain.push('stdout', 'c\n');

    expect(lines.map((l) => [l.text, l.dropped])).toEqual([
      ['a', 0],
      ['c', 1],
    ]);
  });

  it('stats 自己跟自己对得上（收到多少行、发多少、压多少、折叠多少）', () => {
    const c = clock();
    const { lines, sink } = collector();
    const drain = createGatewayOutputDrain({ maxLinesPerSecond: 2, now: c.now }, sink);

    drain.push('stdout', 'a\na\nb\nc\nd\n');
    const s = drain.stats();

    expect(s.lines).toBe(5);
    expect(s.emitted).toBe(lines.length);
    expect(s.repeats).toBe(1);
    // a（发）+ a 组摘要（发）已经吃满额度；b/c/d 都被限速压掉。
    expect(s.emitted).toBe(2);
    expect(s.dropped).toBe(3);
  });
});

describe('网关输出：sink 抛错不能把读取循环带崩', () => {
  it('sink 抛错时吞掉并记账（消费管道是保命的事，比写日志重要）', () => {
    const onError = vi.fn();
    const drain = createGatewayOutputDrain({ onSinkError: onError }, () => {
      throw new Error('日志写挂了');
    });

    expect(() => drain.push('stdout', 'x\ny\n')).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(2);
    drain.flush();
  });

  it('连 onSinkError 自己抛错也不能打断管道消费', () => {
    const drain = createGatewayOutputDrain(
      {
        onSinkError: () => {
          throw new Error('错误回调也坏了');
        },
      },
      () => {
        throw new Error('日志写挂了');
      },
    );

    expect(() => drain.push('stdout', 'x\n')).not.toThrow();
  });
});

describe('网关输出：真实管道接线', () => {
  it('stdout/stderr 都被消费，子进程退出时 flush 残行', () => {
    const { lines, sink } = collector();
    const listeners: Partial<Record<'stdout' | 'stderr', (chunk: string) => void>> = {};
    let onClose: (() => void) | undefined;
    const stdout = {
      setEncoding: vi.fn(),
      on: vi.fn((_event: 'data', listener: (chunk: string) => void) => {
        listeners.stdout = listener;
      }),
    };
    const stderr = {
      setEncoding: vi.fn(),
      on: vi.fn((_event: 'data', listener: (chunk: string) => void) => {
        listeners.stderr = listener;
      }),
    };

    attachGatewayOutputStreams(
      {
        stdout,
        stderr,
        onClose: (listener) => {
          onClose = listener;
        },
      },
      {},
      sink,
    );

    expect(stdout.setEncoding).toHaveBeenCalledWith('utf8');
    expect(stderr.setEncoding).toHaveBeenCalledWith('utf8');
    listeners.stdout?.('out\n');
    listeners.stderr?.('残行');
    expect(lines.map((line) => line.text)).toEqual(['out']);
    onClose?.();
    expect(lines.map((line) => [line.stream, line.text])).toEqual([
      ['stdout', 'out'],
      ['stderr', '残行'],
    ]);
  });

  it('生产 spawn 路径确实调用管道消费器（不能只写一个没接上的工具）', () => {
    const source = readFileSync(join(__dirname, '../src/main/runtime/gateway-process.ts'), 'utf8');
    expect(source).toContain('attachGatewayOutputStreams(');
    expect(source).toContain('stdout: child.stdout');
    expect(source).toContain('stderr: child.stderr');
    expect(source).toContain("onClose: (listener) => child.once('close', listener)");
    // 用户/模型正文不能为了排障绕过 shared debug 的 content redaction；生产只落摘要指纹。
    expect(source).toContain('textDigest: gatewayOutputDigest(line.text)');
    expect(source).not.toContain('data: { ...line }');
  });
});
