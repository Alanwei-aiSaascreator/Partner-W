import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installBundledSkill,
  readBundledSkills,
  readSkillFileSha,
  skillContentSha,
  skillDirFilePaths,
  skillDirManifestSha,
  stageBundledSkillPackage,
  planSkillSync,
  encodeSkillRecord,
  type ManagedSkillRecordV2,
} from '../src/main/skills/bundled.js';

const root = path.join(import.meta.dirname, '../our-skills');
const names = [
  'accessibility-review',
  'design-critique',
  'design-handoff',
  'design-system',
  'research-synthesis',
  'user-research',
  'ux-copy',
] as const;
const requiredSections: Record<(typeof names)[number], string[]> = {
  'accessibility-review': [
    'Perceivable',
    'Operable',
    'Understandable',
    'Robust',
    'Keyboard Navigation',
    'Screen Reader',
  ],
  'design-critique': ['First Impression', 'Usability', 'Visual Hierarchy', 'Consistency', 'Priority Recommendations'],
  'design-handoff': ['Visual Specifications', 'Interaction Specifications', 'Edge Cases', 'Animation / Motion'],
  'design-system': ['Design Tokens', 'Output — Audit', 'Output — Document', 'Output — Extend'],
  'research-synthesis': ['Supporting Evidence', 'Insights → Opportunities', 'Methodology Notes'],
  'user-research': ['Research Methods', 'Interview Guide Structure', 'Analysis Framework', 'Deliverables'],
  'ux-copy': ['CTAs', 'Error Messages', 'Empty States', 'Confirmation Dialogs', 'Localization Notes'],
};
const temps: string[] = [];
const temporary = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octop-design-test-'));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) {
    const resolved = path.resolve(dir);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('octop-design-test-')
    )
      throw new Error('Unexpected cleanup path');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
const snapshot = (dir: string) =>
  Object.fromEntries((skillDirFilePaths(dir) ?? []).map((file) => [file, readSkillFileSha(dir, file)]));

