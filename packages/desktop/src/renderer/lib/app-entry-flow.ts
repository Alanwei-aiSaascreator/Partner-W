export type AppEntryScreen = 'loading' | 'login' | 'onboarding' | 'setup' | 'workspace';

export interface AppEntryState {
  authState: 'checking' | 'required' | 'ok';
  onboardingResolved: boolean;
  hasOnboardingAccount: boolean;
  hasOnboardingProfile: boolean;
  needsSetup: boolean;
  ready: boolean;
}

export function resolveAppEntryScreen(state: AppEntryState): AppEntryScreen {
  if (state.authState === 'checking') return 'loading';
  if (state.authState === 'required') return 'login';
  if (!state.onboardingResolved || !state.hasOnboardingAccount) return 'loading';
  if (!state.hasOnboardingProfile) return 'onboarding';
  if (state.needsSetup) return 'setup';
  if (!state.ready) return 'loading';
  return 'workspace';
}

/**
 * 启动时的会话检查（B7）。
 *
 * ## 修的是什么
 *
 * 会话检查（`commercial:session` → supabase 的 `getUser()`）**每次都要发网络**，
 * 主进程给它 8 秒上限；界面这边另有一个更短的兜底：**5 秒还没结论就当未登录**。
 * 两个时限的顺序是反的 ⇒ 网络一慢，一个**已经登录**的用户会在 5 秒时被扔进登录页，
 * 等真答案回来（≤8 秒）又从登录页**弹**进工作区。
 *
 * ## 加的是什么
 *
 * 一个**不发网络**的本地快速态（"本地存着一个会话吗"），只用来决定**兜底该怎么判**：
 *
 * | 快速态 | 后台还没结论时 | 为什么 |
 * | --- | --- | --- |
 * | **命中** | 保持 `'checking'`（不改判） | 有会话可等，凭"网络慢"断言未登录就是误判 |
 * | **缺席** | `'required'`（照旧） | 没有会话可等，回登录页是对的 |
 *
 * ## 三条不许（用户拍板的口径）
 *
 * 1. **快速态绝不能把 authState 推成 `'ok'`** —— 那是"本地有 token 即已登录"。
 *    **唯一**能得出"已登录"的是后台的真答案（`isSignedIn`）。
 * 2. **快速态只影响兜底**，不影响后台结论：迟到的那句"未登录"照样说了算
 *    （兜底 = 不改判，**不等于**认定）。
 * 3. **不改** 401/402/超时那些分支的行为：后台抛错依然 fail closed 回未登录。
 *
 * ⚠️ 这个设计依赖一个不变式：**`checkBackend()` 一定会收场**（不会永远挂着）——
 *    否则"保持校验中"就变成永远停在加载页。主进程那侧由 `readSessionState`
 *    的两处超时保证，见 `auth.ts`。
 */
export interface AuthBootstrapDeps<S> {
  /** 本地快速态：本地存着一个会话吗。**不发网络**（发了就失去意义）。 */
  readLocalSession: () => Promise<boolean>;
  /** 后台的真实校验。它的结论是"是否已登录"的**唯一**来源。 */
  checkBackend: () => Promise<S>;
  /** 后台返回的这个东西算不算"已登录"。 */
  isSignedIn: (session: S) => boolean;
  /** 等不到后台结论时的兜底时限（毫秒）。 */
  timeoutMs: number;
  /** 后台给出结论时回调（失败是 `null`）。 */
  onSettled: (session: S | null, authState: 'ok' | 'required') => void;
  /** 兜底时限到了、后台还没结论时回调。 */
  onTimeout: (authState: 'checking' | 'required') => void;
}

/**
 * 会话检查的**兜底时限**（毫秒）。
 *
 * ⚠️ 它必须**短于**主进程那次网络请求的上限（`auth.ts` 的 `NETWORK_TIMEOUT_MS` = 8 秒）——
 *    两个时限在赛跑，谁先到谁说了算。短的那个只该用来"防止无限转圈"，
 *    **不该用来下结论**：5 秒到了而网络还在路上，并不说明"没登录"。
 *    B7 让本地快速态在场时把结论权让给后台，正是因为这一点。
 */
export const AUTH_CHECK_FALLBACK_MS = 5000;

/**
 * 跑一次会话检查。返回**取消函数**（卸载时必须调，否则会往已卸载的组件里写状态）。
 */
export function runAuthBootstrap<S>(deps: AuthBootstrapDeps<S>): () => void {
  let done = false;
  /**
   * 快速态**只在这里用**：决定兜底是"改判未登录"还是"继续等"。
   * ⚠️ 刻意做成 `let` 而不是回调参数 —— 兜底是同步定时器，读不到 Promise 的返回值。
   */
  let localSessionPresent = false;

  deps
    .readLocalSession()
    .then((present) => {
      localSessionPresent = present;
    })
    // 读不出来（IPC 挂了 / 解不开密文）⇒ 当**缺席**处理：宁可回到今天的行为，
    // 也不要凭一个"读不到"去拖延登录页。
    .catch(() => {});

  const timer = setTimeout(() => {
    if (done) return;
    // ⭐ 有会话可等 ⇒ 不改判。剩下的结论权交给后台（它一定会收场）。
    deps.onTimeout(localSessionPresent ? 'checking' : 'required');
  }, deps.timeoutMs);

  const settle = (session: S | null, authState: 'ok' | 'required') => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    deps.onSettled(session, authState);
  };

  deps.checkBackend().then(
    (session) => settle(session, deps.isSignedIn(session) ? 'ok' : 'required'),
    // fail closed：抛错不得放过登录闸门（与今天同一条纪律）
    () => settle(null, 'required'),
  );

  return () => {
    done = true;
    clearTimeout(timer);
  };
}
