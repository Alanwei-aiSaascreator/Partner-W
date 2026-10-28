import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAuthBootstrap } from '../src/renderer/lib/app-entry-flow';

/**
 * 启动时的会话检查（B7）。
 *
 * ## 要修的是什么
 *
 * 会话检查（`commercial:session` → supabase `getUser()`）**每次都要发网络**，
 * 主进程给它 8 秒上限；而界面这边另有一个更短的兜底：**5 秒还没结论就当未登录**。
 * 两个时限的**顺序是反的** ⇒ 网络一慢，一个**已经登录**的用户在 5 秒时被扔进登录页；
 * 等 8 秒后真答案回来，界面又从登录页**弹**进工作区。
 *
 * ## 修法（用户拍板的口径）
 *
 * 加一个**不发网络**的本地快速态（"本地存着一个会话吗"）：
 * - 快速态**命中** ⇒ 兜底**不改判**（保持校验中），把结论权留给后台的真答案；
 * - 快速态**缺席** ⇒ 照旧（没有会话可等，回登录页是对的）；
 * - 快速态**绝不**能把 authState 推成 `'ok'` —— 那是"本地有 token 即已登录"，
 *   正是拍板里**不许**做的那件事。
 */

type Session = { signedIn: boolean; nickname?: string };

interface Harness {
  settled: Array<{ session: Session | null; authState: string }>;
  timedOut: string[];
  cancel: () => void;
  resolveBackend: (session: Session) => void;
  rejectBackend: (err: unknown) => void;
  /** 后台校验**被发起了几次**（口径 3 要能断言"没发"）。 */
  backendCalls: () => number;
}

function start(opts: { localSession?: boolean | Promise<boolean>; timeoutMs?: number }): Harness {
  const settled: Harness['settled'] = [];
  const timedOut: string[] = [];
  let resolveBackend!: (s: Session) => void;
  let rejectBackend!: (e: unknown) => void;
  let backendCalls = 0;
  const backend = new Promise<Session>((res, rej) => {
    resolveBackend = res;
    rejectBackend = rej;
  });

  const cancel = runAuthBootstrap<Session>({
    readLocalSession: () => Promise.resolve(opts.localSession ?? false),
    checkBackend: () => {
      backendCalls += 1;
      return backend;
    },
    isSignedIn: (session) => session.signedIn,
    timeoutMs: opts.timeoutMs ?? 5000,
    onSettled: (session, authState) => settled.push({ session, authState }),
    onTimeout: (authState) => timedOut.push(authState),
  });

  return { settled, timedOut, cancel, resolveBackend, rejectBackend, backendCalls: () => backendCalls };
}

