import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderNativePptFile } from '../src/main/docgen/native-file';
import { readSlideGenerationReceipt } from '../src/main/slidegen/receipt';
import {
  readBundledSkills,
  installBundledSkill,
  staleBundledSkills,
  skillContentSha,
} from '../src/main/skills/bundled';

const templatesRoot = path.join(import.meta.dirname, '../resources/pptx-templates');
const content = JSON.parse(fs.readFileSync(path.join(templatesRoot, 'native-deck/content.example.json'), 'utf8'));
let workspace: string;
const raw = () => ({
  kind: 'pptx',
  template: 'templateDeck',
  title: 'Slot contract',
  content: structuredClone(content),
});
beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-deck-lifecycle-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(workspace, { recursive: true, force: true });
});
const render = async (input = raw(), previous?: string) => {
  fs.writeFileSync(path.join(workspace, 'report.native-ppt.json'), JSON.stringify(input));
  return renderNativePptFile('report.native-ppt.json', workspace, {
    templatesRoot,
    enabled: true,
    previous,
    // The font installer is tested separately; this simulates an already prepared host.
    ensureTemplateFont: async () => {},
  });
};

describe('templateDeck existing native lifecycle', () => {
  it('records actual subset page progress and rejects a false receipt count', async () => {
    const input = raw();
    input.content = Object.fromEntries([1, 4, 16].map((page) => [page, input.content[page]]));
    fs.writeFileSync(path.join(workspace, 'report.native-ppt.json'), JSON.stringify(input));
    const progress: { completed: number; total: number }[] = [];
    const result = await renderNativePptFile('report.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      ensureTemplateFont: async () => {},
      onPage: (value) => progress.push(value),
    });
    expect(result.status).toBe('file-generated');
    expect(result.pages).toBe(3);
    expect(progress).toMatchObject([
      { completed: 1, total: 3 },
      { completed: 2, total: 3 },
      { completed: 3, total: 3 },
    ]);
    const receipt = readSlideGenerationReceipt(workspace, result.receiptFile!);
    expect(receipt.pages).toBe(3);
    const file = path.join(workspace, result.receiptFile!);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...stored, pages: 16 }));
    expect(() => readSlideGenerationReceipt(workspace, result.receiptFile!)).toThrow('receipt-version-mismatch');
  });

  it('allows no-chart layout revisions without changing numeric facts or losing the prior version', async () => {
    const firstInput = raw();
    const clean = (page: number) => content[page].map((value: string) => value.replace(/\d+(?:\.\d+)?%?/g, 'A'));
    firstInput.content = { '1': clean(1) };
    const first = await render(firstInput);
    expect(first.fileCreated).toBe(true);
    const second = await render({ ...raw(), content: { '1': clean(1), '4': clean(4) } }, first.receiptFile);
    expect(second.fileCreated).toBe(true);
    expect(second.pages).toBe(2);
    expect(second.previousOutputSha256).toBe(first.outputSha256);
    expect(readSlideGenerationReceipt(workspace, first.receiptFile!).pages).toBe(1);
  });

  it('refreshes an owned controlled Skill companion and preserves user-modified or unrecorded bodies', () => {
    const root = path.join(import.meta.dirname, '../our-skills');
    const stock = fs.readFileSync(path.join(root, 'presentation-deck-v2/SKILL.md'), 'utf8');
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '1');
    const skill = readBundledSkills(root).find((entry) => entry.slug === 'presentation-deck-v2')!;
    expect(skill.content).toContain('nonempty subset');
    expect(skill.content).toContain('hash suffix');
    const previousBody = skill.content!.replace(/Choose a nonempty subset[^\n]*?ordered once\. /, '');
    expect(previousBody).not.toBe(skill.content);
    const previousSha = skillContentSha(previousBody);
    expect(
      staleBundledSkills(
        [skill],
        () => previousBody,
        () => previousSha,
      ),
    ).toEqual([skill]);
    expect(
      staleBundledSkills(
        [skill],
        () => `${previousBody}\nUser edit`,
        () => previousSha,
      ),
    ).toEqual([]);
    expect(
      staleBundledSkills(
        [skill],
        () => previousBody,
        () => null,
      ),
    ).toEqual([]);
    const managedDir = path.join(workspace, 'private-skills');
    fs.mkdirSync(path.join(managedDir, skill.slug), { recursive: true });
    fs.writeFileSync(path.join(managedDir, skill.slug, 'SKILL.md'), previousBody);
    fs.writeFileSync(path.join(managedDir, skill.slug, 'TEMPLATE-DECK.md'), 'Old all-16 requirement');
    expect(installBundledSkill({ root, managedDir, slug: skill.slug }).ok).toBe(true);
    expect(fs.readFileSync(path.join(managedDir, skill.slug, 'TEMPLATE-DECK.md'), 'utf8')).toContain('nonempty subset');
    expect(fs.readFileSync(path.join(managedDir, skill.slug, 'SKILL.md'), 'utf8')).toBe(skill.content);
    vi.stubEnv('ROYIN_NATIVE_PPT_VALIDATION', '0');
    expect(readBundledSkills(root).find((entry) => entry.slug === skill.slug)!.content).toBe(stock);
  });
  it('binds the fixed slot table and source to the final file without claiming visual review', async () => {
    const result = await render();
    expect(result.status).toBe('file-generated');
    expect(result.pages).toBe(16);
    expect(result.visualReview).toBe('not-performed');
    const receipt = readSlideGenerationReceipt(workspace, result.receiptFile!);
    expect(receipt.templateContract).toBe('templateDeck-v2');
    expect(receipt.resources.map((r) => path.basename(r.file)).sort()).toEqual(['detail.json', 'tpl-native.pptx']);
    const detail = receipt.resources.find((r) => r.file.endsWith('/detail.json'))!;
    const oldDetail = fs.readFileSync(path.join(workspace, detail.file), 'utf8');
    expect(oldDetail).toContain('"2.0"');
    fs.writeFileSync(path.join(workspace, detail.file), oldDetail.replace('"2.0"', '"2.1"'));
    expect(() => readSlideGenerationReceipt(workspace, result.receiptFile!)).toThrow('receipt-version-mismatch');
  });
  it('preserves version links and refuses changed numeric facts in a user revision', async () => {
    const first = await render();
    expect(first.fileCreated).toBe(true);
    const second = await render({ ...raw(), title: 'Revised slot contract' }, first.receiptFile);
    expect(second.revision).toBe(1);
    expect(second.previousOutputSha256).toBe(first.outputSha256);
    const changed = raw();
    changed.content['1'][0] += ' 999';
    const blocked = await render(changed, second.receiptFile);
    expect(blocked.fileCreated).toBe(false);
    expect(blocked.diagnostics).toEqual([{ code: 'native-revision-data-changed' }]);
  });
  it('does not bypass the controlled switch or a canceled task', async () => {
    fs.writeFileSync(path.join(workspace, 'report.native-ppt.json'), JSON.stringify(raw()));
    const off = await renderNativePptFile('report.native-ppt.json', workspace, { templatesRoot });
    expect(off.fileCreated).toBe(false);
    const stopped = await renderNativePptFile('report.native-ppt.json', workspace, {
      templatesRoot,
      enabled: true,
      isCurrent: () => false,
    });
    expect(stopped.fileCreated).toBe(false);
  });
  it('links a verified tool source to the registered parent without changing either original receipt', async () => {
    const first = await render();
    const unlinked = await render({ ...raw(), title: 'User revision' });
    const original = fs.readFileSync(path.join(workspace, unlinked.receiptFile!), 'utf8');
    const source = readSlideGenerationReceipt(workspace, unlinked.receiptFile!).sourceFile;
    const linked = await renderNativePptFile(source, workspace, {
      enabled: true,
      templatesRoot,
      previous: first.receiptFile,
      sourceReceipt: unlinked.receiptFile,
      ensureTemplateFont: async () => {},
    });
    expect(linked.status).toBe('file-generated');
    expect(linked.revision).toBe(1);
    expect(linked.previousOutputSha256).toBe(first.outputSha256);
    expect(linked.fileName).not.toBe(unlinked.fileName);
    expect(fs.readFileSync(path.join(workspace, unlinked.receiptFile!), 'utf8')).toBe(original);
    expect(readSlideGenerationReceipt(workspace, first.receiptFile!).revision).toBe(0);
    expect(readSlideGenerationReceipt(workspace, unlinked.receiptFile!).revision).toBe(0);
    const checked = readSlideGenerationReceipt(workspace, linked.receiptFile!);
    expect(checked.previousReceiptFile).toBe(first.receiptFile);
    expect(checked.sourceSha256).toBe(unlinked.sourceSha256);
  });
  it('refuses altered numeric facts in an unlinked tool revision and preserves its original evidence', async () => {
    const first = await render();
    const changed = raw();
    changed.content['1'][0] += ' 999';
    const unlinked = await render(changed);
    const source = readSlideGenerationReceipt(workspace, unlinked.receiptFile!).sourceFile;
    const linked = await renderNativePptFile(source, workspace, {
      enabled: true,
      templatesRoot,
      previous: first.receiptFile,
      sourceReceipt: unlinked.receiptFile,
      ensureTemplateFont: async () => {},
    });
    expect(linked.fileCreated).toBe(false);
    expect(linked.diagnostics).toEqual([{ code: 'native-revision-data-changed' }]);
    expect(readSlideGenerationReceipt(workspace, unlinked.receiptFile!).revision).toBe(0);
  });
  it('does not use a different source or a copied workspace receipt as a managed revision', async () => {
    const first = await render();
    const unlinked = await render();
    const source = readSlideGenerationReceipt(workspace, unlinked.receiptFile!).sourceFile;
    const mismatch = await renderNativePptFile('report.native-ppt.json', workspace, {
      enabled: true,
      templatesRoot,
      previous: first.receiptFile,
      sourceReceipt: unlinked.receiptFile,
    });
    expect(mismatch.fileCreated).toBe(false);
    expect(mismatch.diagnostics).toEqual([{ code: 'native-revision-source-invalid' }]);
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), 'foreign-slot-revision-'));
    try {
      fs.cpSync(workspace, foreign, { recursive: true });
      const copied = await renderNativePptFile(source, foreign, {
        enabled: true,
        templatesRoot,
        previous: first.receiptFile,
        sourceReceipt: unlinked.receiptFile,
      });
      expect(copied.fileCreated).toBe(false);
      expect(copied.diagnostics).toEqual([{ code: 'receipt-workspace-changed' }]);
    } finally {
      fs.rmSync(foreign, { recursive: true, force: true });
    }
  });
  /**
   * Real 2026-10-04 training run: the first 8-page deck registered fine, but both the
   * 9-page and 8-page user revisions were refused as `native-revision-data-changed`
   * because the TOC was trimmed from 8 entries to 6 and the multiset guard treated the
   * dropped display ordinals 07/08 as changed business facts. The model then dropped
   * `--previous`, produced standalone revision-0 files, and registration rejected them.
   *
   * The three fixtures below are byte-exact frozen sources from that run (receipt
   * source SHA-256: 029684…, baff3258…, f86f9c2e…). Reproduce first, then fix the
   * comparison — never by dropping the fact guard wholesale.
   */
  describe('real training revision fixture', () => {
    const fixture = (name: string) =>
      JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')) as {
        kind: string;
        template: string;
        title: string;
        content: Record<string, unknown>;
      };
    const linkTo = async (first: Awaited<ReturnType<typeof render>>, input: unknown) => {
      const unlinked = await render(input as ReturnType<typeof raw>);
      expect(unlinked.fileCreated).toBe(true);
      expect(unlinked.revision).toBe(0);
      const source = readSlideGenerationReceipt(workspace, unlinked.receiptFile!).sourceFile;
      return {
        unlinked,
        linked: await renderNativePptFile(source, workspace, {
          enabled: true,
          templatesRoot,
          previous: first.receiptFile,
          sourceReceipt: unlinked.receiptFile,
          ensureTemplateFont: async () => {},
        }),
      };
    };

    it.each([
      ['template-deck-training-revision-nine.native-ppt', 9],
      ['template-deck-training-revision-eight.native-ppt', 8],
    ] as const)('links a real user revision after the TOC drops from 8 entries to 6: %s', async (name, pages) => {
      const first = await render(fixture('template-deck-training-first.native-ppt'));
      expect(first.fileCreated).toBe(true);
      expect(first.pages).toBe(8);
      const { linked } = await linkTo(first, fixture(name));
      expect(linked.status).toBe('file-generated');
      expect(linked.fileCreated).toBe(true);
      expect(linked.revision).toBe(1);
      expect(linked.pages).toBe(pages);
      expect(linked.previousOutputSha256).toBe(first.outputSha256);
      expect(readSlideGenerationReceipt(workspace, linked.receiptFile!).previousReceiptFile).toBe(first.receiptFile);
    });

    it('still refuses a linked revision that changes a real fact outside navigation slots', async () => {
      const first = await render(fixture('template-deck-training-first.native-ppt'));
      const changed = fixture('template-deck-training-revision-eight.native-ppt');
      const texts = changed.content['16'] as string[];
      const footer = texts.findIndex((text) => text.includes('v1'));
      expect(footer).toBeGreaterThanOrEqual(0);
      texts[footer] = texts[footer]!.replace('v1', 'v2');
      const { linked } = await linkTo(first, changed);
      expect(linked.fileCreated).toBe(false);
      expect(linked.diagnostics).toEqual([{ code: 'native-revision-data-changed' }]);
    });

    it('still refuses digits smuggled into a TOC item text instead of the ordinal slot', async () => {
      const first = await render(fixture('template-deck-training-first.native-ppt'));
      const changed = fixture('template-deck-training-revision-eight.native-ppt');
      const texts = changed.content['2'] as string[];
      // Even indices from 2 are the section-title slots; only the odd display-ordinal slots are waived.
      texts[12] = `${texts[12]} 07`;
      const { linked } = await linkTo(first, changed);
      expect(linked.fileCreated).toBe(false);
      expect(linked.diagnostics).toEqual([{ code: 'native-revision-data-changed' }]);
    });

    it('keeps refusing changed native chart data in a linked revision', async () => {
      const subset = raw();
      subset.content = { '10': subset.content['10'], '11': subset.content['11'] };
      const first = await render(subset);
      expect(first.fileCreated).toBe(true);
      const changed = raw();
      changed.content = structuredClone(subset.content);
      changed.content['10'].chart.series[0].values[0] += 5;
      const { linked } = await linkTo(first, changed);
      expect(linked.fileCreated).toBe(false);
      expect(linked.diagnostics).toEqual([{ code: 'native-revision-chart-data-changed' }]);
    });
  });

  it('keeps user version links beyond two versions and refuses a stopped managed revision', async () => {
    let parent = await render();
    for (let version = 1; version <= 3; version++) {
      const unlinked = await render({ ...raw(), title: `User edit ${version}` });
      const source = readSlideGenerationReceipt(workspace, unlinked.receiptFile!).sourceFile;
      const linked = await renderNativePptFile(source, workspace, {
        enabled: true,
        templatesRoot,
        previous: parent.receiptFile,
        sourceReceipt: unlinked.receiptFile,
        ensureTemplateFont: async () => {},
      });
      expect(linked.revision).toBe(version);
      expect(linked.previousOutputSha256).toBe(parent.outputSha256);
      parent = linked;
    }
    const unlinked = await render();
    const source = readSlideGenerationReceipt(workspace, unlinked.receiptFile!).sourceFile;
    const stopped = await renderNativePptFile(source, workspace, {
      enabled: true,
      templatesRoot,
      previous: parent.receiptFile,
      sourceReceipt: unlinked.receiptFile,
      isCurrent: () => false,
    });
    expect(stopped.fileCreated).toBe(false);
    expect(stopped.diagnostics).toEqual([{ code: 'native-task-canceled' }]);
  });
});
