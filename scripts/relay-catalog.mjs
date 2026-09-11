#!/usr/bin/env node
/**
 * 打印中转服务返回的 catalog 里的模型 id / capability。
 *
 *   node scripts/relay-catalog.mjs
 *
 * 为什么要它：网关上 `models list` 列出的名字 与 实际能调用的 ref
 * 不是一回事（ref 是 `clawrouter/<catalog 里的 id>`）。排查
 * "The selected model was not found by the provider" 时，
 * 必须以 relay 真实返回的 id 为准，而不是任何一方的显示名。
 *
 * 密钥从网关状态目录读，**不打印**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE = path.resolve(HERE, '../../../claude 分析/_run/openclaw-latest/.state-app/openclaw.json');
const BASE = 'https://api.rongyinghudong.com/relay';

const cfg = JSON.parse(fs.readFileSync(STATE, 'utf8'));
const key = cfg?.models?.providers?.clawrouter?.apiKey;
if (!key) {
  console.error('网关配置里没有 clawrouter.apiKey');
  process.exit(1);
}

const res = await fetch(`${BASE}/v1/catalog`, { headers: { Authorization: `Bearer ${key}` } });
console.log('HTTP', res.status);
if (!res.ok) {
  console.log((await res.text()).slice(0, 400));
  process.exit(1);
}

const body = await res.json();
for (const p of body.providers ?? []) {
  console.log(`\nprovider: ${p.id ?? '(无 id)'}`);
  for (const m of p.models ?? []) {
    const caps = (m.capabilities ?? m.capability ?? []).toString?.() ?? JSON.stringify(m.capabilities ?? '');
    console.log(`  id=${JSON.stringify(m.id)}  caps=${caps}`);
  }
}

// 顺带把"能被网关当成 ref 用"的形式打出来 —— 就是这两段
const first = body.providers?.[0]?.models?.[0]?.id;
if (first) console.log(`\n⇒ 对应的模型 ref（两段）: clawrouter/${first}`);
