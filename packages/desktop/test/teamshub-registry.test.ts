import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 团队市场（teamshub）的**外部源容错**（2026-10-05，AI 建队排查顺带）。
 *
 * 默认官方源是 GitHub raw（`TEAMSHUB_COMMUNITY_URL`）——国内常常不可达。旧实现里：
 *
 * 1. `fetch` 没有整体超时 ⇒ 网关把连接吊着时「刷新」能转几分钟不回来；
 * 2. 拉取失败的错误里**没有 URL** ⇒ 界面上的 `fetch failed` 分不清是官方源不可达、
 *    还是用户自己加的源写错了；
 * 3. 助手文件（IDENTITY/SOUL/skills.json）的 `!res.ok` **一律当成"这个文件没有"** ⇒
 *    断网时会静默装出一个**没有身份文件**的团队。
 */

const hoisted = vi.hoisted(() => ({ cacheRoot: '' }));

vi.mock('electron', () => ({ app: { getPath: () => hoisted.cacheRoot } }));
vi.mock('../src/main/workspace/config.js', () => ({ readConfig: vi.fn(() => ({})), updateConfig: vi.fn() }));

import { downloadTeamPackage, fetchRegistry } from '../src/main/teamshub/registry';

const COMMUNITY = { id: 'community', url: 'https://github.com/clawwork-ai/teamshub-community', isOfficial: true };
const RAW_TEAMSHUB = 'https://raw.githubusercontent.com/clawwork-ai/teamshub-community/main/teamshub.json';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? 'Not Found' : 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  hoisted.cacheRoot = mkdtempSync(join(tmpdir(), 'teamshub-test-'));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(hoisted.cacheRoot, { recursive: true, force: true });
});

describe('teamshub 拉取：坏网络必须给出可读、可定位的失败', () => {
  it('HTTP 非 2xx ⇒ 错误里带上是**哪个 URL** 失败了', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));
    await expect(fetchRegistry(COMMUNITY)).rejects.toThrow(RAW_TEAMSHUB);
  });

  it('网络/超时 ⇒ 说清是 timed out / unreachable，并带上 URL（fetch 永远不 resolve 也不吊死）', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    fetchMock.mockRejectedValue(timeout);

    await expect(fetchRegistry(COMMUNITY)).rejects.toThrow(/timed out/);
    await expect(fetchRegistry(COMMUNITY)).rejects.toThrow(RAW_TEAMSHUB);
  });

  it('每次请求都带超时信号（不让「刷新」无限期转圈）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ version: 1, name: 'Community', teams: [] }));
    await fetchRegistry(COMMUNITY);

    const init = fetchMock.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('⭐ 助手文件请求失败（断网）不许静默降级成"没有这个文件"', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith('teamshub.json')) return jsonResponse({ version: 1, name: 'C', teams: [] });
      if (url.endsWith('TEAM.md'))
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () =>
            '---\nname: Demo\ndescription: demo team\nagents:\n  - id: author\n    name: Author\n    role: coordinator\n---\n\nbody\n',
          json: async () => ({}),
        } as unknown as Response;
      throw new Error('network unreachable');
    });

    await expect(downloadTeamPackage(COMMUNITY.url, 'demo')).rejects.toThrow(/network unreachable/);
  });

  it('正向对照：助手文件**真的没有**（404）仍按"可选"处理，照常装', async () => {
    const files: Record<string, string> = {
      'TEAM.md':
        '---\nname: Demo\ndescription: demo team\nagents:\n  - id: author\n    name: Author\n    role: coordinator\n---\n\nbody\n',
      'IDENTITY.md': '# 作者\n',
    };
    fetchMock.mockImplementation(async (url: string) => {
      for (const [name, content] of Object.entries(files)) {
        if (url.endsWith(name)) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            text: async () => content,
            json: async () => ({}),
          } as unknown as Response;
        }
      }
      return jsonResponse({}, 404);
    });

    const { parsed, agentFiles } = await downloadTeamPackage(COMMUNITY.url, 'demo');
    expect(parsed.agents.map((agent) => agent.id)).toEqual(['author']);
    expect(agentFiles.get('author')?.agentMd).toContain('作者');
    expect(agentFiles.get('author')?.soulMd).toBeUndefined();
  });
});
