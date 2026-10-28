import { open, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, extname } from 'node:path';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export interface VideogenFirstFrameData {
  mimeType: 'image/png' | 'image/jpeg';
  content: string;
}
export async function readVideogenFirstFrame(input: {
  workspacePath: string;
  path: string;
  authorizedAttachmentPaths?: readonly string[];
}): Promise<VideogenFirstFrameData> {
  if (
    !input.path ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(input.path) ||
    input.path.startsWith('data:') ||
    input.path.startsWith('\\\\')
  )
    throw new Error('videogen-reference-invalid');
  const root = await realpath(input.workspacePath);
  const requested = resolve(root, input.path);
  const actual = await realpath(requested);
  const rel = relative(root, actual);
  const inside = rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
  const authorized = await Promise.all(
    (input.authorizedAttachmentPaths ?? []).map(async (path) => {
      try {
        return await realpath(path);
      } catch {
        return null;
      }
    }),
  );
  if (!inside && !authorized.includes(actual)) throw new Error('videogen-reference-not-authorized');
  const handle = await open(actual, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 24 || info.size > MAX_IMAGE_BYTES) throw new Error('videogen-reference-invalid');
    const current = await stat(actual);
    if (current.dev !== info.dev || current.ino !== info.ino) throw new Error('videogen-reference-changed');
    const bytes = Buffer.alloc(info.size);
    let read = 0;
    while (read < bytes.length) {
      const part = await handle.read(bytes, read, bytes.length - read, read);
      if (!part.bytesRead) break;
      read += part.bytesRead;
    }
    if (read !== bytes.length || (await handle.stat()).size !== info.size)
      throw new Error('videogen-reference-changed');
    const extension = extname(actual).toLowerCase();
    const png =
      extension === '.png' &&
      bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
      bytes.toString('ascii', 12, 16) === 'IHDR' &&
      bytes.readUInt32BE(16) > 0 &&
      bytes.readUInt32BE(20) > 0 &&
      bytes.subarray(-8, -4).toString('ascii') === 'IEND';
    const jpeg =
      ['.jpg', '.jpeg'].includes(extension) &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255 &&
      bytes[bytes.length - 2] === 255 &&
      bytes[bytes.length - 1] === 217;
    if (!png && !jpeg) throw new Error('videogen-reference-invalid');
    return { mimeType: png ? 'image/png' : 'image/jpeg', content: bytes.toString('base64') };
  } finally {
    await handle.close();
  }
}
