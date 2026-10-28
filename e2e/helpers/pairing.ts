import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { GATEWAY_TOKEN } from './constants';

const DEVICE_IDENTITY_FILE = 'device-identity.json';

interface StoredIdentity {
  version: 1;
  deviceId: string;
}

interface PairingListResult {
  pending?: Array<{ requestId?: string; deviceId?: string }>;
}

interface DeviceTokenStore {
  version: 1;
  tokens?: Record<string, { token?: string; role?: string; issuedAtMs?: number }>;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function runGatewayCall(method: string, params: Record<string, unknown>): unknown {
  const composeFile = path.resolve(__dirname, '../docker-compose.yml');
  const innerCommand = [
    'mkdir -p /tmp/e2e-approver',
    `OPENCLAW_STATE_DIR=/tmp/e2e-approver node dist/index.js gateway call ${method} --url ws://127.0.0.1:18789 --token ${GATEWAY_TOKEN} --params '${JSON.stringify(params)}' --json`,
  ].join(' && ');
  const stdout = execFileSync(
    'docker',
    ['compose', '-f', composeFile, 'exec', '-T', 'openclaw-gateway', 'sh', '-lc', innerCommand],
    { encoding: 'utf8' },
  );
  return JSON.parse(stdout);
}

export function getDeviceIdFromUserData(userDataDir: string): string {
  const parsed = readJsonFile<StoredIdentity>(path.join(userDataDir, DEVICE_IDENTITY_FILE));
  if (!parsed?.deviceId || typeof parsed.deviceId !== 'string') {
    throw new Error('missing deviceId in device identity file');
  }
  return parsed.deviceId;
}

export function getDeviceTokenFromUserData(userDataDir: string, gatewayId: string): string | null {
  const tokenStorePath = path.join(userDataDir, 'device-tokens.json');
  if (!fs.existsSync(tokenStorePath)) {
    return null;
  }
  const parsed = readJsonFile<DeviceTokenStore>(tokenStorePath);
  const token = parsed?.tokens?.[gatewayId]?.token;
  return typeof token === 'string' && token ? token : null;
}

export function approvePendingPairing(deviceId: string): void {
  const list = runGatewayCall('device.pair.list', {}) as PairingListResult;
  const pending = Array.isArray(list.pending) ? list.pending : [];
  const match = pending.find((item) => item?.deviceId === deviceId);
  if (!match?.requestId) {
    throw new Error(`pending pairing request not found for device ${deviceId}`);
  }
  runGatewayCall('device.pair.approve', { requestId: match.requestId });
}
