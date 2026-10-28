import { describe, expect, it } from 'vitest';
import { DOCGEN_LIMITS, parseDocgenRequest } from '../src/main/docgen/request';

/**
 * Excel（xlsx）请求的**校验**（P2）。
 *
 * 三条规则不是洁癖，是 Excel 自己的脾气 —— 违反了用户打开时会看到
 * 「文件已损坏 / 需要修复」，而那是**我们**生成的文件：
 *
 *  - 表名 ≤31 字、不能含 `[ ] : * ? / \`（Excel 的硬限制）；
 *  - 表名**不能重复**（Excel 会判文件需要修复）；
 *  - 单元只有文本/数字/布尔三种 —— 数字必须**真的是数字**（写成字符串就没法求和，
 *    这是这类"助手给的表"最常见的没用之处）。
 */

const valid = {
  kind: 'xlsx',
  title: '九月台账',
  sheets: [
    {
      name: '汇总',
      rows: [
        ['产品', '数量'],
        ['A', 1200],
        ['B', 830],
      ],
    },
    { name: '备注', rows: [['一句话']] },
  ],
};

function parse(raw: unknown) {
  const result = parseDocgenRequest(raw);
  if (!result.ok) throw new Error(`夹具本该合法：${result.error}`);
  if (result.request.kind !== 'xlsx') throw new Error(`kind 应当是 xlsx，实际是 ${result.request.kind}`);
  return result.request;
}

function errorOf(raw: unknown): string {
  const result = parseDocgenRequest(raw);
  if (result.ok) throw new Error('本该被拒，却通过了');
  return result.error;
}

