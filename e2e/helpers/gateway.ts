import { GATEWAY_HTTP_URL, HEALTH_TIMEOUT_MS, POLL_INTERVAL_MS } from './constants';

export async function waitForGateway(): Promise<void> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${GATEWAY_HTTP_URL}/healthz`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Gateway not ready after ${HEALTH_TIMEOUT_MS}ms`);
}
