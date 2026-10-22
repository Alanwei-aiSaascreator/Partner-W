import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

/**
 * frpc 子进程生命周期（技术方案 v1.2 §5.2）。
 *
 * 为什么自己管重试、不用 frpc 自带的：frpc 的 `loginFailExit=false` 会自己一直重连，
 * 与桌面壳的退避叠加会出现"双倍重试 + 状态说不清"。所以关掉它的自动退出，
 * 由这里按 1/2/5/15/60s 退避，连续 5 次进 `degraded`，界面才有话可说。
 *
 * ⚠️ 状态只在本进程内可见，落盘由 RemoteAccessService 负责（两者分开：
 *    进程管理要保持纯粹，方便注入假 spawn 做单测）。
 */

export type FrpcState = 'stopped' | 'starting' | 'running' | 'restarting' | 'degraded';

export interface FrpcProcessOptions {
  binaryPath: string;
  configPath: string;
  /** 追加写日志文件；不传则不落盘（测试用）。 */
  logPath?: string;
  /** 退避序列，默认 1/2/5/15/60s。 */
  backoffMs?: readonly number[];
  /** 连续失败多少次进 degraded，默认 5。 */
  maxFailures?: number;
  /** 稳定运行多久后把失败计数清零，默认 30s。 */
  stableMs?: number;
  /** 注入点（测试用假 spawn）。 */
  spawnImpl?: typeof nodeSpawn;
  logger?: (event: string, data?: Record<string, unknown>) => void;
}

const DEFAULT_BACKOFF = [1_000, 2_000, 5_000, 15_000, 60_000] as const;

export class FrpcProcess {
  private readonly binaryPath: string;
  private readonly configPath: string;
  private readonly logPath?: string;
  private readonly backoff: readonly number[];
  private readonly maxFailures: number;
  private readonly stableMs: number;
  private readonly spawnImpl: typeof nodeSpawn;
  private readonly logger?: FrpcProcessOptions['logger'];

  private child: ChildProcess | null = null;
  private state: FrpcState = 'stopped';
  private failures = 0;
  private stopping = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private logStream: WriteStream | null = null;

  constructor(options: FrpcProcessOptions) {
    this.binaryPath = options.binaryPath;
    this.configPath = options.configPath;
    this.logPath = options.logPath;
    this.backoff = options.backoffMs ?? DEFAULT_BACKOFF;
    this.maxFailures = options.maxFailures ?? 5;
    this.stableMs = options.stableMs ?? 30_000;
    this.spawnImpl = options.spawnImpl ?? nodeSpawn;
    this.logger = options.logger;
  }

  get currentState(): FrpcState {
    return this.state;
  }

  get failureCount(): number {
    return this.failures;
  }

  /** 幂等：已经在跑或等待重试时直接返回。 */
  start(): void {
    if (this.child || this.restartTimer) return;
    this.stopping = false;
    this.failures = 0;
    this.state = 'starting';
    this.spawnOnce();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.clearTimers();

    const child = this.child;
    if (!child) {
      this.state = 'stopped';
      this.closeLog();
      return;
    }

    // 先挂 exit 监听再 kill：真实进程 kill 是异步的，但同步退出的实现（含测试替身）
    // 会在 kill() 里就发事件 —— 顺序反了就会白等 2 秒超时。
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });

    this.child = null;
    this.state = 'stopped';
    this.closeLog();
    this.logger?.('frpc.stopped', {});
  }

  private spawnOnce(): void {
    let handled = false;
    const once = (fn: () => void) => {
      if (handled) return;
      handled = true;
      fn();
    };

    let child: ChildProcess;
    try {
      child = this.spawnImpl(this.binaryPath, ['-c', this.configPath], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      once(() => this.scheduleRestart(`spawn threw: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }

    this.child = child;
    this.attachLog(child);

    child.once('spawn', () => {
      if (this.stopping) return;
      this.state = 'running';
      this.logger?.('frpc.spawned', { pid: child.pid });
      this.clearStableTimer();
      this.stableTimer = setTimeout(() => {
        this.failures = 0;
      }, this.stableMs);
    });

    child.once('error', (err: Error) => {
      once(() => {
        this.child = null;
        this.clearStableTimer();
        this.scheduleRestart(`spawn error: ${err.message}`);
      });
    });

    child.once('exit', (code, signal) => {
      once(() => {
        this.child = null;
        this.clearStableTimer();
        if (this.stopping) {
          this.state = 'stopped';
          return;
        }
        this.scheduleRestart(`exit code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      });
    });
  }

  private scheduleRestart(reason: string): void {
    this.failures += 1;
    this.logger?.('frpc.exit', { reason, failures: this.failures });

    if (this.failures >= this.maxFailures) {
      this.state = 'degraded';
      this.logger?.('frpc.degraded', { failures: this.failures });
      return;
    }

    const delay = this.backoff[Math.min(this.failures - 1, this.backoff.length - 1)];
    this.state = 'restarting';
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.state = 'starting';
      this.spawnOnce();
    }, delay);
  }

  private attachLog(child: ChildProcess): void {
    if (!this.logPath) return;
    try {
      mkdirSync(dirname(this.logPath), { recursive: true });
      if (!this.logStream) this.logStream = createWriteStream(this.logPath, { flags: 'a' });
      const stream = this.logStream;
      child.stdout?.on('data', (chunk: Buffer) => stream.write(chunk));
      child.stderr?.on('data', (chunk: Buffer) => stream.write(chunk));
    } catch (err) {
      this.logger?.('frpc.log.open-failed', { message: err instanceof Error ? err.message : String(err) });
    }
  }

  private clearTimers(): void {
    this.clearStableTimer();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private closeLog(): void {
    this.logStream?.end();
    this.logStream = null;
  }
}
