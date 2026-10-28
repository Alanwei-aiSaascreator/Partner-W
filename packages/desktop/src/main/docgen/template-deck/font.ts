import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const family = '\u601d\u6e90\u9ed1\u4f53';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function fontMetadata(bytes: Buffer): { families: string[]; variable: boolean } {
  try {
    if (bytes.length < 12) throw Error();
    const signature = bytes.subarray(0, 4).toString('hex');
    if (!['4f54544f', '00010000', '74746366'].includes(signature)) throw Error();
    const bases =
      signature === '74746366'
        ? Array.from({ length: Math.min(bytes.readUInt32BE(8), 100) }, (_, i) => bytes.readUInt32BE(12 + 4 * i))
        : [0];
    const families = new Set<string>();
    let variable = false;
    for (const base of bases) {
      const count = bytes.readUInt16BE(base + 4);
      if (count > 1000 || base + 12 + 16 * count > bytes.length) throw Error();
      for (let i = 0; i < count; i++) {
        const entry = base + 12 + 16 * i;
        const tag = bytes.subarray(entry, entry + 4).toString('ascii');
        if (tag === 'fvar') variable = true;
        if (tag !== 'name') continue;
        const offset = bytes.readUInt32BE(entry + 8);
        const length = bytes.readUInt32BE(entry + 12);
        if (offset + length > bytes.length || length < 6) throw Error();
        const names = bytes.readUInt16BE(offset + 2);
        const strings = offset + bytes.readUInt16BE(offset + 4);
        if (offset + 6 + names * 12 > offset + length) throw Error();
        for (let j = 0; j < names; j++) {
          const record = offset + 6 + j * 12;
          const platform = bytes.readUInt16BE(record);
          const id = bytes.readUInt16BE(record + 6);
          if (![1, 16].includes(id) || ![0, 3].includes(platform)) continue;
          const size = bytes.readUInt16BE(record + 8);
          const start = strings + bytes.readUInt16BE(record + 10);
          if (size % 2 || start + size > offset + length) throw Error();
          const name = Buffer.from(bytes.subarray(start, start + size))
            .swap16()
            .toString('utf16le')
            .trim();
          if (name) families.add(name);
        }
      }
    }
    if (!families.size) throw Error();
    return { families: [...families], variable };
  } catch {
    throw new Error('template-font-invalid');
  }
}
export function validateBundledFont(bytes: Buffer): void {
  const metadata = fontMetadata(bytes);
  if (metadata.variable) throw new Error('template-font-variable');
  if (!metadata.families.includes(family)) throw new Error('template-font-family');
}

export async function ensureTemplateDeckFont(fontsRoot: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('template-font-install-unsupported');
  const manifest = JSON.parse(fs.readFileSync(path.join(fontsRoot, 'manifest.json'), 'utf8')) as {
    files: Array<{ file: string; bytes: number; sha256: string }>;
  };
  const wanted = ['SourceHanSansSC-Regular.otf', 'SourceHanSansSC-Bold.otf'];
  const files = wanted.map((file) => {
    const item = manifest.files.find((value) => value.file === file);
    if (!item) throw new Error('template-font-manifest-invalid');
    const source = path.join(fontsRoot, file);
    const bytes = fs.readFileSync(source);
    if (bytes.length !== item.bytes || sha(bytes) !== item.sha256) throw new Error('template-font-hash-mismatch');
    validateBundledFont(bytes);
    return { source, file: `ROYIN-${file}`, sha256: item.sha256 };
  });
  const installEnv: NodeJS.ProcessEnv = { ...process.env, ROYIN_FONT_INSTALL_JSON: JSON.stringify(files) };
  delete installEnv.PSModulePath;
  const executeInstaller = (verifyOnly: boolean) =>
    run(
      path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(fontsRoot, 'install-fonts.ps1'),
        ...(verifyOnly ? ['-VerifyOnly'] : []),
      ],
      { windowsHide: true, timeout: 30000, maxBuffer: 8192, env: installEnv },
    );
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData || !path.isAbsolute(localAppData)) throw new Error('template-font-user-profile-unavailable');
  const userFonts = path.join(localAppData, 'Microsoft', 'Windows', 'Fonts');
  const installed = () =>
    files.every((file) => {
      try {
        const bytes = fs.readFileSync(path.join(userFonts, file.file));
        return sha(bytes) === file.sha256 && fontMetadata(bytes).families.includes(family);
      } catch {
        return false;
      }
    });
  let ready = installed();
  if (ready) {
    try {
      await executeInstaller(true);
    } catch {
      ready = false;
    }
  }
  if (!ready) {
    try {
      await executeInstaller(false);
      await executeInstaller(true);
    } catch (cause) {
      throw new Error('template-font-install-failed', { cause });
    }
  }
  if (!installed()) throw new Error('template-font-unavailable');
}
