import { describe, expect, it } from 'vitest';
import { fontMetadata, validateBundledFont } from '../src/main/docgen/template-deck/font';

function sfnt(family: string, variable = false): Buffer {
  const name = Buffer.from(family, 'utf16le').swap16();
  const count = variable ? 2 : 1;
  const offset = 12 + count * 16;
  const bytes = Buffer.alloc(offset + 18 + name.length);
  bytes.write('OTTO');
  bytes.writeUInt16BE(count, 4);
  bytes.write('name', 12);
  bytes.writeUInt32BE(offset, 20);
  bytes.writeUInt32BE(18 + name.length, 24);
  if (variable) bytes.write('fvar', 28);
  bytes.writeUInt16BE(1, offset + 2);
  bytes.writeUInt16BE(18, offset + 4);
  [3, 1, 0x804, 1, name.length, 0].forEach((value, i) => bytes.writeUInt16BE(value, offset + 6 + 2 * i));
  name.copy(bytes, offset + 18);
  return bytes;
}

describe('templateDeck static font supply', () => {
  it('reads localized family names from font bytes', () => {
    expect(fontMetadata(sfnt('\u601d\u6e90\u9ed1\u4f53')).families).toContain('\u601d\u6e90\u9ed1\u4f53');
  });
  it('rejects variable fonts and unapproved families', () => {
    expect(() => validateBundledFont(sfnt('\u601d\u6e90\u9ed1\u4f53', true))).toThrow('template-font-variable');
    expect(() => validateBundledFont(sfnt('Microsoft YaHei'))).toThrow('template-font-family');
  });
  it('rejects truncated or invalid font tables', () => {
    expect(() => fontMetadata(Buffer.from('OTTO'))).toThrow('template-font-invalid');
    const corrupt = sfnt('Source Han Sans SC');
    corrupt.writeUInt32BE(999999, 20);
    expect(() => fontMetadata(corrupt)).toThrow('template-font-invalid');
  });
});
