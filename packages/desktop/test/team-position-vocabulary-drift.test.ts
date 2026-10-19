import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ROUNDTABLE_POSITIONS } from '../src/renderer/layouts/TeamsPanel/roundtable';
import { SUPPORTED_LANGUAGE_CODES } from '@clawwork/shared';

/**
 * 五岗位词表**不许悄悄漂移**（2026-10-16，T30）。
 *
 * ## 为什么要有这一条
 *
 * 「主罗盘 + 五岗位」是**冻结契约**，词表唯一源是 `identity.teamPosition.*`（9 语言）。
 * 但盘上这份 id 清单**写在两个地方**，而且是**两份拷贝**、不是一处导出：
 *
 *   · `layouts/TeamsPanel/roundtable.ts` 的 `ROUNDTABLE_POSITIONS`
 *   · `layouts/IdentityCenter/index.tsx` 的 `TEAM_POSITION_IDS`
 *
 * `roundtable.ts` 的注释写着「跟个性化中心**共用一套**…别再另起一套自己的 id/文案键」——
 * 但代码里没有任何一处保证这一点。只要有人在一边加/删/改名，
 * 圆桌上会多出（或少掉）一个徽章，而 `identity.teamPosition.<新id>.name` 大概率不存在
 * ⇒ **徽章下面挂着裸键名**，且没有任何门禁会红。
 *
 * ## 它怎么判
 *
 * 从**源码文本**里读出 `IdentityCenter` 那份清单（不 import —— 那一页拉起来要整条
 * 网关/目录链，测试里不值当），再与圆桌那份**逐元素**比。两份都必须与 9 语言的
 * `identity.teamPosition.*` 的键集**完全相等**（多一个少一个都要有人来登记）。
 */

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readIdentityCenterPositionIds(): string[] {
  const source = fs.readFileSync(path.join(project, 'src/renderer/layouts/IdentityCenter/index.tsx'), 'utf8');
  const match = /TEAM_POSITION_IDS\s*=\s*\[([^\]]*)\]/.exec(source);
  if (!match) throw new Error('IdentityCenter 里找不到 TEAM_POSITION_IDS 的字面量清单');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

function localePositionIds(lang: string): string[] {
  const resource = JSON.parse(
    fs.readFileSync(path.join(project, `src/renderer/i18n/locales/${lang}.json`), 'utf8'),
  ) as { identity?: { teamPosition?: Record<string, unknown> } };
  const table = resource.identity?.teamPosition;
  if (!table || typeof table !== 'object') throw new Error(`${lang} 的 identity.teamPosition 不是对象`);
  return Object.keys(table);
}

describe('五岗位词表：圆桌 / 个性化中心 / 9 语言必须完全一致（T30）', () => {
  it('⭐ 圆桌那份与个性化中心那份逐元素相同（两份拷贝不许漂移）', () => {
    // 反空转：两边都必须真的是那五个岗位，不能是"两个空数组也算相等"。
    expect([...ROUNDTABLE_POSITIONS].sort()).toEqual(['analyst', 'creator', 'inspector', 'producer', 'researcher']);
    expect(readIdentityCenterPositionIds().length).toBe(5);
    expect([...ROUNDTABLE_POSITIONS].sort()).toEqual(readIdentityCenterPositionIds().sort());
  });

  it('⭐ 9 语言的 identity.teamPosition 键集与这两份都相同（徽章不会挂裸键）', () => {
    const expected = [...ROUNDTABLE_POSITIONS].sort();
    for (const lang of SUPPORTED_LANGUAGE_CODES) {
      expect(localePositionIds(lang).sort(), `${lang} 的 identity.teamPosition 与五岗位清单不一致`).toEqual(expected);
    }
  });

  it('⭐ 每个岗位在每种语言下都有非空的 name 与 duty（少一个就是空徽章/空说明）', () => {
    for (const lang of SUPPORTED_LANGUAGE_CODES) {
      const resource = JSON.parse(
        fs.readFileSync(path.join(project, `src/renderer/i18n/locales/${lang}.json`), 'utf8'),
      ) as { identity?: { teamPosition?: Record<string, { name?: string; duty?: string }> } };
      for (const id of ROUNDTABLE_POSITIONS) {
        const entry = resource.identity?.teamPosition?.[id];
        expect(entry?.name?.trim(), `${lang}/${id}.name 为空`).toBeTruthy();
        expect(entry?.duty?.trim(), `${lang}/${id}.duty 为空`).toBeTruthy();
      }
    }
  });
});
