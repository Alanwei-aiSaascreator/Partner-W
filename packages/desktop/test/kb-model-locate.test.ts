import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KB_MODEL_DIR_NAME, resolveKbModelRoot } from '../src/main/kb/embedding/locate';

/**
 * 嵌入模型根目录的解析。
 *
 * ⚠️ 这里的形状跟 `runtime/locate.ts` 的 `resolveBundledRuntimeRoot` 一样，是**故意的**：
 * 两处都犯过同一个错的另一面 —— 打包态与开发态的路径规则不同，而"开发态好好的、
 * 装出来就不对"最难查。所以做成纯函数（`isPackaged` / `resourcesPath` 由调用方注入），
 * 两个态都能直接测，不用真打包。
 */
const dirs: string[] = [];

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-locate-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('resolveKbModelRoot', () => {
  it('⭐ 打包态指向 <resources>/kb-model（与 electron-builder 的 extraResources 目标同名）', () => {
    const resources = tmp();

    const root = resolveKbModelRoot({ isPackaged: true, resourcesPath: resources });

    expect(root).toBe(path.join(resources, KB_MODEL_DIR_NAME));
  });

  it('打包态但没有 resourcesPath ⇒ undefined（宁可不给，也不要去猜一个路径）', () => {
    expect(resolveKbModelRoot({ isPackaged: true })).toBeUndefined();
  });

  it('⭐ 开发态指向仓库根的 runtime-out/kb-model（与抓取脚本的落点一致）', () => {
    const repoRoot = tmp();

    const root = resolveKbModelRoot({ isPackaged: false, repoRoot });

    expect(root).toBe(path.join(repoRoot, 'runtime-out', KB_MODEL_DIR_NAME));
  });

  it('开发态但没给 repoRoot ⇒ undefined', () => {
    expect(resolveKbModelRoot({ isPackaged: false })).toBeUndefined();
  });

  it('目录名是稳定常量（换名 = 打包配置和这里同时漂移，gate 测试会抓）', () => {
    expect(KB_MODEL_DIR_NAME).toBe('kb-model');
  });
});
