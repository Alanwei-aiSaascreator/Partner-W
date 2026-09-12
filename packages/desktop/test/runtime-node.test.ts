import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isSupportedNodeVersionShape,
  loadNodeVersionContract,
  nodeCandidates,
  pickNode,
  probeNodeVersion,
} from '../src/main/runtime/node-runtime.js';
import { SUPPORTED_NODE_RANGE, isSupportedNode } from './helpers/runtime-fixture.js';

/**
 * Node 解析 —— 「U 盘带 Node」那一半。
 *
 * 为什么值得单独一组测试：Electron 内嵌的 Node 20.19.1 起不了 openclaw
 * （要求 >=24.16 <25 || >=26.1，且用了 `node:sqlite`）。**必须先探版本再 spawn**，
 * 否则用户只会在网关 stderr 里看到一行 "Node.js ... is required"，
 * 根本看不出是装载器的锅。
 *
 * ⚠️ 版本区间**不硬编码**：区间由 openclaw 自己发布的 `node-version.mjs` 说了算
 * （`isSupportedOpenClawNodeVersion` / `SUPPORTED_NODE_VERSIONS`），
 * 上游改了区间我们跟着走。这里的单测用**注入的谓词**，不依赖真包存在。
 */

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'clawwork-node-'));
});

afterEach(() => {
  if (tmpRoot && tmpRoot.includes(path.join(os.tmpdir(), 'clawwork-node-'))) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

const RANGE = SUPPORTED_NODE_RANGE;
const realWorldSupport = isSupportedNode;

describe('nodeCandidates', () => {
  it('⭐ 顺序：CLAWWORK_NODE → 本机 deployed → 盘上的 → PATH', () => {
    const c = nodeCandidates({
      envNode: 'E:\\my-node\\node.exe',
      deployedNodePath: 'C:\\cache\\deployed\\k1\\node\\node.exe',
      sourceNodePath: 'Z:\\node\\node.exe',
    });
    expect(c.map((x) => x.origin)).toEqual(['env', 'deployed', 'source', 'path']);
  });

  it('⭐ 本机 deployed **排在盘上的前面**（运行期只用本机那份）', () => {
    const c = nodeCandidates({
      deployedNodePath: 'C:\\cache\\deployed\\k1\\node\\node.exe',
      sourceNodePath: 'Z:\\node\\node.exe',
    });
    expect(c[0].origin).toBe('deployed');
    expect(c[1].origin).toBe('source');
  });

  it('没给的不产生候选；PATH 兜底始终在最后', () => {
    const c = nodeCandidates({});
    expect(c).toEqual([{ exe: 'node', origin: 'path' }]);
  });

  it('拔盘后（没有 source）仍然给出 deployed 候选', () => {
    const c = nodeCandidates({ deployedNodePath: 'C:\\cache\\deployed\\k1\\node\\node.exe' });
    expect(c.map((x) => x.origin)).toEqual(['deployed', 'path']);
  });
});

describe('pickNode', () => {
  const candidates = nodeCandidates({
    deployedNodePath: 'C:\\cache\\deployed\\k1\\node\\node.exe',
    sourceNodePath: 'Z:\\node\\node.exe',
  });

  it('⭐ 跳过不受支持的 20.19.1，选中 26.3.1', () => {
    const versions: Record<string, string | null> = {
      'C:\\cache\\deployed\\k1\\node\\node.exe': '20.19.1',
      'Z:\\node\\node.exe': '26.3.1',
      node: null,
    };
    const res = pickNode({
      candidates,
      probe: (exe) => versions[exe] ?? null,
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.node.version).toBe('26.3.1');
    expect(res.node.origin).toBe('source');
    // 被跳过的那个要留下痕迹（排障时要看得出"为什么没用本机那个"）
    expect(res.attempts[0]).toEqual({
      origin: 'deployed',
      exe: 'C:\\cache\\deployed\\k1\\node\\node.exe',
      version: '20.19.1',
      supported: false,
    });
  });

  it('⭐ 本机 deployed 受支持时就用它，**不去碰盘上的**', () => {
    const probed: string[] = [];
    const res = pickNode({
      candidates,
      probe: (exe) => {
        probed.push(exe);
        return exe === 'Z:\\node\\node.exe' ? '26.3.1' : '26.3.1';
      },
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.node.origin).toBe('deployed');
    expect(probed).toEqual(['C:\\cache\\deployed\\k1\\node\\node.exe']); // 短路，没探盘上那个
  });

  it('探不到的候选直接跳过（文件不在 / 不是可执行 / 超时）', () => {
    const res = pickNode({
      candidates,
      probe: (exe) => (exe.startsWith('C:') ? null : '26.3.1'),
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.node.origin).toBe('source');
  });

  it('⭐ 全不可用时：错误**同时**带实际版本与要求区间', () => {
    const res = pickNode({
      candidates,
      probe: (exe) => (exe.startsWith('C:') ? '20.19.1' : exe === 'Z:\\node\\node.exe' ? '22.4.0' : null),
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain('20.19.1'); // 实际探到的版本
    expect(res.message).toContain('22.4.0');
    expect(res.message).toContain(RANGE); // 要求区间
    expect(res.message).toMatch(/node/i);
  });

  it('一个候选都没有 ⇒ ok:false（不是崩，也不静默返回空）', () => {
    const res = pickNode({
      candidates: [],
      probe: () => '26.3.1',
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toContain(RANGE);
  });

  it('⭐ 环境变量指的那个不合格时**继续往下试**，不是立刻失败', () => {
    const withEnv = nodeCandidates({
      envNode: 'E:\\electron\\electron.exe',
      deployedNodePath: 'C:\\cache\\deployed\\k1\\node\\node.exe',
    });
    const res = pickNode({
      candidates: withEnv,
      probe: (exe) => (exe.startsWith('E:') ? '20.19.1' : '26.3.1'),
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.node.origin).toBe('deployed');
  });

  it('attempts 逐条记录（origin / exe / 版本 / 是否受支持）', () => {
    const res = pickNode({
      candidates: [candidates[1]],
      probe: () => '26.3.1',
      isSupported: realWorldSupport,
      supportedRange: RANGE,
    });
    expect(res.attempts).toEqual([{ origin: 'source', exe: 'Z:\\node\\node.exe', version: '26.3.1', supported: true }]);
  });
});

describe('isSupportedNodeVersionShape', () => {
  it('收下常见的版本写法（含 v 前缀与空白）', () => {
    expect(isSupportedNodeVersionShape('26.3.1')).toBe(true);
    expect(isSupportedNodeVersionShape('v24.16.0')).toBe(true);
    expect(isSupportedNodeVersionShape('  26.3.1\n')).toBe(true);
  });

  it('拒掉不是版本的东西 —— 否则一个报错信息会被当成版本参与比较', () => {
    expect(isSupportedNodeVersionShape('')).toBe(false);
    expect(isSupportedNodeVersionShape('command not found')).toBe(false);
    expect(isSupportedNodeVersionShape('26')).toBe(false);
    expect(isSupportedNodeVersionShape(null)).toBe(false);
  });
});

describe('probeNodeVersion', () => {
  it('探不到就返回 null，不抛（探测失败是常态：盘拔了、路径不对）', () => {
    expect(probeNodeVersion(path.join(tmpRoot, 'does-not-exist.exe'))).toBeNull();
  });

  it('能探到真正的 node（用当前进程的 node）', () => {
    const v = probeNodeVersion(process.execPath);
    expect(v).not.toBeNull();
    expect(isSupportedNodeVersionShape(v)).toBe(true);
  });
});

describe('loadNodeVersionContract', () => {
  function writeContractPackage(body: string): string {
    const pkgRoot = path.join(tmpRoot, 'node_modules', 'openclaw');
    fs.mkdirSync(pkgRoot, { recursive: true });
    fs.writeFileSync(path.join(pkgRoot, 'node-version.mjs'), body);
    return pkgRoot;
  }

  it('⭐ 从**部署后的 openclaw 包**里读区间，而不是我们硬编码', async () => {
    const pkgRoot = writeContractPackage(`
      export const SUPPORTED_NODE_VERSIONS = '>=24.16.0 <25, or >=26.1.0 (Node 26 recommended)';
      export function isSupportedOpenClawNodeVersion(v) {
        const [maj, min] = String(v).split('.').map(Number);
        return maj === 24 ? min >= 16 : maj >= 26;
      }
    `);

    const contract = await loadNodeVersionContract(pkgRoot);
    expect(contract.supportedRange).toBe(RANGE);
    expect(contract.isSupported('26.3.1')).toBe(true);
    expect(contract.isSupported('20.19.1')).toBe(false);
  });

  it('包里没有 node-version.mjs ⇒ 抛错要点名它（不能静默放行任何 Node）', async () => {
    const pkgRoot = path.join(tmpRoot, 'empty');
    fs.mkdirSync(pkgRoot, { recursive: true });
    await expect(loadNodeVersionContract(pkgRoot)).rejects.toThrow(/node-version\.mjs/);
  });

  it('包的导出形状不对 ⇒ 抛错（宁可起不来，也不要用一个"永远返回 false"的谓词）', async () => {
    const pkgRoot = writeContractPackage('export const somethingElse = 1;');
    await expect(loadNodeVersionContract(pkgRoot)).rejects.toThrow(
      /isSupportedOpenClawNodeVersion|SUPPORTED_NODE_VERSIONS/,
    );
  });
});