for (const name of names) {
  const slug = `octop-design-${name}`;
  describe(slug, () => {
    it('discovers Chinese metadata and preserves the substantive upstream workflow', () => {
      const skill = readBundledSkills(root).find((entry) => entry.slug === slug);
      expect(skill, 'new design skill must be discovered').toBeDefined();
      expect(skill?.skillKey).toBe(slug);
      expect(skill?.name).toMatch(/[一-鿿]/);
      expect(skill?.description).toMatch(/[一-鿿]/);
      const content = skill?.content ?? '';
      for (const heading of requiredSections[name]) expect(content).toContain(heading);
      expect(content).not.toMatch(
        /CONNECTORS\.md|\$ARGUMENTS|@\$1|~~|^# \/|^\/(?:accessibility-review|design-|research-|user-|ux-copy)/m,
      );
      expect(content).toContain('不代表 Figma 已连接');
      expect(content).toContain('未验证');
      expect(content).toContain('不得自动外发');
      expect(content).toContain('不得启动付费调用');
      expect(content).toContain('不得自动写系统配置');
    });
    it('records pinned upstream hashes and retains the applicable library license and modified notice', () => {
      const dir = path.join(root, slug);
      const metadata: unknown = JSON.parse(read(dir, 'SOURCE.json'));
      expect(metadata).toMatchObject({
        commit: 'f79015b078c4d5d4c309a1bf6f3cd39ac06cc18f',
        license: 'Apache-2.0',
        sourceType: 'knowledge-work-plugins',
        modified: true,
      });
      const source = metadata as {
        sources: Array<{ path: string; sha256: string }>;
        adaptedSha256: string;
        adaptationNotes: string[];
      };
      expect(source.sources.map((item) => item.path)).toContain(
        `src/octop/infra/agents/experts/library/design/skills/${name}/SKILL.md`,
      );
      expect(source.sources.map((item) => item.path)).toContain('src/octop/infra/agents/experts/library/LICENSE');
      for (const item of source.sources) expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(source.adaptationNotes.length).toBeGreaterThan(2);
      expect(source.adaptedSha256).toBe(
        createHash('sha256')
          .update(fs.readFileSync(path.join(dir, 'SKILL.md')))
          .digest('hex'),
      );
      expect(read(dir, 'LICENSE')).toContain('Apache License');
      expect(read(dir, 'LICENSE')).toContain('Version 2.0, January 2004');
      expect(read(dir, 'SKILL.md')).toContain('修改说明');
    });
    it('installs and reinstalls the real package byte-for-byte while preserving user extras', () => {
      const managedDir = temporary();
      expect(installBundledSkill({ root, managedDir, slug })).toMatchObject({ ok: true });
      const target = path.join(managedDir, slug);
      const expected = snapshot(path.join(root, slug));
      expect(snapshot(target)).toEqual(expected);
      fs.writeFileSync(path.join(target, 'user-note.txt'), 'keep my notes');
      expect(installBundledSkill({ root, managedDir, slug })).toMatchObject({ ok: true });
      for (const [file, hash] of Object.entries(expected)) expect(readSkillFileSha(target, file)).toBe(hash);
      expect(read(target, 'user-note.txt')).toBe('keep my notes');
    });
    it('rejects user-modified files on a real-filesystem version update without overwriting them', () => {
      const managedDir = temporary();
      expect(installBundledSkill({ root, managedDir, slug })).toMatchObject({ ok: true });
      const target = path.join(managedDir, slug);
      const record: ManagedSkillRecordV2 = {
        version: 2,
        packageSha: skillDirManifestSha(path.join(root, slug))!,
        files: snapshot(target) as Record<string, string>,
      };
      const nextRoot = temporary();
      fs.cpSync(path.join(root, slug), path.join(nextRoot, slug), { recursive: true });
      fs.appendFileSync(path.join(nextRoot, slug, 'SKILL.md'), '\nVendor version two\n');
      fs.appendFileSync(path.join(target, 'SKILL.md'), '\nUser owns this edit\n');
      fs.writeFileSync(path.join(target, 'user-note.txt'), 'private');
      const before = snapshot(target);
      const next = stageBundledSkillPackage({ root: nextRoot, slug });
      expect(next.ok).toBe(true);
      if (!next.ok) throw new Error(next.error);
      try {
        const installed = {
          skillSha: skillContentSha(read(target, 'SKILL.md')),
          fileSha: (file: string) => readSkillFileSha(target, file),
        };
        const input = {
          packageSha: skillDirManifestSha(path.join(nextRoot, slug))!,
          nextFiles: next.staged.files,
          installed,
        };
        expect(planSkillSync({ ...input, recorded: encodeSkillRecord(record) })).toMatchObject({
          kind: 'conflict',
          reason: 'user-modified',
          paths: ['SKILL.md'],
        });
        expect(planSkillSync({ ...input, recorded: undefined })).toMatchObject({
          kind: 'conflict',
          reason: 'unverified-origin',
        });
        expect(snapshot(target)).toEqual(before);
      } finally {
        next.staged.cleanup();
      }
    });
    it('keeps every local document link inside the package and resolvable after installation', () => {
      const managedDir = temporary();
      expect(installBundledSkill({ root, managedDir, slug })).toMatchObject({ ok: true });
      const target = path.join(managedDir, slug);
      const markdown = (skillDirFilePaths(target) ?? []).filter((file) => file.endsWith('.md'));
      let count = 0;
      for (const file of markdown) {
        for (const match of read(target, file).matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
          const link = match[1];
          if (/^https?:\/\//.test(link) || link.startsWith('#')) continue;
          const destination = path.resolve(path.dirname(path.join(target, file)), link.split('#')[0]);
          const relative = path.relative(target, destination);
          expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);
          expect(fs.existsSync(destination), `${file}: ${link}`).toBe(true);
          count++;
        }
      }
      expect(count).toBeGreaterThanOrEqual(2);
      expect(markdown.filter((file) => path.basename(file) === 'SKILL.md')).toEqual(['SKILL.md']);
    });
  });
}
