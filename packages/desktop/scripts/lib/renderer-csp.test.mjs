// renderer-csp.test.mjs —— **按 directive** 断言（S-R3 复审修正）。
//
// 旧版在"整条策略字符串里找 token"：`data:` 出现在 img-src 里就把 media-src 也测绿了，
// 3/3 通过是**假保护** —— 视频预览（`data:video/mp4;base64,...`，FilePreview.tsx）实际
// 会被 media-src 拦掉都不知道。这里改成：
//   1. 每条 directive 的源列表**逐条列全**（加宽白名单必须先改测试，等于强制复核）；
//   2. 按**实际请求种类**（组件的真实 src：data: 视频 / 远程 https 图 / file: 图 / 头像协议 …）
//      用协议 token 走 CSP 的匹配语义验证"这个 directive 真的允许它"。
//
// 关于 `frame-ancestors`：meta 承载的 CSP **不支持** frame-ancestors（W3C CSP3，
// "The meta element" 一节明确列出该指令在 meta 中无效）——策略里已不含该声明，
// 这里断言它**不存在**。不要拿"字符串在策略里"当抗嵌入证据；真实的抗嵌入承载层是
// 窗口加载面（本应用不把自身文档经 HTTP 暴露给外部页面），与 meta 无关。

import test from 'node:test';
import assert from 'node:assert/strict';
import { PROD_CSP, rendererDevCsp } from './renderer-csp.mjs';

/** 把策略拆成 directive → 源列表；重复 directive 直接失败。 */
function parse(policy) {
  const map = new Map();
  for (const part of policy.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const [name, ...sources] = trimmed.split(/\s+/);
    assert.ok(!map.has(name), `directive ${name} 重复出现`);
    map.set(name, sources);
  }
  return map;
}

function sourcesOf(map, name) {
  assert.ok(map.has(name), `策略缺少 directive：${name}`);
  return map.get(name);
}

/** 按 CSP 的资源类别语义：URL 的协议 token 必须在对应 directive 的源列表里。 */
function allows(map, directive, url) {
  const protocol = new URL(url).protocol; // 'data:' / 'file:' / 'https:' / 'blob:' / 'clawwork-asset:' …
  return sourcesOf(map, directive).includes(protocol);
}

/** 组件里真实出现的"请求种类"（url 对应消费点见注释）。 */
const MEDIA_REQUESTS = [
  ['FilePreview 视频预览：data:video/mp4;base64,...', 'data:video/mp4;base64,AAAAIGZ0eXBpc29t'],
  ['FilePreview 视频预览（webm）', 'data:video/webm;base64,AAAA'],
  ['开场片：clawwork-asset://media/opening.mp4', 'clawwork-asset://media/opening.mp4'],
];

const IMG_REQUESTS = [
  ['Markdown 正文远程图片（https）', 'https://example.com/illustration.png'],
  ['聊天里的本地图片（clawwork-media→file:）', 'file:///C:/workspace/photo.png'],
  ['内联/附件图片（data:）', 'data:image/png;base64,iVBORw0KGgo='],
  ['附件与 PDF 预览缩略（blob:）', 'blob:file:///0f9a-uuid'],
  ['头像协议（clawwork-avatar:）', 'clawwork-avatar://gateway-1/agent-7'],
];

test('prod：每条 directive 逐条钉死（加宽必须先改测试）', () => {
  const map = parse(PROD_CSP);

  assert.deepEqual(
    [...map.keys()],
    [
      'default-src',
      'script-src',
      'style-src',
      'img-src',
      'media-src',
      'font-src',
      'frame-src',
      'connect-src',
      'object-src',
      'base-uri',
      'form-action',
    ],
  );

  assert.deepEqual(sourcesOf(map, 'default-src'), ["'self'"]);
  assert.deepEqual(sourcesOf(map, 'script-src'), ["'self'"], 'script 不许 unsafe-inline/unsafe-eval/远程源');
  assert.deepEqual(sourcesOf(map, 'style-src'), ["'self'", "'unsafe-inline'"]);
  assert.deepEqual(sourcesOf(map, 'font-src'), ["'self'", 'data:']);
  assert.deepEqual(sourcesOf(map, 'frame-src'), ["'self'", 'blob:']);
  assert.deepEqual(sourcesOf(map, 'connect-src'), ["'self'"], 'connect 只许自身（渲染层不经它访问外网）');
  assert.deepEqual(sourcesOf(map, 'object-src'), ["'none'"], "object-src 'none' 必须保持");
  assert.deepEqual(sourcesOf(map, 'base-uri'), ["'none'"]);
  assert.deepEqual(sourcesOf(map, 'form-action'), ["'none'"]);

  // 不是 default-src * 式的偷懒放宽：任何 directive 都不许出现裸通配
  for (const [name, sources] of map) {
    assert.ok(!sources.includes('*'), `${name} 出现通配 *`);
  }
  assert.ok(!PROD_CSP.includes('http://') && !PROD_CSP.includes('ws://'), 'prod 不许出现明文 http/ws');
});

