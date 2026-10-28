import { app } from 'electron';
import { join } from 'path';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { createHash } from 'crypto';
import { TEAMSHUB_COMMUNITY_URL, TEAMSHUB_COMMUNITY_ID } from '@clawwork/shared';
import type { TeamHubRegistry, TeamHubRegistryConfig, TeamHubEntry, ParsedTeam, AgentFileSet } from '@clawwork/shared';
import { readConfig, updateConfig } from '../workspace/config.js';
import { parseTeamMd } from '@clawwork/core';

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'teamshub-cache');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

const SAFE_ID_RE = /^[a-z0-9-]+$/;

/**
 * 拉取团队市场（teamshub）的超时。
 *
 * ⚠️ 默认官方源是 **GitHub raw**（`TEAMSHUB_COMMUNITY_URL`），国内不可达/被黑洞时
 *    Node 的 `fetch` **没有整体超时**（undici 只保证 connect 10s，headers 最长可拖到 300s）
 *    ⇒ 「刷新」按钮能转上几分钟，用户只会以为坏了。10 秒够一次正常拉取，也够快地说"不行"。
 * ⚠️ 超时/网络失败时**必须把 URL 带进错误里**：不然界面上的 `fetch failed` 无法分辨
 *    是官方源不可达、还是用户自己加的源写错了。
 */
const TEAMSHUB_FETCH_TIMEOUT_MS = 10_000;

/** HTTP 层失败（404/403/5xx）。带 `status` 是为了让调用方能区分"这个文件没有"和"源不可用"。 */
class TeamshubHttpError extends Error {
  constructor(
    readonly status: number,
    url: string,
    statusText: string,
  ) {
    super(`Failed to fetch ${url}: ${status} ${statusText}`);
  }
}

async function fetchTeamshub(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TEAMSHUB_FETCH_TIMEOUT_MS) });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'network unreachable';
    throw new Error(`Failed to reach ${url}: ${reason} (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!res.ok) throw new TeamshubHttpError(res.status, url, res.statusText);
  return res;
}

function cachePath(registryId: string): string {
  if (!SAFE_ID_RE.test(registryId)) throw new Error(`Invalid registry id: ${registryId}`);
  return join(cacheDir(), `${registryId}.json`);
}

function registryIdFromUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 12);
}

const GITHUB_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/;

function toRawUrl(githubUrl: string, path: string): string {
  const m = githubUrl.match(GITHUB_URL_RE);
  if (!m) throw new Error(`Invalid GitHub URL: ${githubUrl}`);
  const repo = m[2].replace(/\.git$/, '');
  return `https://raw.githubusercontent.com/${m[1]}/${repo}/main/${path}`;
}

function validateGitHubUrl(url: string): void {
  if (!GITHUB_URL_RE.test(url)) {
    throw new Error('URL must be a GitHub repository (https://github.com/owner/repo)');
  }
}

interface TeamHubJson {
  version: number;
  name: string;
  description?: string;
  teams: TeamHubEntry[];
}

function defaultRegistryConfig(): TeamHubRegistryConfig {
  return { id: TEAMSHUB_COMMUNITY_ID, url: TEAMSHUB_COMMUNITY_URL, isOfficial: true };
}

export function listRegistryConfigs(): TeamHubRegistryConfig[] {
  const config = readConfig();
  const registries = [...(config?.teamHubRegistries ?? [])];
  if (!registries.some((r) => r.id === TEAMSHUB_COMMUNITY_ID)) {
    registries.unshift(defaultRegistryConfig());
  }
  return registries;
}

export function addRegistryConfig(url: string): TeamHubRegistryConfig {
  validateGitHubUrl(url);
  const id = registryIdFromUrl(url);
  const existing = readConfig()?.teamHubRegistries ?? [];
  if (existing.some((r) => r.id === id || r.url === url)) {
    throw new Error('Registry already exists');
  }
  const entry: TeamHubRegistryConfig = { id, url, isOfficial: false };
  updateConfig({ teamHubRegistries: [...existing, entry] });
  return entry;
}

