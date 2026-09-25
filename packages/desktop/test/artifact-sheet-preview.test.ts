/**
 * 表格预览（`.xlsx`）：把工作簿读成能直接渲染的行列。
 *
 * 为什么要有它：**我们自己就能生成 `.xlsx`**（P2 的 docgen），而 `FilePreview` 只认
 * 图片 / Markdown / 代码 ⇒ 用户在应用里**看不见自己刚做出来的表**，只能导出去用 Excel 开。
 *
 * ⭐ 夹具是**现场生成**的（用同一个 exceljs 写一份真 `.xlsx` 再读回来），
 * 不是塞一个二进制样本进仓库 —— 那样既看不出内容、也会随库升级悄悄失效。
 */
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { readSheetPreview } from '../src/main/preview/sheet-preview.js';

async function makeWorkbook(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet('内测模块状态');
  sheet.addRow(['模块', '状态', '完成度']);
  sheet.addRow(['登录', '已完成', 100]);
  sheet.addRow(['文档生成', '进行中', 60]);
  const second = wb.addWorksheet('备注');
  second.addRow(['说明']);
  second.addRow(['这一页只有一列']);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('readSheetPreview', () => {
  it('读出每一页的名字与行列，值按单元格原样给', async () => {
    const preview = await readSheetPreview(await makeWorkbook());

    expect(preview.sheets.map((s) => s.name)).toEqual(['内测模块状态', '备注']);
    expect(preview.sheets[0].rows[0]).toEqual(['模块', '状态', '完成度']);
    expect(preview.sheets[0].rows[1]).toEqual(['登录', '已完成', '100']);
    expect(preview.truncated).toBe(false);
  });

  it('⭐ 数字与文字都变成可渲染的字符串（不是丢类型就是丢值）', async () => {
    const preview = await readSheetPreview(await makeWorkbook());

    for (const sheet of preview.sheets) {
      for (const row of sheet.rows) {
        for (const cell of row) expect(typeof cell).toBe('string');
      }
    }
    // 数字 100 不许变成空串，也不许带成一整串浮点尾巴
    expect(preview.sheets[0].rows[1][2]).toBe('100');
  });

  it('⭐ 日期给 ISO 而不是 NaN/序列号（exceljs 的日期是 Date 对象）', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('日期');
    sheet.addRow(['日期']);
    sheet.addRow([new Date('2026-09-26T00:00:00.000Z')]);
    const preview = await readSheetPreview(Buffer.from(await wb.xlsx.writeBuffer()));

    expect(preview.sheets[0].rows[1][0]).toBe('2026-09-26T00:00:00.000Z');
  });

  it('⭐ 公式单元格给**算好的结果**（给公式本身等于给用户看 `=SUM(A1:A9)`）', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('公式');
    sheet.addRow([1]);
    sheet.addRow([2]);
    sheet.addRow([{ formula: 'SUM(A1:A2)', result: 3 }]);
    const preview = await readSheetPreview(Buffer.from(await wb.xlsx.writeBuffer()));

    expect(preview.sheets[0].rows[2][0]).toBe('3');
  });

  it('⭐ 富文本要拼成人读的一段（richText 是数组，直接 String() 会变 [object Object]）', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('富文本');
    sheet.addRow([{ richText: [{ text: '前面' }, { text: '后面', font: { bold: true } }] }]);
    const preview = await readSheetPreview(Buffer.from(await wb.xlsx.writeBuffer()));

    expect(preview.sheets[0].rows[0][0]).toBe('前面后面');
  });

  it('⭐ 大表要**截断并说出来**（几十万行直接塞给界面会卡死）', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('大表');
    for (let i = 0; i < 400; i += 1) sheet.addRow([`行 ${i}`]);
    const preview = await readSheetPreview(Buffer.from(await wb.xlsx.writeBuffer()), { maxRows: 50 });

    expect(preview.sheets[0].rows).toHaveLength(50);
    expect(preview.truncated).toBe(true);
  });

  it('⭐ 控件字符要洗掉（表格里可能带着换行/制表/不可见字符）', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('脏');
    sheet.addRow(['第一行\n第二行', '带\t制表']);
    const preview = await readSheetPreview(Buffer.from(await wb.xlsx.writeBuffer()));

    expect(preview.sheets[0].rows[0][0]).toBe('第一行 第二行');
    expect(preview.sheets[0].rows[0][1]).toBe('带 制表');
  });

  it('对照：不是 xlsx 的字节 ⇒ 明确报错，不是崩', async () => {
    await expect(readSheetPreview(Buffer.from('这不是一个表格'))).rejects.toThrow();
  });

  it('对照：空文件同样明确报错', async () => {
    await expect(readSheetPreview(Buffer.alloc(0))).rejects.toThrow();
  });
});
