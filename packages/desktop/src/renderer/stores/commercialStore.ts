import { create } from 'zustand';
import type { CommercialAccountOverview } from '@clawwork/shared';

export type PanelStatus = 'idle' | 'loading' | 'ready' | 'offline';

interface CommercialState {
  status: PanelStatus;
  overview: CommercialAccountOverview | null;
  errorMessage: string;
  /**
   * 拉取账号概览。
   *
   * ⚠️ U2/R2（2026-10-10 集中终审 §4）：可选 `isCurrent` 是**调用方的组件级取消判据**
   * （存活/账号 scope/attempt）。它会在**写回前**与 store 代次合取 —— 只在 load 返回后
   * 检查拦不住已经发生的缓存写入（那正是"A 的迟到回包把缓存变回 A"的路径）。
   */
  load: (isCurrent?: () => boolean) => Promise<void>;
  /**
   * 静默重拉额度。与 `load()` 的区别有三条：
   *
   *   ① **不把 status 翻成 loading** —— `load()` 会打 loading，调用方据此渲染
   *      骨架屏；每轮对话结束都这么闪一下，顶栏钱包会一直眨；
   *   ② 走**轻量只读额度通道**（`commercialQuotaSnapshot`）—— 只读、无写副作用，
   *      所以它可以被每几秒调一次（BUG-082）；
   *   ③ **单飞**：正在飞的时候再触发只**合并**成一次补跑，绝不并发第二条请求。
   *
   * 失败时保留旧值供界面展示（含 `fetchedAt`，界面据此显示"更新于 …"），
   * 只把状态翻为 offline。
   *
   * ⚠️ 2026-09-17 起，offline 时闸门**仍会用这份旧快照放行**（见 lib/quota.ts）：
   *    把"读不到"当成"用尽"被证明代价更大。相应地，**登出必须清缓存**
   *    （clearCache），否则会误用上一张许可证。
   */
  refresh: () => Promise<void>;
  /**
   * 清掉缓存快照与状态。**登出时必须调**。
   *
   * 闸门现在允许"读失败时用最近一次成功的快照放行"，所以留在磁盘上的
   * 旧快照就是一份**能授权发送**的凭据 —— 不清的话，A 登出、B 登录、
   * B 的额度又恰好读失败，B 就会拿着 A 的许可证被放行。
   */
  clearCache: () => void;
}

const CACHE_KEY = 'cw:commercial-overview';

/**
 * U2/R2（2026-10-10 集中终审 §4）：**账号代次 + 读序号**。
 *
 * `clearCache`（登出/切号）递增两者；每次 `load`/`refresh` 在开始处捕获快照，
 * 写内存 / 写磁盘 / 写错误状态**之前**核验 —— 迟到的旧账号回包不许再落到
 * 新代次的缓存上。只挡 onActivated 拦不住这类写入，守卫必须在 store 这一层。
 */
let accountEpoch = 0;
let readSequence = 0;

/**
 * 单飞槽（BUG-082 / C-B §2）：同一时刻**只允许一条**额度刷新在飞。
 *
 * 为什么必须在 store 这一层，而不是各调用点自律：余额刷新现在有三类触发
 * （回合结束 / 消费中节奏 / 回前台），它们天然会互相重叠。各自"小心一点"
 * 挡不住重叠；把单飞放在唯一的写入口（这份 store）才挡得住。
 *
 * `refreshMerged` 的语义是"飞着的时候又被触发过" ⇒ 落一次**补跑**：那次触发
 * 可能正好对应"响应结束、账本还没提交"的窗口，跳过它就会一直显示旧值。
 */
let refreshInFlight: Promise<void> | null = null;
let refreshMerged = false;

function readCache(): CommercialAccountOverview | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? (JSON.parse(raw) as CommercialAccountOverview) : null;
  } catch {
    return null;
  }
}

function writeCache(overview: CommercialAccountOverview): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(overview));
  } catch {}
}

export const useCommercialStore = create<CommercialState>((set, get) => ({
  status: 'idle',
  overview: readCache(),
  errorMessage: '',

  load: async (isCurrent?: () => boolean) => {
    const epoch = accountEpoch;
    const sequence = ++readSequence;
    /** 写回前合取：store 代次/序号 + 调用方组件级判据（R2 §4.7）。 */
    const current = (): boolean =>
      epoch === accountEpoch && sequence === readSequence && (isCurrent ? isCurrent() : true);
    set({ status: 'loading', errorMessage: '' });
    try {
      const res = await window.clawwork.commercialAccountOverview();
      if (!current()) return;
      if (!res.ok || !res.result) {
        set({ status: 'offline', errorMessage: res.error ?? '' });
        return;
      }
      writeCache(res.result);
      set({ status: 'ready', overview: res.result, errorMessage: '' });
    } catch (error) {
      if (!current()) return;
      if (!get().overview) set({ overview: readCache() });
      set({ status: 'offline', errorMessage: error instanceof Error ? error.message : String(error) });
    }
  },

  clearCache: () => {
    // 先递增代次再清：在途的 load/refresh 从此一律作废（R2 §4.7）。
    accountEpoch += 1;
    readSequence += 1;
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // localStorage 不可用也要继续清内存里的那份
    }
    set({ overview: null, status: 'idle', errorMessage: '' });
  },

  refresh: () => {
    // 没有已登录的账号就不空跑 —— 未登录时这个面板本来就不显示。
    // ⚠️ 守卫检查在捕获快照**之前**：一次不空跑的 refresh 不该作废在途的 load。
    if (!get().overview?.account) return Promise.resolve();

    // ⭐ 单飞：已经在飞就只记一次"要补跑"，不并发第二条请求。
    if (refreshInFlight) {
      refreshMerged = true;
      return refreshInFlight;
    }

    const work = (async () => {
      const epoch = accountEpoch;
      const sequence = ++readSequence;
      const current = (): boolean => epoch === accountEpoch && sequence === readSequence;
      try {
        const res = await window.clawwork.commercialQuotaSnapshot();
        if (!current()) return;
        if (!res.ok || !res.result) {
          // 读不到：保留最近一次成功的值（含 fetchedAt），只把状态标成 offline。
          set({ status: 'offline' });
          return;
        }
        const previous = get().overview;
        // 读取期间账号消失（登出/切号竞态）⇒ 什么都不写。
        if (!previous?.account) return;
        const next: CommercialAccountOverview = {
          ...previous,
          org: res.result.org ?? previous.org,
          license: res.result.license,
          fetchedAt: res.result.fetchedAt,
        };
        writeCache(next);
        set({ status: 'ready', overview: next, errorMessage: '' });
      } catch {
        if (!current()) return;
        set({ status: 'offline' });
      } finally {
        refreshInFlight = null;
        if (refreshMerged) {
          refreshMerged = false;
          // 合并成恰好一次补跑。⚠️ 不能无限链式：补跑自身再被触发时又会走这条
          // 分支 —— 但触发源全部是有界节奏（回合结束 / 有界追读 / 5 秒节奏 / 回前台），
          // 所以链长受触发频率约束，不会自激。
          void get().refresh();
        }
      }
    })();
    refreshInFlight = work;
    return work;
  },
}));
