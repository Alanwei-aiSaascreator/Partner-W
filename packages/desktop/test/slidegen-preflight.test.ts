import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { installBundledSkill } from '../src/main/skills/bundled';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'slidegen-preflight-'));
const workspace = path.join(temporary, 'workspace');
const managedDir = path.join(temporary, 'managed');
const command = path.join(managedDir, 'deck-layout/scripts/preflight.cjs');
const fence = (source: string, title = 'Sample') => `\`\`\`slidegen\n// title: ${title}\n${source}\n\`\`\`\n`;
const { NODE_OPTIONS: ignoredOptions, NODE_PATH: ignoredNodePath, ...environment } = process.env;
void ignoredOptions;
void ignoredNodePath;

beforeAll(() => {
  fs.mkdirSync(workspace);
  expect(
    installBundledSkill({ root: path.join(import.meta.dirname, '../our-skills'), managedDir, slug: 'deck-layout' }).ok,
  ).toBe(true);
});
afterAll(() => fs.rmSync(temporary, { recursive: true, force: true }));

function invoke(...args: string[]) {
  const result = spawnSync(process.execPath, [command, ...args], {
    cwd: workspace,
    env: { ...environment, PATH: '' },
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });
  const text = result.stdout?.trim() ?? '';
  return { status: result.status, report: text.startsWith('{') ? JSON.parse(text) : null, stderr: result.stderr };
}

function check(source: string) {
  fs.writeFileSync(path.join(workspace, 'sample.slidegen'), source);
  return invoke('sample.slidegen');
}

it('runs the installed command without host modules or tools and makes only a source claim', () => {
  const source = fence('<Slide><Text>\u4e2d\u6587 \u8ba1\u5212</Text></Slide>', '\u6708\u5ea6\u8ba1\u5212');
  const result = check(source);
  expect(result.status).toBe(0);
  expect(result.report).toMatchObject({
    schemaVersion: 1,
    status: 'source-valid',
    artifactCreated: false,
    visualReview: 'not-performed',
    decks: [{ title: '\u6708\u5ea6\u8ba1\u5212', pages: 1 }],
  });
  expect(result.report.sourceSha256).toBe(createHash('sha256').update(source).digest('hex'));
  expect(fs.readdirSync(workspace)).toEqual(['sample.slidegen']);
});

it('returns the production invalid closing tag diagnostic before submission', () => {
  const result = check(fence('<Slide><Text>Body</Text invalid></Slide>'));
  expect(result.status).toBe(1);
  expect(result.report?.diagnostics[0]).toMatchObject({
    code: 'slidegen-unparsable',
    diagnostic: { code: 'dsl-unparsable', detail: 'invalid closing tag' },
  });
  expect(result.report.diagnostics[0].diagnostic.offset).toBeGreaterThan(0);
});

it('can repair and recheck the same file with a different source hash in the same workflow', () => {
  const bad = check(fence('<Slide><Text>Body</Box></Slide>'));
  const good = check(fence('<Slide><Text>Body</Text></Slide>'));
  expect(bad.status).toBe(1);
  expect(good.status).toBe(0);
  expect(bad.report?.sourceSha256).not.toBe(good.report?.sourceSha256);
});

it.each([
  ['```slidegen\n// title: Sample\n<Slide>', 'slidegen-block-unclosed'],
  ['<Slide><Text>Body</Text></Slide>', 'slidegen-file-no-fence'],
  ['```slidegen\n\n```', 'slidegen-block-empty'],
  ['```slidegen\n<Slide/>\n```', 'slidegen-title-missing'],
])('reports malformed file boundaries: %s', (source, code) => {
  const result = check(source);
  expect(result.status).toBe(1);
  expect(result.report?.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
});

it('evaluates declared components and reports undefined components without process access', () => {
  expect(
    check(fence('const Heading = ({children}) => <Text>{children}</Text>; <Slide><Heading>Title</Heading></Slide>'))
      .status,
  ).toBe(0);
  const missing = check(fence('<Slide><Missing /></Slide>'));
  expect(missing.report?.diagnostics[0]).toMatchObject({ code: 'dsl-eval-failed' });
  expect(check(fence('<Slide><Text>{process.env}</Text></Slide>')).status).toBe(1);
});

it('shares the production cumulative page budget', () => {
  const pages = (count: number) => fence(`Array.from({length:${count}}, () => <Slide><Text>Body</Text></Slide>);`);
  expect(check(pages(200)).status).toBe(0);
  const result = check(pages(120) + pages(81));
  expect(result.report?.diagnostics).toContainEqual({ code: 'slidegen-too-many-pages', max: 200, got: 201 });
  expect(result.status).toBe(1);
});

it('reports unavailable, oversized and non-file sources', () => {
  expect(invoke('missing.slidegen').report?.diagnostics[0].code).toBe('source-unreadable');
  expect(check('x'.repeat(1024 * 1024 + 1)).report?.diagnostics[0].code).toBe('slidegen-file-too-large');
  fs.mkdirSync(path.join(workspace, 'folder.slidegen'));
  expect(invoke('folder.slidegen').report?.diagnostics[0].code).toBe('source-not-file');
});

it('rejects parent paths and links outside the current execution workspace', () => {
  fs.writeFileSync(path.join(temporary, 'outside.slidegen'), fence('<Slide/>'));
  expect(invoke('../outside.slidegen').report?.diagnostics[0].code).toBe('source-outside-workspace');
  fs.symlinkSync(temporary, path.join(workspace, 'external'), 'junction');
  expect(invoke('external/outside.slidegen').report?.diagnostics[0].code).toBe('source-outside-workspace');
});

it('checks the original twelve-page and nine-page source fixtures', () => {
  for (const [file, pages] of [
    ['slidegen-field-product-introduction-first.slidegen', 12],
    ['slidegen-field-product-introduction.slidegen', 9],
  ] as const) {
    const result = check(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', file), 'utf8'));
    expect(result.status).toBe(0);
    expect(result.report?.decks[0].pages).toBe(pages);
    expect(result.report?.visualReview).toBe('not-performed');
  }
});

it('has an actual standalone self-test for package verification', () => {
  expect(invoke('--self-test')).toMatchObject({
    status: 0,
    report: { command: 'slidegen-source-preflight', schemaVersion: 1, ok: true },
  });
});

it('reports invalid UTF-8 instead of accepting silent replacement characters', () => {
  fs.writeFileSync(path.join(workspace, 'encoding.slidegen'), Buffer.from([0xc3, 0x28]));
  expect(invoke('encoding.slidegen').report?.diagnostics[0].code).toBe('source-encoding-invalid');
});

it('guides actual in-turn execution without claiming a generated or visually reviewed artifact', () => {
  const guide = fs.readFileSync(path.join(managedDir, 'deck-layout/SKILL.md'), 'utf8');
  expect(guide).toContain('node "{baseDir}/scripts/preflight.cjs"');
  expect(guide).toContain('source-valid');
  expect(guide).toContain('artifactCreated:false');
  expect(guide).toContain('sourceSha256');
  expect(guide).toContain("'requires': { 'bins': ['node'] }");
  expect(guide).toContain('exec');
});