test('prod：图片消费面 —— 按实际请求种类逐条放行（本地 + 远程 https）', () => {
  const map = parse(PROD_CSP);
  for (const [what, url] of IMG_REQUESTS) {
    assert.ok(allows(map, 'img-src', url), `img-src 应允许：${what}（${url}）`);
  }
  // 反向 sanity：图片指令不因为"别处写了 data:" 就放行任意协议
  assert.ok(!allows(map, 'img-src', 'ftp://example.com/a.png'), '未知协议不许放行');
});

test('prod：媒体消费面 —— data: 视频预览与资产协议都放行（img 里的 data: 不算数）', () => {
  const map = parse(PROD_CSP);
  for (const [what, url] of MEDIA_REQUESTS) {
    assert.ok(allows(map, 'media-src', url), `media-src 应允许：${what}（${url}）`);
  }
  assert.deepEqual(sourcesOf(map, 'media-src'), ["'self'", 'clawwork-asset:', 'data:']);
});

test('prod：meta 承载的 CSP 不含 frame-ancestors（无效声明已删，不是抗嵌入证据）', () => {
  const map = parse(PROD_CSP);
  assert.ok(!map.has('frame-ancestors'), 'meta 里的 frame-ancestors 无效（CSP3）——策略必须不含它');
});

test('dev：相对 prod 的差异**只有** dev 源与 HMR 的 ws（逐条 diff）', () => {
  const prod = parse(PROD_CSP);
  const dev = parse(rendererDevCsp('http://localhost:5173'));
  const origin = 'http://localhost:5173';
  const ws = 'ws://localhost:5173';

  assert.deepEqual([...dev.keys()], [...prod.keys()], 'dev 与 prod 的 directive 集合必须一致');

  assert.deepEqual(sourcesOf(dev, 'default-src'), ["'self'", origin]);
  assert.deepEqual(sourcesOf(dev, 'script-src'), ["'self'", "'unsafe-inline'", origin], 'dev 引导脚本内联');
  assert.deepEqual(sourcesOf(dev, 'style-src'), ["'self'", "'unsafe-inline'", origin]);
  assert.deepEqual(sourcesOf(dev, 'img-src'), [
    "'self'",
    'file:',
    'data:',
    'blob:',
    'clawwork-avatar:',
    'https:',
    origin,
  ]);
  assert.deepEqual(sourcesOf(dev, 'connect-src'), ["'self'", origin, ws], 'HMR 走 ws');
  // 这几条必须与 prod 同文（dev 源不掺进来）
  for (const directive of ['media-src', 'font-src', 'frame-src', 'object-src', 'base-uri', 'form-action']) {
    assert.deepEqual(sourcesOf(dev, directive), sourcesOf(prod, directive), `${directive} 应与 prod 同文`);
  }
  assert.ok(!dev.has('frame-ancestors'), 'dev 的 meta 同样不含无效的 frame-ancestors');
});

test('dev：实际请求种类照常放行（与 prod 同款消费面）', () => {
  const dev = parse(rendererDevCsp('http://localhost:5173'));
  for (const [, url] of [...MEDIA_REQUESTS, ...IMG_REQUESTS]) {
    const directive = MEDIA_REQUESTS.some(([, u]) => u === url) ? 'media-src' : 'img-src';
    assert.ok(allows(dev, directive, url), `dev ${directive} 应允许：${url}`);
  }
});
