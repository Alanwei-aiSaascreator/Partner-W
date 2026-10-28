import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PORTABLE_STATE_DIR_NAME, STATE_CONFIG_FILE, STATE_DIR_NAME } from '../src/main/repair/targets.js';

/**
 * 防漂移：修复引擎里的 state 目录名 / 配置文件名，必须与 `runtime/state-config.ts` **逐字一致**。
 *
 * 为什么只能这么测：`state-config.ts` 经 `workspace/config.js` 拉进 `electron`，
 * 而修复引擎要能在不起 Electron 的测试里跑（本批的全部故障注入用例都是这么跑的）。
 * ⇒ 常量各写一份，靠这条**读源码文本**的断言钉住（同 `runtime-constants-drift.test.ts` 的手法）。
 *
 * ⚠️ 它真的会漂：本模块第一版把 `portableStateDirFor()` 用的 `state` 写成了
 *    `openclaw-state` —— 后果是**扫了个空目录、报"全绿"**（修复工具最坏的一种错：
 *    让用户以为盘是好的）。所以两个名字都要钉。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

function readStateConfigSource(): string {
  return fs.readFileSync(path.join(REPO_ROOT, 'packages/desktop/src/main/runtime/state-config.ts'), 'utf-8');
}

function exportedStringLiteral(source: string, name: string): string | null {
  const match = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*'([^']*)'`).exec(source);
  return match ? match[1] : null;
}

describe('修复引擎常量与 state-config 的一致性', () => {
  it('STATE_DIR_NAME（安装形态的 state 目录名）逐字一致', () => {
    const fromSource = exportedStringLiteral(readStateConfigSource(), 'STATE_DIR_NAME');
    expect(fromSource, 'state-config.ts 里找不到 STATE_DIR_NAME（是不是改名了？）').not.toBeNull();
    expect(STATE_DIR_NAME).toBe(fromSource);
  });

  it('STATE_CONFIG_FILE 逐字一致', () => {
    const fromSource = exportedStringLiteral(readStateConfigSource(), 'STATE_CONFIG_FILE');
    expect(fromSource).not.toBeNull();
    expect(STATE_CONFIG_FILE).toBe(fromSource);
  });

  it('盘上形态的 state 父目录名与 `portableStateDirFor()` 的 join 段一致', () => {
    const source = readStateConfigSource();
    const fromSource = exportedStringLiteral(source, 'PORTABLE_STATE_DIR_NAME');
    expect(fromSource, 'state-config.ts 里找不到 PORTABLE_STATE_DIR_NAME').not.toBeNull();
    expect(PORTABLE_STATE_DIR_NAME).toBe(fromSource);
    // 而且 `portableStateDirFor` 真的用它当 join 段（不是只在旁边躺着）
    expect(source).toMatch(/export function portableStateDirFor\([\s\S]{0,300}?PORTABLE_STATE_DIR_NAME/);
  });
});
