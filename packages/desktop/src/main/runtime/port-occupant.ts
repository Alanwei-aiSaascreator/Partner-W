/**
 * 「18789 上是**谁**」—— 只读诊断，给"端口被占"这句错误补一条能排障的线索。
 *
 * 为什么要有它（BUG-040）：现场只有一句"端口被另一个 OpenClaw 网关占用"，
 * 用户与客服都无从下手 —— 是上一轮崩溃留下的孤儿网关？是同事装的另一个
 * OpenClaw？还是完全不相干的程序？**我们绝不主动结束它**（那可能是别的产品），
 * 但至少要说出"这个 pid/进程名在占着"，用户才有下一步可做。
 *
 * ⚠️ 三条纪律：
 *  - **只读**：只用 `netstat -ano`（列监听）与 `tasklist`（名字）。不发信号、不 kill。
 *  - **绝不抛**：查不到就回 `null`（诊断缺一条，不能把启动流程掀翻）。
 *  - **只说事实**：拿不到就不猜（宁可没有这句线索）。
 */

import { execFileSync } from 'node:child_process';

export interface PortOccupantClueOptions {
  /** 注入的命令执行（测试用）。 */
  run?: (exe: string, args: string[], timeoutMs: number) => string;
  timeoutMs?: number;
}

/** `netstat -ano` 里那一行的 pid（`… 127.0.0.1:18789 … LISTENING 1234`）。 */
export function parseListeningPid(output: string, port: number): number | null {
  for (const line of output.split(/\r?\n/u)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 5) continue;
    const local = fields[1] ?? '';
    if (!local.endsWith(`:${port}`)) continue;
    if (!/LISTENING/iu.test(line)) continue;
    const pid = Number(fields[fields.length - 1]);
    if (Number.isInteger(pid) && pid > 0) return pid;
  }
  return null;
}

/** `tasklist /FI "PID eq N" /FO CSV /NH` 里的进程名（`"node.exe","1234",…`）。 */
export function parseTasklistImage(output: string): string | null {
  const match = output.match(/"([^"]+\.exe)"/iu);
  return match ? match[1] : null;
}

/**
 * 占用者线索（人话短句）；查不到回 `null`。**只读**。
 */
export function describePortOccupant(port: number, options: PortOccupantClueOptions = {}): string | null {
  if (process.platform !== 'win32' && !options.run) return null;
  const timeoutMs = options.timeoutMs ?? 2_000;
  const run =
    options.run ??
    ((exe: string, args: string[], timeout: number) =>
      execFileSync(exe, args, { timeout, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  try {
    const pid = parseListeningPid(run('netstat', ['-ano', '-p', 'tcp'], timeoutMs), port);
    if (pid === null) return null;
    const image = (() => {
      try {
        return parseTasklistImage(run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], timeoutMs));
      } catch {
        return null;
      }
    })();
    return image ? `PID ${pid}（${image}）` : `PID ${pid}`;
  } catch {
    return null;
  }
}
