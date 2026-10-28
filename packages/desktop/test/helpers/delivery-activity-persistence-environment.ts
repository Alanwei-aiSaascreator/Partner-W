export const handlers = new Map<string, () => unknown>();
export const events: Array<{ channel: string; payload: unknown }> = [];
export const ipcMain = { handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler) };
export const BrowserWindow = {
  getAllWindows: () => [
    {
      webContents: {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) => events.push({ channel, payload }),
      },
    },
  ],
};
export const app = { isPackaged: false, getAppPath: () => process.cwd() };
let config: {
  workspacePath: string;
  commercial?: {
    supabaseUrl: string;
    supabaseAnonKey: string;
    licenseKey?: string;
    licenseBinding?: { userId: string; orgId: string; licenseId: string };
  };
};
export function setAccount(workspacePath: string, account?: string): void {
  config = {
    workspacePath,
    commercial: {
      supabaseUrl: '',
      supabaseAnonKey: '',
      ...(account
        ? {
            licenseKey: 'fixture',
            licenseBinding: { userId: account, orgId: 'fixture-org', licenseId: 'fixture-license' },
          }
        : {}),
    },
  };
}
export const readConfig = () => config;
export const updateConfig = (input: Partial<typeof config>) => {
  config = { ...config, ...input };
};
export const ensureDeviceId = () => 'fixture-device';
export const getCommercialClient = () => null;
export const getAllGatewayClients = () => [];
export const getDebugLogger = () => undefined;
export const applyRelayConfig = async () => ({ configured: false });
export const fetchFirstRelayModel = async () => null;
// 2026-10-12：`license.ts` 自 Task 3 批次起还导入这个导出；夹具缺它 ⇒ 整档在**收集期**
// 就 RollupError（11 条用例从来没跑过），表现为"文件级失败、0 条用例失败"。补上让它真跑。
export const fetchRelayCatalogModelEntries = async () => null;
export const fetchRelayMediaCapabilities = async () => null;
// 2026-10-16 BUG-082：`license.ts` 的 held 读取要规范化 relay 基址，于是新增了
// `normalizeBaseUrl` 导入；夹具缺它 ⇒ 与上面同形的**收集期** RollupError（整档失败、
// 0 条用例失败），11 条用例一条都跑不到。判据与真源 `relay-config.ts` 逐字一致
// （只去尾部斜杠）—— 这里是替身模块，不是真实现在跑。
export const normalizeBaseUrl = (value: string): string => value.replace(/\/+$/, '');
// 同批：`license.ts` 还导入了当前中转基址出口。替身给一个**不可达**的稳定基址即可 ——
// 这份夹具里没有活体 relay key（`getActiveRelayKey` 读的是被替身掉的 config），
// 所以 held 读取会在"没有 key"处早退，不会真的发请求。
export const activeRelayBaseUrl = (): string => 'https://relay.invalid';
// 2026-10-17 BUG-133：`license.ts` 新增静态 import `../memory/account-switch.js`
// （清绑定时 fire-and-forget 重投影 `MEMORY.md`）。该档已在 `delivery-activity-persistence.test.ts`
// 的替身插件里把这条边替换成本模块，这里必须补上它唯一用到的导出 —— 否则又是同形的
// **收集期** RollupError（缺导出 ⇒ 整档失败、11 条用例全跳过）。
// 语义：no-op 即可。本档不测记忆投影（它只测交付活动持久化），真源 `account-switch` 的
// 唯一副作用是"网关在就连时重投影文件"，这份替身没有真网关，投与不投都不影响本档断言。
export const resyncMemoryOnAccountBoundary = async (): Promise<void> => undefined;
export const getActiveLocalGatewayDeploymentRoot = () => null;
// 2026-10-12 联网搜索接入：license/relay-startup 的搜索可用性探针改为
// stateDir + hasInstalledSearchProvider（旧名保留：别的被替身模块还可能导入它）。
export const getActiveLocalGatewayStateDir = () => null;
export const hasInstalledSearchProvider = () => false;
export const hasBundledSearchProvider = () => false;
export const LOCAL_GATEWAY_ID = 'local-runtime';
