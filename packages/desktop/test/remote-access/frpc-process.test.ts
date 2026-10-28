import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { FrpcProcess } from '../../src/main/remote-access/frpc-process.js';

/**
 * frpc 进程管理：真起不了二进制（机器上没有 frpc.exe），所以注入假 spawn。
 * 要钉住的是"崩了怎么重试、重试到什么时候放弃、停的时候别再回来"——
 * 这三件事错了，用户看到的就是"手机连不上但界面显示在线"。
 */

class FakeChild extends EventEmitter {
  pid = 1234;
  stdout = new PassThrough();
  stderr = new PassThrough();
  killed = false;

  kill = vi.fn(() => {
    this.killed = true;
    this.emit('exit', 0, 'SIGTERM');
    return true;
  });
}

function fakeSpawn() {
  const children: FakeChild[] = [];
  const impl = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  return { impl: impl as unknown as typeof import('node:child_process').spawn, children, calls: impl };
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

function makeProcess(spawn: ReturnType<typeof fakeSpawn>, overrides: Record<string, unknown> = {}) {
  return new FrpcProcess({
    binaryPath: '/fake/frpc',
    configPath: '/fake/frpc.toml',
    backoffMs: [10, 10, 10],
    maxFailures: 3,
    stableMs: 20,
    spawnImpl: spawn.impl,
    ...overrides,
  });
}

describe('FrpcProcess', () => {
  it('spawn 成功后进入 running', async () => {
    const spawn = fakeSpawn();
    const proc = makeProcess(spawn);

    proc.start();
    expect(proc.currentState).toBe('starting');

    spawn.children[0].emit('spawn');
    expect(proc.currentState).toBe('running');
    expect(spawn.calls).toHaveBeenCalledWith('/fake/frpc', ['-c', '/fake/frpc.toml'], expect.anything());

    await proc.stop();
  });

  it('异常退出后按退避重启，稳定后再崩计数清零', async () => {
    const spawn = fakeSpawn();
    const proc = makeProcess(spawn, { maxFailures: 5 });

    proc.start();
    spawn.children[0].emit('spawn');
    spawn.children[0].emit('exit', 1, null);
    expect(proc.currentState).toBe('restarting');

    await tick(40);
    expect(spawn.children).toHaveLength(2);
    expect(proc.currentState).toBe('starting');

    spawn.children[1].emit('spawn');
    expect(proc.currentState).toBe('running');

    // stableMs 到期后失败计数清零
    await tick(40);
    expect(proc.failureCount).toBe(0);

    await proc.stop();
  });

  it('连续失败到上限进 degraded，并且不再拉起', async () => {
    const spawn = fakeSpawn();
    const proc = makeProcess(spawn);

    proc.start();
    for (let i = 0; i < 3; i += 1) {
      const child = spawn.children[spawn.children.length - 1];
      child.emit('exit', 1, null);
      await tick(40);
    }

    expect(proc.currentState).toBe('degraded');
    expect(spawn.children).toHaveLength(3);

    // degraded 之后再等也不会再多起一个
    await tick(60);
    expect(spawn.children).toHaveLength(3);
  });

  it('stop 之后不再重启', async () => {
    const spawn = fakeSpawn();
    const proc = makeProcess(spawn, { maxFailures: 5 });

    proc.start();
    spawn.children[0].emit('spawn');
    await proc.stop();

    expect(proc.currentState).toBe('stopped');
    expect(spawn.children[0].killed).toBe(true);

    await tick(60);
    expect(spawn.children).toHaveLength(1);
    expect(proc.currentState).toBe('stopped');
  });

  it('spawn 抛异常时走同一条退避路径，而不是把错误扔给调用方', async () => {
    const impl = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const proc = new FrpcProcess({
      binaryPath: '/missing/frpc',
      configPath: '/fake/frpc.toml',
      backoffMs: [10],
      maxFailures: 2,
      spawnImpl: impl as unknown as typeof import('node:child_process').spawn,
    });

    proc.start();
    expect(proc.currentState).toBe('restarting');
    await tick(40);
    expect(proc.currentState).toBe('degraded');
  });
});
