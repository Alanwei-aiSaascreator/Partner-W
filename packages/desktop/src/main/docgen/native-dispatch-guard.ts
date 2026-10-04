import path from 'node:path';
import { createHash } from 'node:crypto';
import { readWorkspaceBytes } from '../slidegen/source-file.js';
import { readLicenseStatus } from '../commercial/license.js';
import { isControlledRelayBaseUrl } from '../commercial/relay-endpoint.js';
export async function requireNativeTestBudget() {
  const file = process.env.ROYIN_NATIVE_TEST_CONFIG;
  if (!file || !path.isAbsolute(file)) throw Error('native-test-account-unverified');
  const cfg = JSON.parse(readWorkspaceBytes(path.dirname(file), path.basename(file), 64 * 1024).toString('utf8'));
  if (cfg.authorizedTest !== true || typeof cfg.licenseId !== 'string' || typeof cfg.gatewayConfig !== 'string')
    throw Error('native-test-account-unverified');
  const license = await readLicenseStatus();
  if (!license.ok || license.result?.licenseId !== cfg.licenseId) throw Error('native-test-account-mismatch');
  const modelCfg = JSON.parse(
    readWorkspaceBytes(path.dirname(cfg.gatewayConfig), path.basename(cfg.gatewayConfig), 1024 * 1024).toString('utf8'),
  );
  const provider = modelCfg.models?.providers?.clawrouter;
  if (!provider?.apiKey || typeof provider.baseUrl !== 'string') throw Error('native-test-provider-unavailable');
  // ⚠️ 白名单与受控配置出口（`relay-endpoint.ts`）**共用同一个函数** ——
  //    两处各写一份，早晚漂出一条"把测试配置指去任意主机"的缝。
  if (!isControlledRelayBaseUrl(provider.baseUrl)) throw Error('native-test-provider-unavailable');
  const res = await fetch(`${provider.baseUrl.replace(/\/+$/, '')}/v1/ppt-test/capabilities`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    signal: AbortSignal.timeout(10000),
  });
  const guard = await res.json();
  if (
    !res.ok ||
    guard.guardVersion !== 'ppt-budget-v1' ||
    guard.batchId !== cfg.batchId ||
    guard.batchCapMicros !== '500000000' ||
    guard.currency !== 'CNY' ||
    guard.unit !== 'micros-cent' ||
    guard.licenseHash !== createHash('sha256').update(cfg.licenseId).digest('hex')
  )
    throw Error('native-test-budget-guard-unavailable');
  return guard;
}
