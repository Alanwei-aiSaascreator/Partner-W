import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loopback(value, protocols) {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  )
    throw new Error('Inspector endpoint must be loopback without credentials');
  return url;
}
export async function listInspectorTargets(endpoint = 'http://127.0.0.1:9229') {
  const base = loopback(endpoint, ['http:']);
  const response = await fetch(new URL('/json/list', base), { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Inspector target discovery failed (${response.status})`);
  const targets = await response.json();
  if (!Array.isArray(targets)) throw new Error('Inspector target list is invalid');
  return targets;
}
export async function evaluateInspector(endpoint, expression, targetId) {
  const targets = await listInspectorTargets(endpoint);
  const matches = targetId ? targets.filter((target) => target.id === targetId) : targets;
  if (matches.length !== 1 || !matches[0].webSocketDebuggerUrl) throw new Error('Select one exact inspector target');
  const websocket = loopback(matches[0].webSocketDebuggerUrl, ['ws:']);
  const base = loopback(endpoint, ['http:']);
  if (websocket.hostname !== base.hostname || websocket.port !== base.port)
    throw new Error('Inspector target does not belong to this endpoint');
  const socket = new WebSocket(websocket);
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Inspector evaluation timed out')), 5000);
      const fail = (message) => {
        clearTimeout(timeout);
        reject(new Error(message));
      };
      socket.addEventListener('error', () => fail('Inspector socket failed'), { once: true });
      socket.addEventListener('close', () => fail('Inspector socket closed before completion'), { once: true });
      socket.addEventListener(
        'open',
        () =>
          socket.send(
            JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }),
          ),
        { once: true },
      );
      socket.addEventListener('message', (event) => {
        try {
          const response = JSON.parse(String(event.data));
          if (response.id !== 1) return;
          clearTimeout(timeout);
          if (response.error) reject(new Error(response.error.message));
          else if (response.result?.exceptionDetails) reject(new Error('Inspector expression threw an exception'));
          else if (!response.result || typeof response.result !== 'object' || !response.result.result)
            reject(new Error('Inspector returned an invalid evaluation response'));
          else resolve(response.result);
        } catch {
          fail('Inspector returned invalid JSON');
        }
      });
    });
  } finally {
    socket.close();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, endpoint = 'http://127.0.0.1:9229', expression, targetId] = process.argv.slice(2);
  try {
    const result =
      command === 'list'
        ? await listInspectorTargets(endpoint)
        : command === 'evaluate' && expression
          ? await evaluateInspector(endpoint, expression, targetId)
          : (() => {
              throw new Error(
                'Usage: node-inspector-cli.mjs list [endpoint] | evaluate endpoint expression [target-id]',
              );
            })();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
