import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { installBundledSkill, readBundledSkills, readInstalledSkillContent } from '../src/main/skills/bundled.js';
import { resolveOurSkillsRoot } from '../src/main/skills/locate.js';

// Frozen upstream byte hashes; no external checkout/network dependency at runtime.
const upstreamHashes: Record<string, string> = {
  'deploy-checklist': '3e016dcaaa9adfa84696b6092e6ee701e3fe5a9c0aaa7d7982cc86edce0586f6',
  debug: '4d0ea5092ceea252141bf654ae38825be9aac742ad97efb23fb564b4652b925f',
  'tech-debt': 'fa489e7f246fad019056173ba1e26410f56313064f3b0c056b995c32ae328900',
  'incident-response': '1885c8a3d767e3ad488b48678ef68571bbb5008e04178e9d4015a50f52b77cde',
  'system-design': '02a240379acf03cba4a6ef7a829f492299c85087741793f1e067db2c37a7ad62',
  'testing-strategy': '73a85641a7c4f31b53137d9a41894404deb56532a065ccabadcae37f5167ee79',
  documentation: '903ab8f6f5dffd3cad3b55118f5e2186c5537690633ec653629b7f9afaa7df79',
  'code-review': '381b5a54d034c60aca80720a246e5da9b7f6af636131560b1a46b0e9b758b8ca',
  architecture: 'f93dbd1d0aa7157cb08b327c3613e924fef0998af538e4435be76905b1c6fde4',
};
const licenseHash = '1b1689d7864727a02a2682067f9c5328c891518db0a513663ef5a949052bd40b';
const commit = 'f79015b078c4d5d4c309a1bf6f3cd39ac06cc18f';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = resolveOurSkillsRoot({ isPackaged: false, appPath: project });
const prefix = 'octop-engineering-';
const workflows: Record<string, RegExp[]> = {
  architecture: [/ADR/, /复杂度/, /成本/, /可扩展/, /后果/],
  'code-review': [/SSRF/, /N\+1/, /并发/, /文件.*行号/, /严重度/],
  debug: [/复现/, /隔离/, /假设/, /根因/, /回归/],
  'deploy-checklist': [/发布前/, /发布阶段/, /发布后/, /回滚/, /迁移/, /阈值/],
  documentation: [/README/, /API/, /Runbook/, /架构/, /入职/],
  'incident-response': [/SEV1/, /SEV4/, /时间线/, /5 Whys/, /负责人/, /无责/],
  'system-design': [/功能需求/, /API/, /数据模型/, /缓存/, /故障转移/, /权衡/],
  'tech-debt': [/代码债/, /架构债/, /测试债/, /依赖债/, /文档债/, /基础设施债/, /\(影响 \+ 风险\) × \(6 - 工作量\)/],
  'testing-strategy': [/E2E/, /集成/, /单元/, /幂等/, /可访问性/, /数据完整性/],
};
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    const relative = path.relative(os.tmpdir(), dir);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      !path.basename(dir).startsWith('octop-engineering-test-')
    )
      throw new Error('Refuse cleanup outside owned test directory');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('Octop engineering: real discovery, install, provenance and references', () => {
  it.each(Object.keys(upstreamHashes))('%s is discoverable, localized and self-contained', (id) => {
    const slug = prefix + id;
    const skill = readBundledSkills(root).find((entry) => entry.slug === slug);
    expect(skill, `缺技能 ${slug}`).toBeDefined();
    if (!skill?.content || !root) throw new Error(`缺技能正文 ${slug}`);
    expect(skill.skillKey).toBe(slug);
    expect(slug).toMatch(/^[a-z0-9-]+$/);
    expect(skill.name).toMatch(/[\u4e00-\u9fff]/);
    expect(skill.description).toMatch(/[\u4e00-\u9fff]/);
    expect(skill.description!.length).toBeLessThanOrEqual(200);
    expect(skill.content).not.toMatch(/@\$1|\$ARGUMENTS|CONNECTORS\.md|~~|^#\s+\/|^argument-hint:/m);
    for (const term of workflows[id]) expect(skill.content).toMatch(term);
    for (const contract of [
      '不改变现有权限',
      '校验 → 登记 artifact → 用户能打开',
      '仅输出建议清单或草稿',
      'Modified / Adapted',
      'knowledge-work-plugins',
    ])
      expect(skill.content).toContain(contract);
    const links = [...skill.content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)];
    expect(links.map((match) => match[1])).toEqual(expect.arrayContaining(['LICENSE', 'SOURCE.json']));
    for (const [, target] of links) {
      expect(target).not.toMatch(/^(?:https?:|\/|[A-Za-z]:)|\.\./);
      expect(fs.existsSync(path.join(root, slug, target))).toBe(true);
    }
    const source: unknown = JSON.parse(fs.readFileSync(path.join(root, slug, 'SOURCE.json'), 'utf8'));
    expect(source).toMatchObject({
      repository: 'https://github.com/TencentCloud/Octop',
      commit,
      license: 'Apache-2.0',
      sources: expect.arrayContaining([
        {
          path: `src/octop/infra/agents/experts/library/engineering/skills/${id}/SKILL.md`,
          sha256: upstreamHashes[id],
        },
        { path: 'src/octop/infra/agents/experts/library/LICENSE', sha256: licenseHash },
      ]),
      originalSource: {
        type: 'knowledge-work-plugins',
        plugin: 'engineering',
        url: 'https://github.com/anthropics/knowledge-work-plugins/tree/main/engineering',
      },
      modified: true,
      modifications: expect.arrayContaining([expect.stringMatching(/中文/), expect.stringMatching(/权限/)]),
    });
    const license = fs.readFileSync(path.join(root, slug, 'LICENSE'));
    expect(createHash('sha256').update(license).digest('hex')).toBe(licenseHash);
    expect(license.toString('utf8')).toContain('Apache License');
  });

  it.each(Object.keys(upstreamHashes))('%s installs through the production installer with references intact', (id) => {
    const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octop-engineering-test-'));
    temps.push(managedDir);
    const slug = prefix + id;
    expect(installBundledSkill({ root, managedDir, slug }), `缺技能或安装失败 ${slug}`).toMatchObject({ ok: true });
    if (!root) throw new Error('Missing skill root');
    expect(readInstalledSkillContent(managedDir, slug)).toBe(
      readBundledSkills(root).find((s) => s.slug === slug)?.content,
    );
    for (const file of ['LICENSE', 'SOURCE.json'])
      expect(fs.readFileSync(path.join(managedDir, slug, file))).toEqual(fs.readFileSync(path.join(root, slug, file)));
    for (const [, target] of readInstalledSkillContent(managedDir, slug)!.matchAll(/\[[^\]]+\]\(([^)]+)\)/g))
      expect(fs.existsSync(path.join(managedDir, slug, target))).toBe(true);
  });

  it('does not add standup; reuses the existing weekly report', () => {
    const skills = readBundledSkills(root);
    expect(skills.some((s) => s.slug === prefix + 'standup')).toBe(false);
    expect(skills.some((s) => s.slug === 'weekly-report')).toBe(true);
  });
});
