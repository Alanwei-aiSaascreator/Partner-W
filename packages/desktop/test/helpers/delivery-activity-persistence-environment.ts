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
export const getActiveLocalGatewayDeploymentRoot = () => null;
// 2026-10-12 联网搜索接入：license/relay-startup 的搜索可用性探针改为
// stateDir + hasInstalledSearchProvider（旧名保留：别的被替身模块还可能导入它）。
export const getActiveLocalGatewayStateDir = () => null;
export const hasInstalledSearchProvider = () => false;
export const hasBundledSearchProvider = () => false;
export const LOCAL_GATEWAY_ID = 'local-runtime';
