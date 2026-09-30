import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOWS_VIDEO_FRAMES_PATCH_ID = 'rongying-windows-video-frames-v1';
export const VIDEO_FRAMES_SKILL_SHA256 = 'bdaaa9964db9584f6598e53fd025fad28d84a1e15859599f95180839fad05478';
export function patchWindowsVideoFramesSkill(source, expectedHash = VIDEO_FRAMES_SKILL_SHA256) {
  if (createHash('sha256').update(source).digest('hex') !== expectedHash)
    throw new Error('video-frames skill source hash drift');
  // The upstream document has requires and brew-install bins; only requires gains Node.
  if (source.split('"bins": ["ffmpeg"]').length !== 3 || !source.includes('{baseDir}/scripts/frame.sh'))
    throw new Error('video-frames skill anchor drift');
  return source
    .replace('"bins": ["ffmpeg"]', '"bins": ["node", "ffmpeg"]')
    .replaceAll('{baseDir}/scripts/frame.sh', 'node "{baseDir}/scripts/frame.mjs"')
    .replaceAll('```bash', '```text');
}
export function bundleWindowsVideoFrames(stage) {
  const skill = path.join(stage, 'node_modules/openclaw/skills/video-frames');
  const file = path.join(skill, 'SKILL.md');
  const patched = patchWindowsVideoFramesSkill(fs.readFileSync(file, 'utf8'));
  fs.copyFileSync(
    fileURLToPath(new URL('./video-frame-cli.mjs', import.meta.url)),
    path.join(skill, 'scripts/frame.mjs'),
  );
  fs.writeFileSync(file, patched);
  return WINDOWS_VIDEO_FRAMES_PATCH_ID;
}
