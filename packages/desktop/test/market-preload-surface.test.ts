import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * preload 是 renderer 唯一能碰到的东西：少一个方法界面上就是
 * "undefined is not a function"；多暴露一个能力则是安全问题。
 *
 * ⚠️ 这里**故意没有**"安装"方法 —— 真安装要在本地网关建 agent，走的是
 *    `window.clawwork` 已有的 agent API（`useTemplateInstall`），
 *    市场只负责记账（`marketTemplateInstalled`）。这条约束写进断言里，
 *    免得以后有人图省事加一个 `marketInstall` 却绕过了真安装那条链。
 */
describe('market preload surface', () => {
  const preload = readFileSync(new URL('../src/preload/index.ts', import.meta.url), 'utf8');
  const declarations = readFileSync(new URL('../src/preload/clawwork.d.ts', import.meta.url), 'utf8');

  const expected = [
    'marketTemplates',
    'marketTemplateDetail',
    'marketTemplateInstalled',
    'marketMyTemplates',
    'marketCreateTemplate',
    'marketUpdateTemplate',
    'marketSetTemplateStatus',
    'marketDeleteTemplate',
  ];

  it('每个方法都在 preload 与类型声明里', () => {
    for (const name of expected) {
      expect(preload).toContain(`${name}:`);
      expect(declarations).toContain(`${name}:`);
    }
  });

  it('不额外暴露任何 market 前缀的方法', () => {
    const found = [...preload.matchAll(/\bmarket[A-Z]\w*/g)].map((m) => m[0]);
    expect([...new Set(found)].sort()).toEqual([...expected].sort());
  });

  it('没有 marketInstall 之类的"假安装"入口', () => {
    expect(preload).not.toContain('marketInstall:');
    expect(declarations).not.toContain('marketInstall:');
  });
});
