import { nativeImage } from 'electron';
import { readVerifiedArtifactFile } from '../artifact/access.js';
export const IMAGEGEN_MAX_BYTES = 10 * 1024 * 1024;
export function verifyImagegenBuffer(bytes: Buffer, expectedSize?: string): boolean {
  try {
    if (
      bytes.length < 45 ||
      bytes.length > IMAGEGEN_MAX_BYTES ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' ||
      bytes.readUInt32BE(8) !== 13 ||
      bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND'
    )
      return false;
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    const size = `${width}*${height}`;
    if (!['1328*1328', '1664*928', '928*1664'].includes(size) || (expectedSize && size !== expectedSize)) return false;
    const image = nativeImage.createFromBuffer(bytes),
      decoded = image.getSize();
    return !image.isEmpty() && decoded.width === width && decoded.height === height;
  } catch {
    return false;
  }
}
export async function verifyImagegenFile(
  root: string,
  localPath: string,
  expectedSize?: string,
  recordedBytes?: number,
): Promise<boolean> {
  try {
    const bytes = await readVerifiedArtifactFile(root, localPath, { maxBytes: IMAGEGEN_MAX_BYTES });
    return (recordedBytes === undefined || bytes.length === recordedBytes) && verifyImagegenBuffer(bytes, expectedSize);
  } catch {
    return false;
  }
}