export function removeRegistryConfig(id: string): void {
  if (id === TEAMSHUB_COMMUNITY_ID) throw new Error('Cannot remove community registry');
  const existing = readConfig()?.teamHubRegistries ?? [];
  updateConfig({ teamHubRegistries: existing.filter((r) => r.id !== id) });
  const fp = cachePath(id);
  if (existsSync(fp)) unlinkSync(fp);
}

export function getCachedRegistry(id: string): TeamHubRegistry | null {
  const fp = cachePath(id);
  if (!existsSync(fp)) return null;
  try {
    return JSON.parse(readFileSync(fp, 'utf-8')) as TeamHubRegistry;
  } catch {
    return null;
  }
}

export async function fetchRegistry(registryConfig: TeamHubRegistryConfig): Promise<TeamHubRegistry> {
  const url = toRawUrl(registryConfig.url, 'teamshub.json');
  const res = await fetchTeamshub(url);
  const json = (await res.json()) as TeamHubJson;
  if (json.version !== 1) throw new Error(`Unsupported teamshub.json version: ${json.version}`);

  const registry: TeamHubRegistry = {
    id: registryConfig.id,
    name: json.name,
    description: json.description ?? '',
    url: registryConfig.url,
    isOfficial: registryConfig.isOfficial,
    teams: json.teams.map((t) => ({ ...t, registryId: registryConfig.id })),
    fetchedAt: new Date().toISOString(),
  };

  writeFileSync(cachePath(registryConfig.id), JSON.stringify(registry, null, 2), 'utf-8');
  return registry;
}

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function validateSlug(value: string, label: string): void {
  if (!SLUG_RE.test(value)) throw new Error(`Invalid ${label}: ${value}`);
}

export async function downloadTeamPackage(
  registryUrl: string,
  slug: string,
): Promise<{ parsed: ParsedTeam; agentFiles: Map<string, AgentFileSet> }> {
  validateSlug(slug, 'team slug');
  const teamMdUrl = toRawUrl(registryUrl, `teams/${slug}/TEAM.md`);
  const teamMdRes = await fetchTeamshub(teamMdUrl);
  const teamMdRaw = await teamMdRes.text();
  const parsed = parseTeamMd(teamMdRaw);

  const agentFiles = new Map<string, AgentFileSet>();

  await Promise.all(
    parsed.agents.map(async (agent) => {
      validateSlug(agent.id, 'agent id');
      const base = toRawUrl(registryUrl, `teams/${slug}/agents/${agent.id}`);
      const fileSet: AgentFileSet = {};

      // ⚠️ 三个文件是**可选**的（404 = 这个助手没写），但请求本身失败（超时/断网）
      //    必须**炸出来**：旧写法把非 2xx 一律当成"没有这个文件"，断网时会静默装出一个
      //    **没有身份文件**的团队（用户看到的团队助手没有灵魂）。这里只放行 404。
      const optionalFile = async (fileUrl: string): Promise<string | null> => {
        try {
          const res = await fetchTeamshub(fileUrl);
          return await res.text();
        } catch (err) {
          if (err instanceof TeamshubHttpError && err.status === 404) return null;
          throw err;
        }
      };
      const [identityMd, soulMd, skillsJson] = await Promise.all([
        optionalFile(`${base}/IDENTITY.md`),
        optionalFile(`${base}/SOUL.md`),
        optionalFile(`${base}/skills.json`),
      ]);

      if (identityMd !== null) fileSet.agentMd = identityMd;
      if (soulMd !== null) fileSet.soulMd = soulMd;
      if (skillsJson !== null) fileSet.skillsJson = skillsJson;

      agentFiles.set(agent.id, fileSet);
    }),
  );

  return { parsed, agentFiles };
}
