import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readBundledSkills } from '../src/main/skills/bundled.js';
import { resolveOurSkillsRoot } from '../src/main/skills/locate.js';

/**
 * 18 个 Octop 专家技能的**来源与许可完整性**（2026-10-15）。
 *
 * ## 为什么单独一份
 *
 * 已有三组 octop 测试各管自己那一摊：
 *   · `octop-design-skills.test.ts` 逐个钉 7 个设计技能，**只有它**断言
 *     `adaptedSha256 == sha256(SKILL.md)`（我们这侧正文的自哈希）；
 *   · `octop-engineering-skills.test.ts` / `octop-method-skills.test.ts` 钉的是
 *     **上游**字节哈希（`sources[].sha256`），**不钉我们这侧正文**。
 *
 * 于是 18 份记录里出现了一个**不对称**：7 份写了自哈希、11 份没写。
 * 后果不是"文件坏了"，而是**改动不被记账** —— 谁悄悄改了那 11 份 SKILL.md，
 * 仓库里没有任何一处会红；而这 18 份正文就是随包发给用户的**全部专家提示词**。
 * 这份文件把口径拉齐：**18/18 都要把"我发出去的这份正文"钉在记录里**。
 *
 * ## 它不证明、也不该声称的事
 *
 * · 自哈希是**改动记账**，不是来源证明 —— 它只能证明"记录与文件一致"，
 *   证明不了"这份文件真的派生自那个上游提交"。后者只有拿到上游检出才能核，
 *   而本仓库刻意**不在测试里依赖外部检出**（见 `octop-engineering-skills.test.ts`
 *   的 "Frozen upstream byte hashes; no external checkout/network dependency"）。
 * · 它**不**覆盖 18 个技能之外的专家层（上游 `manifest.json` 的 label / 头像 /
 *   欢迎语 / 快捷提示词、以及专家级 `SOUL.md`）—— 那些**没有**随包进来。
 * · 它**不**核头像权利：上游头像在 `dashboard/public/experts/avatars/`，
 *   **不在**专家库 Apache-2.0 许可目录内，本包一个字节都没有取。
 */

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 用**产品那份**根目录解析器，而不是测试自己拼一个 —— 跟着解析层一起受检。 */
const resolvedRoot = resolveOurSkillsRoot({ isPackaged: false, appPath: project });
// 解析不出来就不许往下走：静默降级会让下面每一条断言都"空转通过"。
if (!resolvedRoot) throw new Error('our-skills 根目录解析失败（resolveOurSkillsRoot 返回空）');
const root: string = resolvedRoot;

/** 上游钉死的那一个提交；改它 = 所有来源哈希需要重取，必须是一次显式决定。 */
const UPSTREAM_COMMIT = 'f79015b078c4d5d4c309a1bf6f3cd39ac06cc18f';
/** 专家库 `library/LICENSE`（Apache-2.0 正文）逐字节哈希 —— 18 份 LICENSE 都必须是它。 */
const LIBRARY_LICENSE_SHA = '1b1689d7864727a02a2682067f9c5328c891518db0a513663ef5a949052bd40b';

/**
 * 18 个 slug 的**记账清单**（不是"允许清单"）。
 *
 * 多一个 / 少一个都会红：新技能随包进来时，必须有人把它登记进来并给出完整来源记录
 * —— 这正是"18 技能 ≠ 18 专家 ≠ 全部上游提示词"这件事不许再悄悄漂移的地方。
 */
const EXPECTED_SLUGS = [
  'octop-design-accessibility-review',
  'octop-design-design-critique',
  'octop-design-design-handoff',
  'octop-design-design-system',
  'octop-design-research-synthesis',
  'octop-design-user-research',
  'octop-design-ux-copy',
  'octop-engineering-architecture',
  'octop-engineering-code-review',
  'octop-engineering-debug',
  'octop-engineering-deploy-checklist',
  'octop-engineering-documentation',
  'octop-engineering-incident-response',
  'octop-engineering-system-design',
  'octop-engineering-tech-debt',
  'octop-engineering-testing-strategy',
  'octop-knowledge-wiki',
  'octop-news-brief',
] as const;

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const readBytes = (slug: string, file: string): Buffer => fs.readFileSync(path.join(root, slug, file));
const readText = (slug: string, file: string): string => readBytes(slug, file).toString('utf8');

