import { describe, expect, it, vi } from 'vitest';
import { describePortOccupant, parseListeningPid, parseTasklistImage } from '../src/main/runtime/port-occupant.js';

/**
 * BUG-040：端口被占的错误信息必须带**能排障的线索**。
 *
 * ⚠️ 这个模块是**只读**诊断：净是 `netstat -ano` 与 `tasklist`，不发信号、不 kill。
 */

const NETSTAT = `
活动连接

  协议  本地地址          外部地址        状态           PID
  TCP    127.0.0.1:49500        0.0.0.0:0              LISTENING       5678
  TCP    127.0.0.1:18789        0.0.0.0:0              LISTENING       1234
  TCP    127.0.0.1:18789        127.0.0.1:52001        ESTABLISHED     1234
`;

describe('端口占用者线索（只读）', () => {
  it('从 netstat 输出里取监听该端口的 pid', () => {
    expect(parseListeningPid(NETSTAT, 18789)).toBe(1234);
    expect(parseListeningPid(NETSTAT, 49500)).toBe(5678);
    expect(parseListeningPid(NETSTAT, 18790)).toBeNull();
    // ⚠️ ESTABLISHED 那行不能算（它只是复用同一个 pid 的连接）—— 取的是 LISTENING
    expect(
      parseListeningPid('  TCP    127.0.0.1:18789        127.0.0.1:52001        ESTABLISHED     999\n', 18789),
    ).toBeNull();
  });

  it('从 tasklist 的 CSV 行里取进程名', () => {
    expect(parseTasklistImage('"node.exe","1234","Console","1","85,000 K"')).toBe('node.exe');
    expect(parseTasklistImage('信息: 没有运行的任务匹配指定标准。')).toBeNull();
  });

  it('线索是人话短句（pid + 进程名）；拿不到名字也照样给 pid', () => {
    const run = vi.fn((exe: string) => (exe === 'netstat' ? NETSTAT : '"node.exe","1234","Console","1","85,000 K"'));
    expect(describePortOccupant(18789, { run })).toBe('PID 1234（node.exe）');

    const withoutName = vi.fn((exe: string) => {
      if (exe === 'netstat') return NETSTAT;
      throw new Error('tasklist 不可用');
    });
    expect(describePortOccupant(18789, { run: withoutName })).toBe('PID 1234');
  });

  it('⭐ 查不到就回 null（诊断缺一条，也不能把启动流程掀翻）', () => {
    expect(describePortOccupant(18789, { run: () => '' })).toBeNull();
    expect(
      describePortOccupant(18789, {
        run: () => {
          throw new Error('netstat 不存在');
        },
      }),
    ).toBeNull();
  });
});