describe('parseDocgenRequest —— xlsx', () => {
  it('正常请求 ⇒ 逐字保留（文字与数字都在）', () => {
    const request = parse(valid);
    expect(request.title).toBe('九月台账');
    expect(request.sheets).toHaveLength(2);
    expect(request.sheets[0]?.name).toBe('汇总');
    expect(request.sheets[0]?.rows[1]).toEqual(['A', 1200]);
  });

  it('⭐ 数字保持数字、布尔保持布尔（不是全部转成字符串）', () => {
    const request = parse({ ...valid, sheets: [{ name: 'S', rows: [[1, 2.5, true, '文本']] }] });
    expect(request.sheets[0]?.rows[0]).toEqual([1, 2.5, true, '文本']);
  });

  it('空串/纯空白单元与**整行都空**的行被丢掉（模型爱补空行）', () => {
    const request = parse({
      ...valid,
      sheets: [{ name: 'S', rows: [['a', '', '  '], ['', '   ', ''], ['b']] }],
    });
    expect(request.sheets[0]?.rows).toEqual([['a', '', ''], ['b']]);
  });

  it('⭐ `0` 与 `false` 不是"空"（用真值判断会把这些格吃掉）', () => {
    const request = parse({
      ...valid,
      sheets: [
        {
          name: 'S',
          rows: [
            [0, false],
            ['', ''],
          ],
        },
      ],
    });
    expect(request.sheets[0]?.rows).toEqual([[0, false]]);
  });

  it('null 当"留空"（JSON 里表达"这格没有值"的常规写法），不是错误', () => {
    const request = parse({ ...valid, sheets: [{ name: 'S', rows: [['a', null]] }] });
    expect(request.sheets[0]?.rows).toEqual([['a', '']]);
  });

  it('title 与表名缺失/空白 ⇒ 拒', () => {
    expect(parseDocgenRequest({ ...valid, title: '' }).ok).toBe(false);
    expect(parseDocgenRequest({ ...valid, sheets: [{ rows: [['a']] }] }).ok).toBe(false);
    expect(errorOf({ ...valid, sheets: [{ name: '  ', rows: [['a']] }] })).toContain('sheets[0]');
  });

  it('sheets 为空 / 不是数组 / 缺失 ⇒ 拒', () => {
    expect(parseDocgenRequest({ ...valid, sheets: [] }).ok).toBe(false);
    expect(parseDocgenRequest({ ...valid, sheets: 'x' }).ok).toBe(false);
    expect(parseDocgenRequest({ ...valid, sheets: undefined }).ok).toBe(false);
  });

  it('⭐ 表名超 31 字 / 含 Excel 不允许的字符 ⇒ 拒（否则用户打开会看到"需要修复"）', () => {
    const long = 'x'.repeat(DOCGEN_LIMITS.maxSheetNameChars + 1);
    expect(errorOf({ ...valid, sheets: [{ name: long, rows: [['a']] }] })).toContain(
      String(DOCGEN_LIMITS.maxSheetNameChars),
    );
    for (const bad of ['a/b', 'a\\b', 'a?b', 'a*b', 'a[b]', 'a:b']) {
      expect(parseDocgenRequest({ ...valid, sheets: [{ name: bad, rows: [['a']] }] }).ok, bad).toBe(false);
    }
  });

  it('⭐ 表名重复（忽略大小写）⇒ 拒 —— Excel 对同名表判"文件需要修复"', () => {
    const error = errorOf({
      ...valid,
      sheets: [
        { name: '汇总', rows: [['a']] },
        { name: '汇总', rows: [['b']] },
      ],
    });
    expect(error).toContain('汇总');
    expect(
      parseDocgenRequest({
        ...valid,
        sheets: [
          { name: 'Sheet1', rows: [['a']] },
          { name: 'sheet1', rows: [['b']] },
        ],
      }).ok,
    ).toBe(false);
  });

  it('整行不是数组 / 单元是对象 ⇒ 拒，且指认到行列', () => {
    expect(errorOf({ ...valid, sheets: [{ name: 'S', rows: ['x'] }] })).toContain('rows[0]');
    expect(errorOf({ ...valid, sheets: [{ name: 'S', rows: [['ok'], ['ok', { nope: 1 }]] }] })).toContain('rows[1][1]');
  });

  it('数字不是有限数（NaN / Infinity）⇒ 拒', () => {
    expect(parseDocgenRequest({ ...valid, sheets: [{ name: 'S', rows: [[Number.NaN]] }] }).ok).toBe(false);
    expect(parseDocgenRequest({ ...valid, sheets: [{ name: 'S', rows: [[Number.POSITIVE_INFINITY]] }] }).ok).toBe(
      false,
    );
  });

  it('整本一个格都没有 ⇒ 拒（别产出一份空表）', () => {
    const error = errorOf({ ...valid, sheets: [{ name: 'S', rows: [['', '  ']] }] });
    expect(error).toContain('sheets');
  });

  it('行/列/表数超上限 ⇒ 拒（并说明上限）', () => {
    const wide = [Array.from({ length: DOCGEN_LIMITS.maxColumnsPerSheet + 1 }, () => 'x')];
    expect(errorOf({ ...valid, sheets: [{ name: 'S', rows: wide }] })).toContain(
      String(DOCGEN_LIMITS.maxColumnsPerSheet),
    );

    const tall = Array.from({ length: DOCGEN_LIMITS.maxRowsPerSheet + 1 }, () => ['x']);
    expect(errorOf({ ...valid, sheets: [{ name: 'S', rows: tall }] })).toContain(String(DOCGEN_LIMITS.maxRowsPerSheet));

    const sheets = Array.from({ length: DOCGEN_LIMITS.maxSheets + 1 }, (_, i) => ({ name: `S${i}`, rows: [['x']] }));
    expect(errorOf({ ...valid, sheets })).toContain(String(DOCGEN_LIMITS.maxSheets));
  });

  it('单个单元过长 ⇒ 拒（不截断：截断是静默改内容）', () => {
    const long = 'x'.repeat(DOCGEN_LIMITS.maxCellChars + 1);
    expect(parseDocgenRequest({ ...valid, sheets: [{ name: 'S', rows: [[long]] }] }).ok).toBe(false);
  });

  it('⭐ 拿 xlsx 的形状冒充 docx / pptx ⇒ 拒（不许静默产出一份空文件）', () => {
    expect(errorOf({ ...valid, kind: 'docx' })).toContain('sections');
    expect(errorOf({ ...valid, kind: 'pptx' })).toContain('slides');
  });
});
