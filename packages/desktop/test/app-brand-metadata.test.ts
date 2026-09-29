import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));

describe('Windows 交付包品牌元数据', () => {
  it('不再把上游 ClawWork 名称写进 CompanyName / FileDescription', () => {
    const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      author?: unknown;
      description?: unknown;
    };

    expect(manifest.author).toBe('荣盈魔方');
    expect(manifest.description).toBe('荣盈魔方 AI 桌面工作台');
  });
});
