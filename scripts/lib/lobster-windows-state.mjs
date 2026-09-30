import { createHash } from 'node:crypto';

export const LOBSTER_WINDOWS_STATE_PATCH_ID = 'rongying-lobster-windows-state-v1';
// Official @openclaw/lobster@2026.9.3 tarball's bundled @clawdbot/lobster@2026.6.11.
export const LOBSTER_STATE_SOURCE_SHA256 = 'e164b27a83caab52eb1fa0a73f60b5c7575cb5549a55ac238a82a0628d71836c';

export function patchLobsterWindowsStateSource(source, expectedHash = LOBSTER_STATE_SOURCE_SHA256) {
  if (createHash('sha256').update(source).digest('hex') !== expectedHash)
    throw new Error('Official Lobster state source changed; review compatibility before bundling');
  const anchor = '    const final = path.resolve(finalDir);\n    let current = path.resolve(firstCreated);';
  if (source.split(anchor).length !== 2) throw new Error('Official Lobster directory sync anchor changed');
  // fs.mkdir(recursive) can return \\?\C:\... while finalDir uses C:\... .
  // Normalize both roots before path.relative, retaining each durable directory sync.
  return source.replace(
    anchor,
    '    const final = path.toNamespacedPath(path.resolve(finalDir));\n    let current = path.toNamespacedPath(path.resolve(firstCreated));',
  );
}
