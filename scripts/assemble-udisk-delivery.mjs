#!/usr/bin/env node

import fs from 'node:fs';
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPortableFileManifest } from './lib/portable-update-release.mjs';
import { APP_DIR_NAME, auditDelivery, LAUNCHER_EXE_NAME, README_NAME } from './lib/udisk-delivery.mjs';

const scriptsRoot = dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
  const names = ['app-dir', 'launcher', 'out'];
  const values = {};
  for (const name of names) {
    const index = argv.indexOf(`--${name}`);
    if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new Error(`--${name} is required`);
    }
    values[name] = resolve(argv[index + 1]);
  }
  return { appDir: values['app-dir'], launcher: values.launcher, outDir: values.out };
}

function walkNames(root) {
  const names = [];
  const walk = (directory, prefix) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      names.push(relative);
      if (entry.isDirectory() && !entry.isSymbolicLink()) walk(join(directory, entry.name), relative);
    }
  };
  walk(root, '');
  return names;
}

async function auditOutput(outDir) {
  const io = {
    exists: (target) => fs.existsSync(target),
    listNames: (target) => fs.readdirSync(target),
    walkNames,
    readFile: (target) => {
      try {
        return fs.readFileSync(target);
      } catch {
        return null;
      }
    },
  };
  const findings = auditDelivery(io, outDir);
  if (findings.length > 0) {
    throw new Error(`assembled delivery failed its audit: ${findings.map((entry) => entry.id).join(', ')}`);
  }
}

async function main() {
  const input = parseArguments(process.argv.slice(2));
  const launcherInfo = await lstat(input.launcher).catch(() => null);
  if (launcherInfo === null || !launcherInfo.isFile() || launcherInfo.isSymbolicLink()) {
    throw new Error('launcher must be a regular file');
  }
  const launcherHeader = await readFile(input.launcher);
  if (launcherHeader.length < 2 || launcherHeader.subarray(0, 2).toString('ascii') !== 'MZ') {
    throw new Error('launcher is not a Windows PE image');
  }
  await buildPortableFileManifest({ programDir: input.appDir, version: '0.0.0' });
  await mkdir(input.outDir, { recursive: true });
  if ((await readdir(input.outDir)).length > 0) {
    throw new Error('refusing to assemble into a non-empty output directory');
  }

  const programTarget = join(input.outDir, APP_DIR_NAME);
  const launcherTarget = join(input.outDir, LAUNCHER_EXE_NAME);
  const readmeTarget = join(input.outDir, README_NAME);
  try {
    await cp(input.appDir, programTarget, { recursive: true, force: false, errorOnExist: true });
    await cp(input.launcher, launcherTarget, { force: false, errorOnExist: true });
    const instructions = await readFile(join(scriptsRoot, 'templates', 'udisk-readme.txt'));
    await writeFile(readmeTarget, instructions, { flag: 'wx' });
    await auditOutput(input.outDir);
  } catch (error) {
    await Promise.all([
      rm(programTarget, { recursive: true, force: true }),
      rm(launcherTarget, { force: true }),
      rm(readmeTarget, { force: true }),
    ]);
    throw error;
  }
  console.log(`Portable delivery assembled at ${input.outDir}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
