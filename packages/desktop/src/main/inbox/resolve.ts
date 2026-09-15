import { realpathSync } from 'fs';
import { open, realpath, stat } from 'fs/promises';
import { isAbsolute, resolve, sep } from 'path';

interface InboxPathInfo {
  base: string;
  full: string;
  inboxDir: string;
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function parseInboxPath(workspacePath: string, localPath: string): InboxPathInfo | null {
  if (!localPath || isAbsolute(localPath)) return null;
  const parts = localPath.replaceAll('\\', '/').split('/');
  if (
    parts.length !== 3 ||
    !parts[0] ||
    parts[0] === '.' ||
    parts[0] === '..' ||
    parts[1] !== 'inbox' ||
    !parts[2] ||
    parts[2] === '.' ||
    parts[2] === '..' ||
    parts[2] === '.import-staging' ||
    /^\.import-.*\.partial$/i.test(parts[2])
  ) {
    return null;
  }
  const base = resolve(workspacePath);
  const full = resolve(base, ...parts);
  if (!isWithin(base, full)) return null;
  return {
    base,
    full,
    inboxDir: resolve(base, parts[0], 'inbox'),
  };
}

async function resolveValidatedPath(
  info: InboxPathInfo,
  pathToResolve: string,
  requireFile = false,
): Promise<string | null> {
  try {
    const [realBase, realInboxDir, realTarget] = await Promise.all([
      realpath(info.base),
      realpath(info.inboxDir),
      realpath(pathToResolve),
    ]);
    if (!isWithin(realBase, realInboxDir)) return null;
    if (!isWithin(realInboxDir, realTarget)) return null;
    if (requireFile && !(await stat(realTarget)).isFile()) return null;
    return realTarget;
  } catch {
    return null;
  }
}

export async function resolveInboxPath(workspacePath: string, localPath: string): Promise<string | null> {
  const info = parseInboxPath(workspacePath, localPath);
  if (!info) return null;
  return resolveValidatedPath(info, info.full, true);
}

export async function readInboxFile(workspacePath: string, localPath: string): Promise<string | null> {
  const info = parseInboxPath(workspacePath, localPath);
  if (!info) return null;
  const handle = await open(info.full, 'r').catch(() => null);
  if (!handle) return null;
  try {
    if (!(await handle.stat()).isFile()) return null;
    const pathToResolve = process.platform === 'win32' ? info.full : `/dev/fd/${handle.fd}`;
    const realTarget =
      process.platform === 'win32'
        ? await resolveValidatedPath(info, pathToResolve)
        : (() => {
            try {
              return realpathSync(pathToResolve);
            } catch {
              return null;
            }
          })();
    if (!realTarget) return null;
    const realInboxDir = await resolveValidatedPath(info, info.inboxDir);
    if (!realInboxDir || !isWithin(realInboxDir, realTarget)) return null;
    return await handle.readFile({ encoding: 'base64' });
  } finally {
    await handle.close();
  }
}
