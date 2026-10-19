import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installBundledSkill,
  readBundledSkills,
  planSkillSync,
  readSkillFileSha,
  stageBundledSkillPackage,
} from '../src/main/skills/bundled.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../our-skills');
const slugs = ['octop-knowledge-wiki', 'octop-news-brief'];
const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) {
    if (path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('octop-method-'))
      throw new Error('unexpected scratch path');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
describe('Octop method resources through production installer', () => {
  it.each(slugs)('%s is discoverable and installs provenance with its content', (slug) => {
    expect(readBundledSkills(root).find((skill) => skill.slug === slug)).toBeDefined();
    const managedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'octop-method-'));
    temps.push(managedDir);
    expect(installBundledSkill({ root, managedDir, slug }).ok).toBe(true);
    const target = path.join(managedDir, slug);
    for (const filename of ['SKILL.md', 'LICENSE', 'SOURCE.json']) {
      expect(fs.readFileSync(path.join(target, filename))).toEqual(fs.readFileSync(path.join(root, slug, filename)));
    }
    const source: unknown = JSON.parse(fs.readFileSync(path.join(target, 'SOURCE.json'), 'utf8'));
    expect(source).toMatchObject({
      repository: 'https://github.com/TencentCloud/Octop',
      commit: 'f79015b078c4d5d4c309a1bf6f3cd39ac06cc18f',
    });
    const stage = stageBundledSkillPackage({ root, slug });
    expect(stage.ok).toBe(true);
    if (!stage.ok) throw new Error(stage.error);
    try {
      const installed = { skillSha: null, fileSha: (p: string) => readSkillFileSha(target, p) };
      const args = { packageSha: 'candidate-test', nextFiles: stage.staged.files, recorded: undefined, installed };
      expect(planSkillSync(args).kind).toBe('adopt');
      fs.appendFileSync(path.join(target, 'SKILL.md'), '\n用户自定义规则\n');
      expect(planSkillSync(args)).toMatchObject({ kind: 'conflict', paths: expect.arrayContaining(['SKILL.md']) });
      expect(fs.readFileSync(path.join(target, 'SKILL.md'), 'utf8')).toContain('用户自定义规则');
    } finally {
      stage.staged.cleanup();
    }
  });
});
