import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { InstallResult } from './bundled.js';
import { contained, readWorkspaceBytes } from '../slidegen/source-file.js';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function checkSlidegenLauncherOwnership(root: string | undefined, managedDir: string): InstallResult {
  try {
    if (!root) throw new Error('missing bundle');
    const managed = fs.realpathSync(managedDir);
    const skill = path.join(managed, 'deck-layout');
    if (fs.realpathSync(skill) !== skill) throw new Error('outside skill');
    const scripts = path.join(skill, 'scripts');
    if (fs.existsSync(scripts) && fs.realpathSync(scripts) !== scripts) throw new Error('outside scripts');
    if (!fs.lstatSync(path.join(scripts, 'generate.cjs'), { throwIfNoEntry: false })) return { ok: true };
    const installed = hash(readWorkspaceBytes(managed, 'deck-layout/scripts/generate.cjs', 64 * 1024));
    if (installed === hash(readWorkspaceBytes(root, 'deck-layout/scripts/generate.cjs', 64 * 1024)))
      return { ok: true };
    try {
      const recorded = JSON.parse(
        readWorkspaceBytes(managed, 'deck-layout/scripts/generate-runtime.json', 64 * 1024).toString('utf8'),
      );
      if (recorded?.schemaVersion === 1 && recorded.launcherSha256 === installed) return { ok: true };
    } catch {
      return { ok: false, error: 'slidegen-runtime-script-modified' };
    }
    return { ok: false, error: 'slidegen-runtime-script-modified' };
  } catch {
    return { ok: false, error: 'slidegen-runtime-unavailable' };
  }
}

export function configureSlidegenRuntime(input: {
  root: string | undefined;
  managedDir: string;
  isPackaged: boolean;
  executable: string;
  appPath: string;
}): InstallResult {
  let temporary: { path: string; identity: fs.Stats; root: string } | undefined;
  try {
    if (
      !input.root ||
      !path.isAbsolute(input.executable) ||
      !fs.statSync(input.executable).isFile() ||
      (!input.isPackaged && (!path.isAbsolute(input.appPath) || !fs.statSync(input.appPath).isDirectory()))
    )
      throw new Error('unavailable program');
    const managed = fs.realpathSync(input.managedDir);
    const scripts = path.join(managed, 'deck-layout/scripts');
    if (fs.realpathSync(scripts) !== scripts || !contained(managed, scripts)) throw new Error('outside scripts');
    const source = readWorkspaceBytes(input.root, 'deck-layout/scripts/generate.cjs', 64 * 1024);
    const installed = readWorkspaceBytes(managed, 'deck-layout/scripts/generate.cjs', 64 * 1024);
    if (hash(source) !== hash(installed)) return { ok: false, error: 'slidegen-runtime-script-modified' };
    const target = path.join(scripts, 'generate-runtime.json');
    const staging = path.join(scripts, `.generate-runtime-${randomUUID()}.json`);
    const fd = fs.openSync(staging, 'wx');
    try {
      temporary = { path: staging, identity: fs.fstatSync(fd), root: managed };
      fs.writeFileSync(
        fd,
        JSON.stringify({
          schemaVersion: 1,
          executable: input.executable,
          args: input.isPackaged ? [] : [input.appPath],
          launcherSha256: hash(installed),
        }) + '\n',
      );
    } finally {
      fs.closeSync(fd);
    }
    if (
      fs.realpathSync(scripts) !== scripts ||
      hash(readWorkspaceBytes(managed, 'deck-layout/scripts/generate.cjs', 64 * 1024)) !== hash(installed)
    )
      throw new Error('changed script directory');
    fs.renameSync(staging, target);
    return { ok: true };
  } catch {
    return { ok: false, error: 'slidegen-runtime-unavailable' };
  } finally {
    if (temporary && contained(temporary.root, temporary.path) && fs.existsSync(temporary.path)) {
      const current = fs.lstatSync(temporary.path);
      if (current.dev === temporary.identity.dev && current.ino === temporary.identity.ino)
        fs.unlinkSync(temporary.path);
    }
  }
}
