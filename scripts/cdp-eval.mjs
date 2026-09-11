#!/usr/bin/env node
/**
 * 调试工具：把一段表达式丢进正在运行的渲染进程里求值。
 *
 *   node scripts/cdp-eval.mjs "document.title"
 *
 * 前提：客户端用 CLAUDEW_DEBUG_PORT=9222 起（见记忆 mofang-dev-stack-startup）。
 * 为什么要它：界面"空的"有太多可能（没数据 / 没连上 / 渲染坏了），
 * 读 DOM 比截图和猜都快。
 */
import http from 'node:http';

// 用 Node 内置的 WebSocket（Node 22+ 全局可用），不依赖仓库里的 `ws` ——
// scripts/ 不在 packages/desktop 的 node_modules 解析路径上。
const PORT = process.env.CLAUDEW_DEBUG_PORT || '9222';
const expr = process.argv[2] || 'document.title';

function targets() {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            const pages = JSON.parse(body).filter((p) => p.type === 'page');
            if (!pages.length) return reject(new Error('没有页面目标'));
            resolve(pages[0].webSocketDebuggerUrl);
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

const url = await targets();
const ws = new WebSocket(url);

ws.addEventListener('open', () => {
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression: expr, returnByValue: true, awaitPromise: true },
    }),
  );
});

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id !== 1) return;
  if (msg.result?.exceptionDetails) {
    console.error('求值异常:', JSON.stringify(msg.result.exceptionDetails).slice(0, 500));
    process.exit(1);
  }
  const v = msg.result?.result?.value;
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
  ws.close();
  process.exit(0);
});

ws.addEventListener('error', () => {
  console.error(`连不上 CDP（${PORT}）。客户端是不是没用 CLAUDEW_DEBUG_PORT 起？`);
  process.exit(1);
});

setTimeout(() => {
  console.error('超时');
  process.exit(1);
}, 20000);
