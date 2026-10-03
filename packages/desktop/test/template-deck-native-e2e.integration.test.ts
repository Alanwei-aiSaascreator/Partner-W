import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

/**
 * 固定槽位 templateDeck 的**无头入口防回归**（2026-10-03）。
 *
 * 判据：用**固定载荷**（`fixtures/template-deck-16p.native-ppt`，逐字节 = 当日
 * 真机出片用过的源稿，`FIXTURE_SHA256` 与其产物收据里的 sourceSha256 可对；
 * ⚠️ 夹具刻意不带 `.json` 后缀——`prettier --check .` 会重排它、破坏这份逐字节保真）走
 * **产品自己的无头通道**（`deck-layout/scripts/generate.cjs` → electron
 * `--royin-render-native-ppt`）：
 *   - `status === 'file-generated'`
 *   - `contentReview === 'field-coverage-passed'`
 *   - `pages === 16`
 *
 * ⚠️ 需要候选包（含已安装技能副本与 `generate-runtime.json`，两者同在脚本旁）：
 *     `ROYIN_NATIVE_E2E_GENERATE_CJS=<候选>\private-profile\openclaw-state\skills\deck-layout\scripts\generate.cjs`
 *     未设该环境变量时**跳过**（同 `relay-bundled-search-runtime.integration.test.ts` 的惯例）。
 * 手动复跑（CWD=workspace、只准 1 个位置参数、零模型费用）：
 *     cd <workspace> && ROYIN_NATIVE_PPT_VALIDATION=1 node <该 generate.cjs> report.native-ppt.json
 */

const generateCjs = process.env.ROYIN_NATIVE_E2E_GENERATE_CJS;
const fixture = path.join(import.meta.dirname, 'fixtures/template-deck-16p.native-ppt');
/** 与真机出片收据（sourceSha256）逐字对上的钉子——载荷一旦被改动，这里先红。 */
const FIXTURE_SHA256 = 'd0276f7bdc2db8b3ee5f6c90c38dc9e24da09a3bb411b6027c39e67b7996b3a0';

it.runIf(Boolean(generateCjs))(
  'the fixed 16-page payload renders through the headless entry with field coverage passed',
  () => {
    const payload = fs.readFileSync(fixture);
    expect(createHash('sha256').update(payload).digest('hex')).toBe(FIXTURE_SHA256);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'template-deck-native-'));
    try {
      fs.writeFileSync(path.join(workspace, 'report.native-ppt.json'), payload);
      const result = spawnSync(process.execPath, [path.resolve(generateCjs!), 'report.native-ppt.json'], {
        cwd: workspace,
        env: { ...process.env, ROYIN_NATIVE_PPT_VALIDATION: '1' },
        encoding: 'utf8',
        timeout: 300_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      const report = JSON.parse(result.stdout.trim()) as {
        status: string;
        contentReview?: string;
        pages?: number;
        visualReview?: string;
        fileName?: string;
      };
      expect(report.status, result.stdout + result.stderr).toBe('file-generated');
      expect(report.contentReview).toBe('field-coverage-passed');
      expect(report.pages).toBe(16);
      expect(report.visualReview).toBe('not-performed');
      expect(fs.existsSync(path.join(workspace, report.fileName ?? ''))).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  },
);
