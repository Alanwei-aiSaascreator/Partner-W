import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolCall } from '@clawwork/shared';
import { readWorkspaceBytes } from '../slidegen/source-file.js';
export function nativeInputFromCompletedWrites(workspace: string, tools: ToolCall[]): string | undefined {
  const candidates = new Map<string, string>();
  for (const tool of tools) {
    if (tool.status !== 'done' || !['write', 'write_file'].includes(tool.name) || !tool.args) continue;
    const file = tool.args.path ?? tool.args.file_path,
      content = tool.args.content;
    if (typeof file !== 'string' || !file.endsWith('.native-ppt.json') || typeof content !== 'string') continue;
    const relative = path.isAbsolute(file) ? path.relative(workspace, file) : file;
    candidates.set(relative, content);
  }
  const current = [...candidates].filter(([file, content]) => {
    try {
      return (
        createHash('sha256')
          .update(readWorkspaceBytes(workspace, file, 1024 * 1024))
          .digest('hex') === createHash('sha256').update(content).digest('hex')
      );
    } catch {
      return false;
    }
  });
  if (current.length > 1) throw Error('native-input-ambiguous');
  return current[0]?.[0];
}
