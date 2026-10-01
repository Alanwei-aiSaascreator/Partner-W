import { NATIVE_TOOL_SOURCES } from '../../../scripts/lib/native-tool-runtime.mjs';
import { officialLobsterPluginSpec } from '../../../scripts/lib/bundled-lobster-runtime.mjs';
import { LOBSTER_WINDOWS_STATE_PATCH_ID } from '../../../scripts/lib/lobster-windows-state.mjs';
import { TASKFLOW_SKILL_AVAILABILITY_PATCH_ID } from '../../../scripts/lib/taskflow-skill-availability.mjs';
import { WINDOWS_VIDEO_FRAMES_PATCH_ID } from '../../../scripts/lib/windows-video-frames-runtime.mjs';
import { WINDOWS_DEBUG_SKILLS_PATCH_ID } from '../../../scripts/lib/windows-debug-skills.mjs';
export function requiredRuntimePatches(version) {
  officialLobsterPluginSpec(version);
  return [
    `rongying-native-tools-${NATIVE_TOOL_SOURCES.map((source) => `${source.name}-${source.version}`).join('-')}`,
    `official-lobster-${version}`,
    LOBSTER_WINDOWS_STATE_PATCH_ID,
    TASKFLOW_SKILL_AVAILABILITY_PATCH_ID,
    WINDOWS_VIDEO_FRAMES_PATCH_ID,
    WINDOWS_DEBUG_SKILLS_PATCH_ID,
  ];
}
/** Supply markers are required packaging inputs, not model/session authorization. */
export function verifyRuntimeSupply(manifest) {
  const variants = manifest.runtimes.filter((variant) => variant.platform === 'win32' && variant.arch === 'x64');
  if (variants.length === 0) throw Error('Bundled runtime must contain a Windows x64 variant');
  for (const variant of variants) {
    for (const patch of requiredRuntimePatches(variant.version)) {
      if (!Array.isArray(variant.patches) || !variant.patches.includes(patch))
        throw Error(`Missing required runtime patch: ${patch}`);
    }
  }
}
