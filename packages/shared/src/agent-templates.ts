/**
 * 助手市场 / 创作者中心的对外类型（P2）。
 *
 * 设计文档：docs/superpowers/specs/2026-09-17-p2-market-creator-design.md
 *
 * ⚠️ 这里定义的是**归一之后**的形状（驼峰）。数据库 RPC 返回的是 snake_case，
 *    由 core 的 `agent-template-service` 归一；列表类在 preload 上老实写 `unknown[]`。
 */

export type TemplateCategory = 'content' | 'ecommerce' | 'research' | 'office' | 'other';
export type TemplateStatus = 'draft' | 'published' | 'archived';

export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = ['content', 'ecommerce', 'research', 'office', 'other'];

/** 市场列表里的一条（**不含提示词** —— 提示词只在详情里给，详情会记一次浏览）。 */
export interface AgentTemplateSummary {
  id: string;
  name: string;
  description: string;
  category: TemplateCategory;
  emoji: string;
  isOfficial: boolean;
  authorName: string;
  installCount: number;
  viewCount: number;
  installedByMe: boolean;
}

/** 详情：多出提示词、是否本人写的、状态。 */
export interface AgentTemplateDetail extends Omit<AgentTemplateSummary, 'authorName'> {
  authorName: string;
  instructions: string;
  isMine: boolean;
  status: TemplateStatus;
}

/** 创作者中心里"我的模板"一行。 */
export interface CreatorTemplate extends AgentTemplateDetail {
  createdAt: string;
}
