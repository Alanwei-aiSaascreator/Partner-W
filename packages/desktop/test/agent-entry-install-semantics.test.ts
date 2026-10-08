import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BUG-025（A 组 · 智能体入口语义）：**正式产品结构不是 Agent Store**。
 *
 * 助手/团队的入口文案里不许再出现"安装"语义（中英日韩德法西葡 9 语言）——
 * 执行结构是「主罗盘 + 五岗位」，能力入口的说法是「在罗盘助手中使用」/「前往罗盘助手查看」。
 *
 * ⚠️ 技能（Skill）那两处**刻意不在**本清单里：`skillMarket.*` / `settings.skillHub*`
 *    说的是技能包真的被装上网关，那是准确说法，不是 Agent Store 残留。
 */
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(TEST_DIR, '../src/renderer/i18n/locales');

const LOCALES = ['zh', 'zh-TW', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'pt'];

/** 入口面：这些键的值里不许出现"安装"。 */
const ENTRY_KEYS = [
  'market.useInCompass',
  'market.preparing',
  'market.actionFailed',
  'market.usageCount',
  'market.empty',
  'market.recordWarning',
  'market.deleteBlocked',
  'market.deleteConfirm',
  'market.instructionsLabel',
  'market.publicClosedBody',
  'agent.missingBody',
  'teams.needsInstall',
  'teams.agentNotInstalled',
  'teams.wizard.install',
  'teams.wizard.reviewInstall',
  'teams.wizard.installComplete',
  'teams.wizard.installError',
  'teams.wizard.installing',
  'teamshub.install',
  'teamshub.installed',
  'teamshub.installSuccess',
];

/** Agent Store 式旧键：整体删掉，别让"安装 → 安装成功 → 去使用"那套流程悄悄回来。 */
const REMOVED_KEYS = [
  'market.install',
  'market.installed',
  'market.installing',
  'market.installDone',
  'market.installFailed',
  'market.installCount',
  'market.alreadyInstalled',
];

const FORBIDDEN = [/安装/u, /安裝/u, /装上/u, /裝上/u, /\binstall/iu, /インストール/u, /설치/u];

function readLocale(code: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8')) as Record<string, unknown>;
}

function lookup(root: Record<string, unknown>, dotted: string): unknown {
  let node: unknown = root;
  for (const part of dotted.split('.')) {
    if (!node || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

describe('BUG-025 智能体入口语义', () => {
  for (const locale of LOCALES) {
    it(`${locale}：入口文案里不出现"安装"语义`, () => {
      const root = readLocale(locale);
      const offenders: string[] = [];
      for (const key of ENTRY_KEYS) {
        const value = lookup(root, key);
        expect(typeof value, `${locale} 缺键 ${key}`).toBe('string');
        for (const pattern of FORBIDDEN) {
          if (pattern.test(value as string)) offenders.push(`${key} ⇒ ${value}`);
        }
      }
      expect(offenders).toEqual([]);
    });

    it(`${locale}：Agent Store 式的旧键已删除（不再有第二套"安装成功"流程）`, () => {
      const root = readLocale(locale);
      const leftover = REMOVED_KEYS.filter((key) => lookup(root, key) !== undefined);
      expect(leftover).toEqual([]);
    });
  }
});
