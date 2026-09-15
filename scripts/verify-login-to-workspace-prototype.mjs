import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prototypePath = path.join(repoRoot, 'docs', 'prototypes', 'rongying-cube-login-to-workspace-v2.html');

assert.ok(existsSync(prototypePath), `prototype file does not exist: ${prototypePath}`);

const html = readFileSync(prototypePath, 'utf8');
const requiredScreens = ['login', 'purpose', 'activation', 'workspace', 'assistant', 'usage'];

for (const screen of requiredScreens) {
  assert.match(html, new RegExp(`id=["']screen-${screen}["']`), `missing ${screen} screen`);
}

for (const phrase of [
  '登录荣盈魔方',
  '你主要想用它做什么',
  '激活并进入工作台',
  '正在准备你的 AI 工作台',
  'deepseek-v4-flash',
  '剩余点数',
  '本次消耗',
  '重新尝试',
]) {
  assert.ok(html.includes(phrase), `missing required copy: ${phrase}`);
}

for (const assistant of ['罗盘助手', '内容创作', '电商运营', '生活家庭', '高效办公', '学习研究', '拍摄剪辑']) {
  assert.ok(html.includes(assistant), `missing assistant: ${assistant}`);
}

assert.match(html, /window\.addEventListener\(['"]pointermove['"]/, 'mascot pointer tracking missing');
assert.match(html, /mode-code/, 'verification-code eye-cover state missing');
assert.match(html, /prefers-reduced-motion:\s*reduce/, 'reduced-motion fallback missing');
assert.match(html, /data-model-label/, 'shared model label binding missing');
assert.match(html, /data-remaining-value/, 'shared remaining balance binding missing');
assert.match(html, /function syncRemaining\(\)/, 'shared remaining balance updater missing');
assert.match(
  html,
  /state\.remaining\s*=\s*5002;\s*syncRemaining\(\);/,
  'task completion does not refresh visible remaining balances',
);
assert.doesNotMatch(html, />[^<]*(gateway|端口|容器)[^<]*</i, 'technical copy leaked into visible UI');

console.log('Login-to-workspace prototype contract passed.');
