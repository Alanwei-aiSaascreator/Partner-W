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
export const fetchRelayMediaCapabilities = async () => null;
export const getActiveLocalGatewayDeploymentRoot = () => null;
export const hasBundledSearchProvider = () => false;
export const LOCAL_GATEWAY_ID = 'local-runtime';
