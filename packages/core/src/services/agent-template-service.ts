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
 *
 * ⚠️ 2026-10-07（质检 P2-1）：老写法"去符号 + 取前 8 位"会把**不同模板截成同一个 id**
 *    （`t-official-content-coach` 与 `t-official-writer` 都得到 `tofficia`）——
 *    于是对 B 点"使用"会静默复用到 A 的助手（界面还报成功）。改成**整个 id 的哈希
 *    前 12 位**：同一个 id 永远同一个 slug，不同 id 撞车概率低到可忽略（48 bit）。
 */
export function templateSlug(templateId: string): string {
  return `rongying-tpl-${hash12((templateId ?? '').trim())}`;
}

/**
 * FNV-1a 双种子 ⇒ 前 12 位十六进制（确定性、同步、不依赖 `crypto`）。
 *
 * 为什么要"双种子"：单个 32 位哈希只有 8 位十六进制，取 12 位不够；
 * 两个不同初值的 FNV-1a 串联正好 64 位，够 12 位且实现简单。
 */
function hash12(value: string): string {
  let high = 0x811c9dc5;
  let low = 0x811c9dc5 ^ 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
  }
  return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`.slice(0, 12);
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
