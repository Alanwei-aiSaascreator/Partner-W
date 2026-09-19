/**
 * 「我们自己的技能」的 IPC 面（T-a2）。
 *
 * 薄薄一层：解析随包目录 → 找网关要安装目录 → 调 `bundled.ts` 里的纯逻辑。
 * **不做业务判断**（哪个算装上、slug 合不合法、路径会不会逃逸），那些都在
 * `bundled.ts` 里，有它自己的单测。
 *
 * ## 安装目录为什么**不**从渲染层传
 *
 * 渲染层能把 `skills.status` 里的 `managedSkillsDir` 读出来，让它传上来最省事 ——
 * 但那等于**把一条任意的绝对路径交给"删目录"这个动作**。
 * 所以渲染层只传 `{gatewayId, agentId, slug}`，目录由主进程**问网关要**
 *（`skills.status` 自己会报，实测 2026-09-20）。渲染层永远碰不到路径。
 */

import { app, ipcMain } from 'electron';
import { getGatewayClient } from '../ws/index.js';
import { installBundledSkill, isBundledSkillInstalled, readBundledSkills, removeBundledSkill } from './bundled.js';
import { resolveOurSkillsRoot } from './locate.js';

function ipcError(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : 'unknown' };
}

function ourSkillsRoot(): string | undefined {
  return resolveOurSkillsRoot({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
}

/**
 * 问网关要技能安装目录（`managedSkillsDir`）。
 *
 * ⚠️ 拿不到就**明确失败**。降级成"本地猜一个 `<stateDir>/skills`"会把
 *    "网关还没连上"变成一个**看起来成功、其实写错地方**的安装 ——
 *    那正是最难查的那种 bug。宁可让用户看到"装不上，稍后再试"。
 */
async function managedSkillsDirOf(gatewayId: string, agentId?: string): Promise<string | null> {
  const gw = getGatewayClient(gatewayId);
  if (!gw?.isConnected) return null;
  try {
    const report = await gw.getSkillsStatus(agentId);
    const dir = (report as { managedSkillsDir?: unknown } | undefined)?.managedSkillsDir;
    return typeof dir === 'string' && dir.length > 0 ? dir : null;
  } catch {
    return null;
  }
}

export function registerSkillsHandlers(): void {
  /**
   * 列出随包技能。**网关没连上也能列**（`installed` 全为 `false`）——
   * 技能市场是"我们有什么"，不该因为网关没起来就整页空着。
   */
  ipcMain.handle('skills:our-list', async (_event, payload: { gatewayId?: string; agentId?: string } = {}) => {
    try {
      const skills = readBundledSkills(ourSkillsRoot());
      const managedDir = payload?.gatewayId ? await managedSkillsDirOf(payload.gatewayId, payload.agentId) : null;
      return {
        ok: true,
        managedDirKnown: managedDir !== null,
        skills: skills.map((skill) => ({
          ...skill,
          installed: managedDir ? isBundledSkillInstalled(managedDir, skill.slug) : false,
        })),
      };
    } catch (err) {
      return ipcError(err);
    }
  });

  ipcMain.handle(
    'skills:our-install',
    async (_event, payload: { gatewayId: string; agentId?: string; slug: string }) => {
      try {
        const managedDir = await managedSkillsDirOf(payload.gatewayId, payload.agentId);
        if (!managedDir) return { ok: false, error: 'GATEWAY_UNAVAILABLE' };
        return installBundledSkill({ root: ourSkillsRoot(), managedDir, slug: payload.slug });
      } catch (err) {
        return ipcError(err);
      }
    },
  );

  ipcMain.handle(
    'skills:our-remove',
    async (_event, payload: { gatewayId: string; agentId?: string; slug: string }) => {
      try {
        const managedDir = await managedSkillsDirOf(payload.gatewayId, payload.agentId);
        if (!managedDir) return { ok: false, error: 'GATEWAY_UNAVAILABLE' };
        return removeBundledSkill({ managedDir, slug: payload.slug });
      } catch (err) {
        return ipcError(err);
      }
    },
  );
}