interface SourceRecord {
  repository?: string;
  commit?: string;
  license?: string;
  adaptedSha256?: string;
  sources?: Array<{ path?: string; sha256?: string }>;
}

const recordOf = (slug: string): SourceRecord => JSON.parse(readText(slug, 'SOURCE.json')) as SourceRecord;

describe('Octop 18 专家技能：随包清单与来源记录完整性', () => {
  it('⭐ 盘上正好是登记的这 18 个（多一个少一个都要有人来登记，不靠默认值兜）', () => {
    const onDisk = readBundledSkills(root)
      .filter((skill) => skill.slug.startsWith('octop-'))
      .map((skill) => skill.slug)
      .sort();
    expect(onDisk, '随包 octop 技能清单与登记不一致').toEqual([...EXPECTED_SLUGS].sort());
    // 反向：每个登记项都被**产品解析器**认出来（目录在、SKILL.md 能被解析出 name/description）。
    for (const slug of EXPECTED_SLUGS) {
      const skill = readBundledSkills(root).find((entry) => entry.slug === slug);
      expect(skill?.name, `${slug} 没被解析出中文 name`).toBeTruthy();
      expect(skill?.skillKey, `${slug} 的 skillKey 不等于 slug`).toBe(slug);
    }
  });

  it('⭐ 18/18 记录都写明来源仓库 / 上游提交 / Apache-2.0，且 LICENSE 是专家库那一份逐字节原文', () => {
    for (const slug of EXPECTED_SLUGS) {
      const record = recordOf(slug);
      expect(record.repository, `${slug} 缺 repository`).toBe('https://github.com/TencentCloud/Octop');
      expect(record.commit, `${slug} 的上游提交不是钉死的那一个`).toBe(UPSTREAM_COMMIT);
      expect(record.license, `${slug} 的许可不是专家库那份`).toBe('Apache-2.0');
      expect(record.sources?.length ?? 0, `${slug} 没有来源清单`).toBeGreaterThan(0);
      for (const source of record.sources ?? []) {
        expect(source.path, `${slug} 的来源缺 path`).toBeTruthy();
        expect(source.sha256, `${slug} 的 ${source.path} 缺 sha256`).toMatch(/^[a-f0-9]{64}$/);
      }
      expect(sha256(readBytes(slug, 'LICENSE')), `${slug} 的 LICENSE 不是专家库 Apache-2.0 原文`).toBe(
        LIBRARY_LICENSE_SHA,
      );
      expect(readText(slug, 'LICENSE')).toContain('Apache License');
      expect(readText(slug, 'LICENSE')).toContain('Version 2.0, January 2004');
    }
  });

  it('⭐ 18/18 都把随包正文的自哈希记在案（改了正文不更新记录 ⇒ 这里红，不是静默漂移）', () => {
    const missing: string[] = [];
    const drifted: string[] = [];
    for (const slug of EXPECTED_SLUGS) {
      const recorded = recordOf(slug).adaptedSha256;
      const actual = sha256(readBytes(slug, 'SKILL.md'));
      if (!recorded) missing.push(slug);
      else if (recorded !== actual) drifted.push(`${slug}: recorded=${recorded} actual=${actual}`);
    }
    expect(missing, `这些技能没有记录随包正文的自哈希：${missing.join(', ')}`).toEqual([]);
    expect(drifted, `随包正文与记录里的自哈希不一致：${drifted.join(' | ')}`).toEqual([]);
  });

  it('⭐ 三份文件都在且非空（少一份等于来源或许可断链）', () => {
    for (const slug of EXPECTED_SLUGS) {
      for (const file of ['SKILL.md', 'SOURCE.json', 'LICENSE']) {
        expect(readBytes(slug, file).length, `${slug}/${file} 是空的或读不到`).toBeGreaterThan(0);
      }
    }
  });
});
