import type {
  AgentTemplateDetail,
  AgentTemplateSummary,
  CreatorTemplate,
  TemplateCategory,
  TemplateStatus,
} from '@clawwork/shared';
import { serializeIdentityMd } from './team-parser.js';

/**
 * 助手模板的形状归一 + "模板 → 本地 agent 安装定义"的映射。
 *
 * 归一的四条纪律与 `community-service.ts` 一致：
 *   ① PostgREST 会把 int 序列化成字符串 ⇒ 一律过 Number()；
 *   ② 形状不对的行**丢掉**而不是抛异常；
 *   ③ 枚举越界降级到安全值；
 *   ④ 空字符串要有可见的兜底（emoji）。
 */

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
  return Number.isFinite(n) ? n : 0;
}

function asCategory(value: unknown): TemplateCategory {
  return value === 'content' || value === 'ecommerce' || value === 'research' || value === 'office' ? value : 'other';
}

function asStatus(value: unknown): TemplateStatus {
  return value === 'published' || value === 'archived' ? value : 'draft';
}

/**
 * 模板 → 本地 agent 的**确定性** slug。
 *
 * ⚠️ 网关把 `creationName` 当成 agent id，并要求返回的 id **等于**它
 *    （`installPresetAgentPack` 会校验这一点）。所以这个名字必须
 *    ① 由我们控制、② 稳定：同一个模板在任何机器上装都得到同一个 id，
 *    重复安装才会被幂等跳过，而不是建出第二个助手。
 */
export function templateSlug(templateId: string): string {
  const compact = (templateId ?? '').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  const suffix = (compact + '00000000').slice(0, 8);
  return `rongying-tpl-${suffix}`;
}

export interface AgentInstallDefinition {
  id: string;
  creationName: string;
  emoji: string;
  identityMd: string;
  soulMd: string;
}

/**
 * 模板 → 安装定义。映射约定与预置助手同构：
 *   · 提示词 → IDENTITY.md 的 body（描述进 frontmatter）；
 *   · SOUL.md → 公共操作契约（调用方把 `COMMON_OPERATING_CONTRACT` 传进来，
 *     这样 core 不必依赖 desktop 的常量）。
 */
export function templateToInstallDefinition(
  template: Pick<AgentTemplateDetail, 'id' | 'name' | 'description' | 'emoji' | 'instructions'>,
  soulMd: string,
): AgentInstallDefinition {
  const id = templateSlug(template.id);
  return {
    id,
    creationName: id,
    emoji: template.emoji?.trim() || '🧩',
    identityMd: serializeIdentityMd(template.description?.trim() || undefined, template.instructions ?? ''),
    soulMd,
  };
}

export function normalizeTemplateList(raw: unknown): AgentTemplateSummary[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentTemplateSummary[] = [];
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const id = str(r.id);
    if (!id) continue;
    out.push({
      id,
      name: str(r.name),
      description: str(r.description),
      category: asCategory(r.category),
      emoji: str(r.emoji) || '🧩',
      isOfficial: r.is_official === true,
      authorName: str(r.author_name),
      installCount: num(r.install_count),
      viewCount: num(r.view_count),
      installedByMe: r.installed_by_me === true,
    });
  }
  return out;
}

export function normalizeTemplateDetail(raw: unknown): AgentTemplateDetail | null {
  // RPC 是 `returns table` ⇒ PostgREST 回数组；但单对象也认，免得调用方记错
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (!row || typeof row !== 'object') return null;
  const r = row as Record<string, unknown>;
  const id = str(r.id);
  if (!id) return null;
  return {
    id,
    name: str(r.name),
    description: str(r.description),
    category: asCategory(r.category),
    emoji: str(r.emoji) || '🧩',
    isOfficial: r.is_official === true,
    authorName: str(r.author_name),
    installCount: num(r.install_count),
    viewCount: num(r.view_count),
    installedByMe: r.installed_by_me === true,
    instructions: str(r.instructions),
    isMine: r.is_mine === true,
    status: asStatus(r.status),
  };
}

export function normalizeMyTemplates(raw: unknown): CreatorTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: CreatorTemplate[] = [];
  for (const row of raw) {
    const detail = normalizeTemplateDetail(row);
    if (!detail) continue;
    out.push({ ...detail, createdAt: str((row as Record<string, unknown>).created_at) });
  }
  return out;
}
