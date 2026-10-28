import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const WINDOWS_DEBUG_SKILLS_PATCH_ID = 'partner-w-windows-debug-skills-v1';
const hashes = {
  'node-inspect-debugger': '50d2f6828eaf4bbf7ccbaec5af928f9af978e93b7c679b0f3c8afe2a80ab7d52',
  'python-debugpy': 'bfb1891204b6726016f527044fa09ac656dd52b12d2b0e86e91c89424170aeb8',
  'node-connect': 'f5cb8259f13bb963f10c920fcc794b4a764b5179e113f602d9cd6ff7bb674c48',
};
const nodeGuide = `
# Node Inspect Debugger (Windows portable runtime)

Use the bundled Node inspector for hidden locals, async hangs, startup races, memory growth and CPU profiles. Confirm the target belongs to this task before attaching.

## Start and inspect

- JavaScript: \`node inspect path/to/script.js\`.
- Pause on entry: \`node --inspect-brk=127.0.0.1:9229 path/to/script.js\`.
- Erasable TypeScript: \`node --inspect-brk=127.0.0.1:9229 path/to/script.ts\`. For compiler transforms, decorators or path aliases, use the project's existing build output; do not assume a separate TS loader is installed.
- On Windows, launch the owned process with an inspector flag. Do not send Unix signals to enable an existing process.
- OpenClaw CLI: \`node --inspect-brk=127.0.0.1:9229 "{baseDir}/../../openclaw.mjs" <command>\`. Preserve this runtime's state/config environment.

## Scripted diagnostics (no package installation)

\`node "{baseDir}/scripts/inspector.mjs" list http://127.0.0.1:9229\`

\`node "{baseDir}/scripts/inspector.mjs" evaluate http://127.0.0.1:9229 "process.pid"\`

The script uses bundled Node fetch and WebSocket. Only loopback targets are accepted. When multiple targets exist, pass the exact target ID as the final evaluate argument. Do not evaluate credentials or private data. Evaluation exceptions and connection failures are failures, not completed diagnostics.

## Interactive debugging

- Continue/step: \`cont\`, \`next\`, \`step\`, \`out\`, \`pause\`.
- Breakpoints: \`sb('file.js', 42)\`, \`sb(42)\`, \`breakpoints\`, \`cb('file.js', 42)\`.
- Inspect: \`bt\`, \`list(8)\`, \`watch('expr')\`, \`exec expr\`.
- Current scope: \`repl\`; Ctrl+C leaves REPL mode.
- Before detaching, continue the owned process if it should keep running.
- Use Chrome DevTools inspector panels for CPU and heap profiles; keep the bind on 127.0.0.1 and verify the selected process.
- For child processes, use distinct inspector ports. For missing breakpoints, verify the emitted file/source map and whether execution already passed the line.
`;
function replaceOnce(source, anchor, replacement) {
  if (source.split(anchor).length !== 2) throw new Error('Windows skill anchor drift');
  return source.replace(anchor, replacement);
}
export function patchWindowsDebugSkill(name, source, expectedHash = hashes[name]) {
  if (!expectedHash || createHash('sha256').update(source).digest('hex') !== expectedHash)
    throw new Error(`Windows skill source hash drift: ${name}`);
  if (name === 'node-inspect-debugger') {
    const end = source.indexOf('\n---\n', 4);
    if (!source.startsWith('---\n') || end < 0) throw new Error('Windows skill frontmatter drift');
    return source.slice(0, end + 5) + nodeGuide;
  }
  if (name === 'python-debugpy')
    return replaceOnce(
      source,
      'python3 -c "import debugpy" || python3 -m pip install debugpy',
      'python3 -c "import debugpy; print(debugpy.__version__)"\n# debugpy is bundled. If this probe fails, stop and repair this runtime before proceeding.',
    ).replaceAll('```bash', '```text');
  if (name === 'node-connect')
    return replaceOnce(
      source,
      "openclaw qr --json | jq '{gatewayUrl, gatewayUrls, auth, access, accessDowngraded, urlSource}'",
      'node "{baseDir}/scripts/qr-summary.mjs"',
    )
      .replace('add `--remote` before `--json`', 'pass `--remote` to the summary script')
      .replace(
        'Verify `gatewayUrl` and `urlSource`.',
        'Verify the redacted gateway origin and available source metadata. The script omits credential/query/path contents; inspect exact routes outside agent-visible output.',
      );
  throw new Error(`Unsupported Windows skill: ${name}`);
}
export function bundleWindowsDebugSkills(stage) {
  const skills = path.join(stage, 'node_modules/openclaw/skills');
  // Review all original documents before changing any of them.
  const patched = Object.fromEntries(
    Object.keys(hashes).map((name) => [
      name,
      patchWindowsDebugSkill(name, fs.readFileSync(path.join(skills, name, 'SKILL.md'), 'utf8')),
    ]),
  );
  for (const [name, content] of Object.entries(patched)) fs.writeFileSync(path.join(skills, name, 'SKILL.md'), content);
  for (const [skill, source, destination] of [
    ['node-inspect-debugger', 'node-inspector-cli.mjs', 'inspector.mjs'],
    ['node-connect', 'qr-summary-cli.mjs', 'qr-summary.mjs'],
  ]) {
    const directory = path.join(skills, skill, 'scripts');
    fs.mkdirSync(directory, { recursive: true });
    fs.copyFileSync(fileURLToPath(new URL(source, import.meta.url)), path.join(directory, destination));
  }
  return WINDOWS_DEBUG_SKILLS_PATCH_ID;
}