/** 让 `readLocalSession` 那个微任务先落地。 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('runAuthBootstrap —— 会话检查', () => {
  it('后台说已登录 ⇒ ok（这是**唯一**能得出"已登录"的来源）', async () => {
    vi.useFakeTimers();
    const h = start({ localSession: true });

    h.resolveBackend({ signedIn: true, nickname: '小明' });
    await flushMicrotasks();

    expect(h.settled).toEqual([{ session: { signedIn: true, nickname: '小明' }, authState: 'ok' }]);
    expect(h.timedOut, '已经有结论了就不该再触发兜底').toEqual([]);
  });

  it('⭐ 快速态命中 + 后台**说未登录** ⇒ 回未登录（本地有 token 不算数）', async () => {
    vi.useFakeTimers();
    const h = start({ localSession: true });

    h.resolveBackend({ signedIn: false });
    await flushMicrotasks();

    expect(h.settled).toEqual([{ session: { signedIn: false }, authState: 'required' }]);
  });

  it('⭐ 快速态命中 + 后台**还没返回** ⇒ 保持"校验中"，**不许**改判未登录', async () => {
    vi.useFakeTimers();
    const h = start({ localSession: true, timeoutMs: 5000 });

    await flushMicrotasks();
    vi.advanceTimersByTime(5000);

    expect(h.timedOut).toEqual(['checking']);
    expect(h.settled).toEqual([]);
  });

  it('⭐⭐ 快速态**缺席** ⇒ **直接**回未登录，且**不发**那一次无谓请求', async () => {
    // 口径 3：「本地无 token ⇒ 直接未登录，**不发无谓请求**」。
    //
    // 为什么这是**安全的**（不是"本地说了算"）：本地那份会话文件和 supabase-js 的存储
    // 是**同一份字节** —— `createStorage()` 的 `getItem` 就是 `readSecure(sessionFilePath())`，
    // 而 `hasLocalSession()` 读的也正是它。⇒ 本地判"没有 token"时，
    // **后台必然也判未登录**（`getUser()` 拿不到会话）。这不是"本地当结论"，是**等价**。
    vi.useFakeTimers();
    const h = start({ localSession: false, timeoutMs: 5000 });

    await flushMicrotasks();

    expect(h.settled).toEqual([{ session: null, authState: 'required' }]);
    expect(h.backendCalls(), '本地已确定没有会话 ⇒ 那次往返是白跑的').toBe(0);
    expect(h.timedOut, '已经收场了，兜底不该再说话').toEqual([]);
  });

  it('⭐ 对照：快速态**命中** ⇒ 后台校验**照发**（这是"已登录"的唯一来源）', async () => {
    vi.useFakeTimers();
    const h = start({ localSession: true, timeoutMs: 5000 });

    await flushMicrotasks();

    expect(h.backendCalls()).toBe(1);
    expect(h.settled, '还没结论，不许先收场').toEqual([]);
  });

  it('⭐⭐ 边界：快速态**读不出来**（reject）⇒ **仍然问后台**，不当成"缺席"去短路', async () => {
    // ⚠️ 这条是 `hasLocalSession()` docblock 里那条既有决定的钉子：
    //    「读不出来（没有文件 / JSON 坏 / 密文解不开）一律当**缺席**：宁可回到**今天的行为**」。
    //    "今天的行为" = 问后台。所以**读失败不能短路** —— 那会把"读不到"变成"没登录"。
    //    （读**成功**且为空才是口径 3 说的那种"没有 token"。）
    vi.useFakeTimers();
    const h = start({ localSession: Promise.reject(new Error('ipc down')), timeoutMs: 5000 });

    await flushMicrotasks();

    expect(h.backendCalls(), '读不出来 ≠ 没有：不能凭它短路').toBe(1);
  });

  it('⭐⭐ 后台**超时**（reject）⇒ 走既有回退回未登录，**不因本地有 token 误判已登录**', async () => {
    // 口径 4：不改 401/402/超时那些分支的行为 —— fail closed，与今天一致。
    // 主进程那侧的超时（`NETWORK_TIMEOUT_MS` = 8s）到界面这一侧就是一次 reject。
    vi.useFakeTimers();
    const h = start({ localSession: true, timeoutMs: 5000 });

    h.rejectBackend(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }));
    await flushMicrotasks();

    expect(h.settled).toEqual([{ session: null, authState: 'required' }]);
    expect(h.settled[0]!.authState, '本地有 token **不是**"已登录"的结论').not.toBe('ok');
  });

  it('⚠️ 快速态命中、兜底放过之后，后台**迟到**的"未登录"仍然说了算', async () => {
    // 这条是"本地有 token 即已登录"那个错法的最后一道闸：
    // 兜底只是**不改判**，绝不等于**认定**。
    vi.useFakeTimers();
    const h = start({ localSession: true, timeoutMs: 5000 });

    await flushMicrotasks();
    vi.advanceTimersByTime(5000);
    expect(h.timedOut).toEqual(['checking']);

    h.resolveBackend({ signedIn: false });
    await flushMicrotasks();

    expect(h.settled).toEqual([{ session: { signedIn: false }, authState: 'required' }]);
  });

  it('后台**抛错** ⇒ 按未登录收场（fail closed，与今天一致）', async () => {
    vi.useFakeTimers();
    const h = start({ localSession: true });

    h.rejectBackend(new Error('boom'));
    await flushMicrotasks();

    expect(h.settled).toEqual([{ session: null, authState: 'required' }]);
  });

  it('本地快速态**读不出来**（reject）⇒ 按缺席处理', async () => {
    vi.useFakeTimers();
    const h = start({ localSession: Promise.reject(new Error('ipc down')), timeoutMs: 5000 });

    await flushMicrotasks();
    vi.advanceTimersByTime(5000);

    expect(h.timedOut).toEqual(['required']);
  });

  it('⭐⭐ 先**取消**（卸载）、本地那步才回来 ⇒ 一次请求都不许发', async () => {
    // ⚠️ 这条钉的是 `askBackend` 里那个 `done` 检查。
    //    读本地会话是**异步**的 ⇒ 它回来时组件可能**已经卸载**（`cancel()`）。
    //    少了那个检查不会出错（`settle` 也是幂等的），但会**白发一次网络** ——
    //    而这正是本项要消掉的那类"无谓请求"。
    vi.useFakeTimers();
    let resolveLocal!: (v: boolean) => void;
    const local = new Promise<boolean>((r) => {
      resolveLocal = r;
    });
    const h = start({ localSession: local, timeoutMs: 5000 });

    await flushMicrotasks();
    expect(h.backendCalls(), '本地还没回来 ⇒ 这一趟本来就还没发').toBe(0);

    h.cancel();
    resolveLocal(true); // 迟到的"命中"
    await flushMicrotasks();
    vi.advanceTimersByTime(60_000);

    expect(h.backendCalls(), '已经取消了 ⇒ 不许再发').toBe(0);
    expect(h.settled).toEqual([]);
    expect(h.timedOut).toEqual([]);
  });

  it('取消之后**不再有任何回调**（组件卸载 / 已登录）', async () => {
    vi.useFakeTimers();
    const h = start({ localSession: true });

    h.cancel();
    await flushMicrotasks();
    vi.advanceTimersByTime(60_000);
    h.resolveBackend({ signedIn: true });
    await flushMicrotasks();

    expect(h.settled).toEqual([]);
    expect(h.timedOut).toEqual([]);
  });

  it('后台比兜底更快 ⇒ 兜底不再说话（两条时限只有一条生效）', async () => {
    vi.useFakeTimers();
    const h = start({ localSession: true, timeoutMs: 5000 });

    vi.advanceTimersByTime(4999);
    h.resolveBackend({ signedIn: true });
    await flushMicrotasks();
    vi.advanceTimersByTime(60_000);

    expect(h.settled).toHaveLength(1);
    expect(h.timedOut).toEqual([]);
  });
});
