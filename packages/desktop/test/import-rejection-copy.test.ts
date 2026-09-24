import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ImportFileRejectionReason } from '@clawwork/shared';
import {
  describeImportRejections,
  IMPORT_REJECTION_KEYS,
  IMPORT_REJECTION_MORE_KEY,
} from '../src/renderer/lib/import-rejection-copy';

/**
 * 「有 N 个文件未能添加」必须说清**是哪个文件、为什么**。
 *
 * ## 为什么单独钉这一条
 *
 * 2026-09-24 同事的真机表格：**「添加文件或内容添加不上 → 无法操作」**，
 * 截图里只有一句 `⚠ 有 1 个文件未能添加`。
 *
 * 而数据里本来就带着答案 —— `ImportFilesResult.rejected` 是
 * `Array<{ fileName, reason }>`（`@clawwork/shared`），reason 有五种
 * （unsupported / too-large / unavailable / copy-failed / publish-unavailable）。
 * 界面（`useTaskMaterials.ts`）只用了 `length`，**把文件名和原因一起丢了**：
 * 用户既不知道该改什么，也无法判断"是这个文件不行还是整个功能不行"——
 * 他的结论只能是"无法操作"。
 *
 * ⚠️ 桩**刻意不用恒等函数**：恒等的话"到底有没有把 fileName 传进 t"看不见。
 *    这里把它包成 `key<文件名>`，少传一次参数就会当场变红。
 */
const t = (key: string, options?: Record<string, unknown>): string =>
  options?.fileName ? `${key}<${options.fileName}>` : key;

const ALL_REASONS: ImportFileRejectionReason[] = [
  'unsupported',
  'too-large',
  'unavailable',
  'copy-failed',
  'publish-unavailable',
];

function reject(fileName: string, reason: ImportFileRejectionReason) {
  return { fileName, reason };
}

describe('describeImportRejections', () => {
  it('空列表 ⇒ 空串（没问题就不要造一句出来）', () => {
    expect(describeImportRejections([], t)).toBe('');
  });

  it('说清**是哪个文件**（这正是这次要修的东西）', () => {
    const out = describeImportRejections([reject('五家户外店主营品类统计.xlsx', 'too-large')], t);
    expect(out).toContain('五家户外店主营品类统计.xlsx');
  });

  it('五种原因各说各的话 —— 压成一句就退化成"没能添加"', () => {
    const copies = ALL_REASONS.map((reason) => describeImportRejections([reject('a.txt', reason)], t));
    expect(new Set(copies).size, '五种原因的文案必须两两不同').toBe(ALL_REASONS.length);
  });

  it('每种原因的 key 都挂在 chatInput.importRejected 下（前缀写错 = i18n 提取不到）', () => {
    for (const reason of ALL_REASONS) {
      expect(IMPORT_REJECTION_KEYS[reason]).toMatch(/^chatInput\.importRejected\.[a-zA-Z]+$/);
    }
  });

  it('多个文件用 `; ` 分隔（与本文件既有的多段 description 一致）', () => {
    const out = describeImportRejections([reject('a.wps', 'unsupported'), reject('b.zip', 'unsupported')], t);
    expect(out).toContain('a.wps');
    expect(out).toContain('b.zip');
    expect(out).toContain('; ');
  });

  it('太多文件时只列前几个，剩下的报个数（不能让 toast 长到看不见）', () => {
    const many = Array.from({ length: 5 }, (_, i) => reject(`f${i}.wps`, 'unsupported'));
    const out = describeImportRejections(many, t);

    expect(out, '前三个在').toContain('f0.wps');
    expect(out).toContain('f2.wps');
    expect(out, '第四个不列').not.toContain('f3.wps');
    expect(out, '但要说还有几个').toContain(IMPORT_REJECTION_MORE_KEY);
  });

  it('刚好等于上限时**不**多说一句"还有 0 个"', () => {
    const exact = Array.from({ length: 3 }, (_, i) => reject(`f${i}.wps`, 'unsupported'));
    expect(describeImportRejections(exact, t)).not.toContain(IMPORT_REJECTION_MORE_KEY);
  });
});

/**
 * ⚠️ 这张表是"可能返回哪些 key"的**唯一定义**，但 key 是**当作变量**传给 `t` 的 ——
 *    `scripts/check-i18n.mjs` 的提取正则要求引号**紧跟** `t(`，所以它**结构上看不见**这些
 *    key（这个盲区在 2026-09-24 的层 2 上实测过：九份 desktop 有、九份 pwa 全没有，RC 照样 0）。
 *    因此必须在这里按名钉住。
 */
describe('这些 key 在九份语言里都齐备', () => {
  it('表本身非空（空表会让下面的循环全绿）', () => {
    expect(Object.keys(IMPORT_REJECTION_KEYS).length).toBe(ALL_REASONS.length);
  });

  it.each(['zh', 'zh-TW', 'en', 'de', 'es', 'fr', 'ja', 'ko', 'pt'])('%s.json 带全部 key', (locale) => {
    const dir = fileURLToPath(new URL('../src/renderer/i18n/locales/', import.meta.url));
    const files = readdirSync(dir).filter((file) => file.endsWith('.json'));
    expect(files.length, '九份语言').toBe(9);

    const json = JSON.parse(readFileSync(`${dir}/${locale}.json`, 'utf8')) as {
      chatInput?: { importRejected?: Record<string, string> };
    };
    // ⚠️ **嵌套**读（这个仓库的语言文件是嵌套的，`activation.*` 就是）。
    //    写成扁平 `chatInput[leaf]` 会永远读不到 —— 那种断言绑的是错的位置，
    //    却会因为"读不到就 falsy"而看起来像"key 缺失"。
    const block = json.chatInput?.importRejected ?? {};
    const keys = [...Object.values(IMPORT_REJECTION_KEYS), IMPORT_REJECTION_MORE_KEY];
    for (const key of keys) {
      const leaf = key.split('.').pop() ?? '';
      expect(block[leaf], `${locale}.json 缺 ${key}`).toBeTruthy();
    }
    // ⚠️ 只绑"在不在"不够：把五句贴成同一句（复制粘贴事故）时上面照样全绿。
    const texts = Object.values(IMPORT_REJECTION_KEYS).map((k) => block[k.split('.').pop() ?? '']);
    expect(new Set(texts).size, `${locale}.json 的五句文案必须两两不同`).toBe(ALL_REASONS.length);
  });
});
