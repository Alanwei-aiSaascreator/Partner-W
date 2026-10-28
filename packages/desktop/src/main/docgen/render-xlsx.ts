import ExcelJS from 'exceljs';
import type { DocgenXlsxRequest } from './request.js';

/**
 * 把校验过的请求渲染成 xlsx 字节（Excel / WPS 表格都能开）。
 *
 * ## 一条刻意的克制：**不做样式**
 *
 * 不加底色、不加粗表头、不冻结首行。理由与 P1 对 PPT 的取舍一样：
 * 版式是 P3 的事，现在多做一种就多一份没人验过的代码；而且**猜错的样式比没有样式更烦人**
 * （助手给的表常常不是"第一行就是表头"，自动加粗会把用户的内容标错）。
 *
 * 真正在意的是**单元类型**：文字就是文字、数字就是数字、布尔就是布尔 ——
 * 全转成字符串在界面上看不出差别，但用户没法求和、没法排序
 * （`test/docgen-render-xlsx.test.ts` 里有一条专门钉这个）。
 */

export async function renderXlsx(request: DocgenXlsxRequest): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Partner-W';

  for (const sheet of request.sheets) {
    const worksheet = workbook.addWorksheet(sheet.name);
    for (const row of sheet.rows) {
      // ⚠️ 展开成新数组：exceljs 会把传进去的数组当自己的行数据留着，
      //    而我们这份 request 是调用方的对象（别让库去改它）。
      worksheet.addRow([...row]);
    }
  }

  // `writeBuffer()` 在 Node 下给的是 Buffer（类型标成 Buffer，运行期也是），
  // 但浏览器构建给的是 ArrayBuffer ⇒ 统一过一道 `Buffer.from`，两边都对。
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer as ArrayBuffer);
}
