import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const TASKFLOW_SKILL_AVAILABILITY_PATCH_ID = 'partner-w-taskflow-skill-availability-v1';
const sources = new Map([
  ['taskflow', '38fde5c5f1d8400e340c130105d56c3204ddd826934fae8ca9e137daa1caf7f3'],
  ['taskflow-inbox-triage', 'b1e2be7dff64a06b47fec76c0cc3a4d4d839a07f9c339498f0da63eeee802c6c'],
]);
const guard = `Before using this guide, check the tools actually supplied to the current session. If \`lobster\` is absent, disabled, or disallowed by the agent profile or sandbox, stop before calling it and report the missing capability. Installing a package does not prove the current session can use its tool. Do not retry a known unavailable tool or invent an alternative tool name. Recheck the actual tool list only after capability or configuration changes.\n\n`;

export function patchTaskflowSkillSource(source, expectedHash) {
  if (createHash('sha256').update(source).digest('hex') !== expectedHash)
    throw new Error('Official TaskFlow guide changed; review availability contract before bundling');
  const frontmatter = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  const metadataLine = frontmatter?.[0].match(/^metadata: (.+)$/m);
  if (!frontmatter || !metadataLine) throw new Error('Official TaskFlow metadata anchor changed');
  const metadata = JSON.parse(metadataLine[1]);
  if (!metadata.openclaw || metadata.openclaw.requires)
    throw new Error('Official TaskFlow requirement contract changed');
  metadata.openclaw.requires = { bins: ['node'], config: ['plugins.entries.lobster.enabled'] };
  const head = frontmatter[0].replace(metadataLine[0], `metadata: ${JSON.stringify(metadata)}`);
  return head + '\n' + guard + source.slice(frontmatter[0].length);
}

export function bundleTaskflowSkillAvailability(stageRoot) {
  const patches = [...sources].map(([name, hash]) => {
    const file = path.join(stageRoot, 'node_modules/openclaw/skills', name, 'SKILL.md');
    return [file, patchTaskflowSkillSource(fs.readFileSync(file, 'utf8'), hash)];
  });
  for (const [file, text] of patches) fs.writeFileSync(file, text);
  return TASKFLOW_SKILL_AVAILABILITY_PATCH_ID;
}
