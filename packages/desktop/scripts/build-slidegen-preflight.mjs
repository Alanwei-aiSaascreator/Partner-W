import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export async function buildSlidegenPreflight(
  projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
) {
  const outDir = path.join(projectDir, 'our-skills/deck-layout/scripts');
  await build({
    configFile: false,
    root: projectDir,
    logLevel: 'error',
    ssr: { noExternal: true },
    build: {
      ssr: path.join(projectDir, 'src/main/slidegen/preflight-cli.ts'),
      target: 'node20',
      outDir,
      emptyOutDir: false,
      sourcemap: false,
      minify: false,
      rollupOptions: { output: { format: 'cjs', entryFileNames: 'preflight.cjs' } },
    },
  });
  const command = path.join(outDir, 'preflight.cjs');
  const probe = JSON.parse(
    execFileSync(process.execPath, [command, '--self-test'], {
      cwd: outDir,
      encoding: 'utf8',
      timeout: 10_000,
    }),
  );
  if (
    probe.command !== 'slidegen-source-preflight' ||
    probe.schemaVersion !== 1 ||
    probe.ok !== true ||
    fs.statSync(command).size === 0
  )
    throw new Error('Slidegen source preflight build failed its standalone self-test');
  return command;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildSlidegenPreflight();
