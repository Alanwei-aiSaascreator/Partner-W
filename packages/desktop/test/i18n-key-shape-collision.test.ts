import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * i18n 键**形状**冲突守卫（2026-10-16，T32/T33）。
 *
 * ## 它挡的是什么
 *
 * i18next 的资源是一棵**嵌套对象**。同一个路径不可能**既是字符串叶、又是分支**：
 *
 *   t('a.b')              ← 要求 a.b 是字符串
 *   t(`a.b.${x}.leaf`)    ← 要求 a.b 是对象
 *
 * 两者同时存在时，写进 locale 的 JSON 只能满足一个，另一个**必然**上屏成
 * 一句机器话。实测（i18next 23，本仓配置 `keySeparator: '.'`）：
 *
 *   · 资源写成 `{a:{b:{x:{leaf:'…'}}}}` ⇒ `t('a.b')` 返回
 *     `"key 'a.b' returned an object instead of string."`（**用户直接看到这句**）；
 *   · 资源写成 `{a:{b:'…'}}`           ⇒ `t('a.b.x.leaf')` 返回**原始键名**。
 *
 * 也就是说这不是"少了一个键"，是**这一族键怎么排版都会有一半是坏的**。
 * 本仓真出过这个形状：`identity.industryMethod`（个性化中心当**字符串标签**渲染）
 * 与 `identity.industryMethod.<行业码>.<focus|method|template>`（行业方法三行）
 * 同路径 —— 定稿 9 语言时无论怎么写都有一边是坏的。
 *
 * ## 为什么扫源码而不是扫 locale
 *
 * 键还没定稿时 locale 里根本没有它们（`check:i18n` 此刻正是红的，见 DELIVERY_STATE）。
 * 形状冲突是**代码侧的声明**问题，与键值是否已写入无关 —— 所以这里扫的是
 * **谁在要这些键**：`t('字面量')` 与 `` t(`前缀.${变量}`) ``。
 *
 * ⚠️ 范围刻意圈死在 T32/T33 这几份文件上：先保证本层不再出这个形状。
 *    全仓扫会把别的 owner 的文件一起判红，那不是这份守卫该管的事。
 */

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SCANNED_FILES = [
  'src/renderer/lib/industry-method.ts',
  'src/renderer/lib/expert-catalog.ts',
  'src/renderer/layouts/ExpertsPanel/index.tsx',
  'src/renderer/layouts/IdentityCenter/index.tsx',
] as const;

/** `t('a.b.c')` —— 要求 `a.b.c` 是**字符串叶**。 */
const EXACT_KEY = /\bt\(\s*'([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)'/g;
/** ``t(`a.b.${x}`)`` —— 要求 `a.b` 是**分支**（它下面还有键）。 */
const TEMPLATE_ROOT = /\bt\(\s*`([A-Za-z0-9_.]+?)\$\{/g;

interface Usage {
  file: string;
  exactKeys: Set<string>;
  templateRoots: Set<string>;
}

function scan(): Usage[] {
  return SCANNED_FILES.map((file) => {
    const source = fs.readFileSync(path.join(project, file), 'utf8');
    const exactKeys = new Set<string>();
    const templateRoots = new Set<string>();
    for (const match of source.matchAll(EXACT_KEY)) exactKeys.add(match[1]);
    for (const match of source.matchAll(TEMPLATE_ROOT)) templateRoots.add(match[1].replace(/\.$/, ''));
    return { file, exactKeys, templateRoots };
  });
}

/**
 * 冲突判据：同一个路径既被当**字符串叶**（exact）又被当**分支**（是某个模板根或它的祖先）。
 *
 * ⚠️ 反向不冲突：exact 键比模板根**更深**（`a.b.c` 与根 `a.b`）是合法的 ——
 *    `a.b = { c: '…' }` 同时满足两边。
 */
function collisions(usages: Usage[]): string[] {
  const exactByPath = new Map<string, string[]>();
  for (const usage of usages) {
    for (const key of usage.exactKeys) {
      exactByPath.set(key, [...(exactByPath.get(key) ?? []), usage.file]);
    }
  }
  const found: string[] = [];
  for (const usage of usages) {
    for (const root of usage.templateRoots) {
      for (const [key, owners] of exactByPath) {
        if (root === key || root.startsWith(`${key}.`)) {
          found.push(
            `键 \`${key}\` 在 ${owners.join(' / ')} 被当**字符串**渲染，` +
              `却在 ${usage.file} 被当作**分支**（模板根 \`${root}\`）—— 定稿时必有一边上屏成机器话`,
          );
        }
      }
    }
  }
  return found;
}

describe('i18n 键形状：不许同一路径既是字符串叶又是分支（T32/T33）', () => {
  it('⭐ 扫到的文件里没有形状冲突', () => {
    expect(collisions(scan())).toEqual([]);
  });

  it('守卫本身有效：人为构造的冲突必须被判出来（不是空转通过）', () => {
    const synthetic: Usage[] = [
      { file: 'label.tsx', exactKeys: new Set(['identity.industryMethod']), templateRoots: new Set() },
      { file: 'lines.ts', exactKeys: new Set(), templateRoots: new Set(['identity.industryMethod']) },
    ];
    expect(collisions(synthetic)).toHaveLength(1);
    // 更深一层的 exact 键（`a.b.c` 与根 `a.b`）**不**算冲突 —— 反向对照。
    const legal: Usage[] = [
      { file: 'label.tsx', exactKeys: new Set(['a.b.c']), templateRoots: new Set() },
      { file: 'lines.ts', exactKeys: new Set(), templateRoots: new Set(['a.b']) },
    ];
    expect(collisions(legal)).toEqual([]);
  });

  it('行业方法三行的键与「个性化中心」那个字符串标签键不在同一条路径上', () => {
    // 这条是上一条的**点名版**：把已知的那对写死，坏掉时报错直接指出是哪个键。
    const usages = scan();
    const identity = usages.find((u) => u.file.endsWith('IdentityCenter/index.tsx'));
    const industry = usages.find((u) => u.file.endsWith('industry-method.ts'));
    expect(identity, '没扫到 IdentityCenter').toBeDefined();
    expect(industry, '没扫到 industry-method').toBeDefined();

    const labelKey = 'identity.industryMethod';
    expect(identity!.exactKeys.has(labelKey), `IdentityCenter 不再把 ${labelKey} 当字符串标签渲染了？`).toBe(true);
    for (const root of industry!.templateRoots) {
      expect(
        root === labelKey || root.startsWith(`${labelKey}.`),
        `行业方法三行的键根 \`${root}\` 与字符串标签 \`${labelKey}\` 撞在同一条路径上`,
      ).toBe(false);
    }
  });
});
