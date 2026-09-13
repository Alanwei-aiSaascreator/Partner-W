import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * 「这个 profile 的持久会话**被写过几次、什么时候写的**」—— 纯外部观察。
 *
 * ## 为什么需要它（2026-09-13）
 *
 * 2B 的 6b 卡在一个问题上：heal 之后 upstream 明明回了一个**新的** refresh token，
 * 可客户端后续请求仍然带着**旧的**。到底卡在哪一层，有三种可能：
 *
 *   P2 `_saveSession` 压根没执行
 *   P3 执行了但 `storage.setItem` 失败
 *   P4 落盘了、但内存里的会话还是旧的（超时遗留的旧 Promise 晚到覆盖）
 *
 * 产品侧的 storage adapter（`commercial/client.ts`）把会话写成
 * `commercial-session.json`（`safeStorage` 密文）。**测试进程解不开**它 ——
 * DPAPI 的密钥在 profile 的 `Local State` 里，只有 Electron 自己能解。
 * 但我们**不需要**解开：
 *
 * 1. `safeStorage.encryptString()` 内部用随机 IV ⇒ 同一份明文每次密文都不同。
 *    所以观察到的每一次内容变化，都对应一次**真实的持久化写入**。
 * 2. 写是**有序**的。把每次变化的时刻记下来，就能分辨
 *    「只写了一次」和「写完又被覆盖回去」（A → B → A，见 6b 的 `finally` 报告）。
 *
 * ## ⚠️ 这份观察**只说一件事**
 *
 * 准确语义只有一句：
 *
 *   > `commercial-session.json` 在**该时间点发生了一次持久化写入 / 内容变化**。
 *
 * 它**不**声称"这份内容就是 refresh token B"。密文与明文之间**没有**可用的
 * 密码学对应关系（随机 IV ⇒ 无法比对、无法反推）。
 * `A`/`B` 的身份是**另外三条证据合起来**支持的：
 *
 *   - 代理侧逐请求的 `reqRT` / `upRT` 指纹（`auth-fault-proxy.ts`）
 *   - 写入时刻与那次 `/token` 200 的**时间线对齐**
 *   - 最终 `commercial.auth.probe = authenticated`（说明确实用上了新会话）
 *
 * ## 为什么 `fs.watch` + 轮询**两条腿**
 *
 * `fs.watch` 在 Windows 上走 `ReadDirectoryChangesW`，提供**即时**观察；
 * 但它的**投递不构成可靠性契约**（可能合并或丢事件），所以另有 250ms 轮询兜底。
 * 两条腿都按 `(mtimeMs, size, sha256)` 去重 ⇒ 同一个写不会被记两遍。
 * ⚠️ 本观察器**不声称无遗漏**；它给的是"发生过写入"的证据与顺序。
 *
 * ## 纪律
 *
 * 只读、只看元数据与**整个文件**的哈希，**绝不**输出密文内容、更不解密。
 */
const SESSION_FILE = 'commercial-session.json';

export interface SessionStoreSample {
  /** 从观察器启动算起的序号，1 开始（0 是基线）。 */
  seq: number;
  /** 相对观察器启动的毫秒数。 */
  tMs: number;
  /** 采样时刻（绝对，用来和日志时间线对齐）。 */
  at: number;
  exists: boolean;
  size: number;
  mtimeMs: number;
  /** 整个文件的 sha256（前 16 hex）。密文 ≠ 明文，这里不泄露任何凭证。 */
  sha256: string | null;
}

export interface SessionStoreWatcher {
  /** 观察器启动时的快照（= provision 刚铺完的**种子**状态）。 */
  baseline: SessionStoreSample;
  /** 全部采样（含基线）。 */
  samples: () => SessionStoreSample[];
  /** 基线之后的**变化**（每次都是一个真实的 `setItem` / `removeItem`）。 */
  changes: () => SessionStoreSample[];
  /** 人读的时间线，直接贴进报告。 */
  report: () => string;
  stop: () => void;
}

function sample(dir: string, seq: number, tMs: number): SessionStoreSample {
  const file = path.join(dir, SESSION_FILE);
  const at = Date.now();
  let exists = false;
  let size = 0;
  let mtimeMs = 0;
  let sha256: string | null = null;
  try {
    const st = fs.statSync(file);
    exists = true;
    size = st.size;
    mtimeMs = st.mtimeMs;
    sha256 = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
  } catch {
    /* 不存在 —— 保持 exists=false，不是错误 */
  }
  return { seq, tMs, at, exists, size, mtimeMs, sha256 };
}

/**
 * 盯着一个 profile 里的 `commercial-session.json`。
 *
 * ⚠️ 必须在 **`provisionProfile` 之后、应用启动之前**调用 —— 否则基线会取到
 * 已经被应用改过的状态，"到底写没写"就分不清了（见 6b 里 `afterProvision` 钩子）。
 */
export function watchSessionStore(dir: string, opts: { pollMs?: number } = {}): SessionStoreWatcher {
  const startedAt = Date.now();
  const samples: SessionStoreSample[] = [];
  let seq = 0;
  let lastKey = '';

  const record = (force: boolean): void => {
    const s = sample(dir, seq, Date.now() - startedAt);
    const key = `${s.exists}|${s.size}|${s.mtimeMs}|${s.sha256}`;
    if (!force && key === lastKey) return;
    lastKey = key;
    seq += 1;
    s.seq = seq - 1;
    samples.push(s);
  };

  record(true);
  const baseline = samples[0]!;

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, (_event, filename) => {
      // filename 可能为 null（平台差异）⇒ 拿不到名字也照采一次，靠去重兜住。
      if (filename && String(filename) !== SESSION_FILE) return;
      record(false);
    });
    watcher.on('error', () => {
      /* 目录被删/权限变化：不抛，轮询那条腿还在 */
    });
  } catch {
    /* fs.watch 起不来（少见）⇒ 只剩轮询，仍然可用 */
  }

  const timer = setInterval(() => record(false), opts.pollMs ?? 250);

  return {
    baseline,
    samples: () => samples.map((s) => ({ ...s })),
    changes: () => samples.filter((s) => s.seq > 0).map((s) => ({ ...s })),
    report: () => {
      const ch = samples.filter((s) => s.seq > 0);
      const head =
        `商业会话文件：基线 sha256=${baseline.sha256 ?? '-'} size=${baseline.size} ` +
        `mtime=${baseline.exists ? new Date(baseline.mtimeMs).toISOString() : '-'}\n` +
        `写入次数（基线之后）：**${ch.length}**`;
      if (ch.length === 0) return `${head}\n  ⇒ 整个观察窗口内 setItem / removeItem **一次都没发生**`;
      return (
        head +
        '\n' +
        ch
          .map(
            (s) =>
              `  #${s.seq} T+${(s.tMs / 1000).toFixed(1)}s ` +
              `@${new Date(s.at).toISOString()} ` +
              `${s.exists ? `size=${s.size} sha256=${s.sha256}` : '**文件被删除**'}`,
          )
          .join('\n')
      );
    },
    stop: () => {
      clearInterval(timer);
      try {
        watcher?.close();
      } catch {
        /* 已经关了 */
      }
    },
  };
}
