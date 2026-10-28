import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

test('built-in Node CDP reads a real owned inspector without npm, jq or tsx', async (t) => {
  const { listInspectorTargets, evaluateInspector } = await import('./node-inspector-cli.mjs');
  const child = spawn(process.execPath, ['--inspect=0', '-e', 'setInterval(()=>{},1000)'], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(() => child.kill());
  const socket = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('owned inspector startup timeout')), 10000);
    let stderr = '';
    child.stderr.on('data', (bytes) => {
      stderr += bytes;
      const url = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[a-z0-9-]+/)?.[0];
      if (url) {
        clearTimeout(timeout);
        resolve(url);
      }
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  const endpoint = `http://127.0.0.1:${new URL(socket).port}`;
  assert.equal((await listInspectorTargets(endpoint)).length, 1);
  const result = await evaluateInspector(endpoint, 'process.pid');
  assert.equal(result.result.value, child.pid);
  await assert.rejects(evaluateInspector(endpoint, '(()=>{throw new Error("owned fixture failure")})()'), /exception/);
});
test('rejects remote inspector routes before any network request', async () => {
  const { listInspectorTargets } = await import('./node-inspector-cli.mjs');
  await assert.rejects(listInspectorTargets('http://example.com:9229'), /loopback/);
});

test('rejects a matching CDP response without a result or error and closes the socket', async (t) => {
  const { evaluateInspector } = await import('./node-inspector-cli.mjs');
  let closed = false;
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => [{ id: 'owned', webSocketDebuggerUrl: 'ws://127.0.0.1:9229/owned' }],
  }));
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = class extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }
    send() {
      this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ id: 1 }) }));
    }
    close() {
      closed = true;
    }
  };
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });
  await assert.rejects(evaluateInspector('http://127.0.0.1:9229', 'process.pid'), /invalid.*response/i);
  assert.equal(closed, true);
});
