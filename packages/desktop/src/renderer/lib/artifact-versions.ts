/**
 * 产物版本归并（2026-10-06，图16：同任务重复/失败产物铺满侧栏）。
 *
 * ## 背景（真机事故）
 *
 * 生成器写文件用 `${stem}-<8hex>.pptx` 抗撞名（`main/slidegen/render-file.ts` 的 wx 口径），
 * 每次重试/重生成都得新名字 ⇒ 三条都登记、都展示，用户看到"三份打不开的 PPT"（图16）。
 *
 * ## 规则
 *
 * - `family` = `${taskId}` + 去掉 `${stem}-<8hex>` 版本后缀后的名字。只认这一种**受控后缀**——
 *   `报告-2.pptx` / `报告-最终版.pptx` 这类人类命名不归并（它们就是不同的文件）。
 * - 默认展示（`current`）= 每个 family 里**最新的一条可用版本**（`availability === 'available'`）。
 * - 折叠区（`archived`）= 其余全部：旧版本 + 确认不可用（unsafe/missing）的版本。
 * - 一个 family 里没有可用版本 ⇒ 整族进折叠区（默认视图不出现"生成失败"的文件）。
 *
 * ## 两条 2026-10-07 体检修掉的边界
 *
 * ① **族键必须带 `taskId`**（P2-5）：会议模式下 `currentTaskArtifacts` 是**多任务合并**的，
 *    只按文件名算族 ⇒ 两个 turn 各交一份同名文件（会议里极常见）时，只有最新那份留在主列表，
 *    另一份会被折进"历史与问题文件" —— 跨任务归属错误。
 * ② **`unknown`（暂不可用/连接中）不参与折叠降级**（P2-3）：冷启动/网关没连上时助手根的
 *    availability 解析不出来，旧口径算成 `missing` ⇒ 整族折走 ⇒ 主列表"交付物没了"。
 *    它是"还不知道"，不是"坏了"：没有可用版本时优先拿它顶上主列表。
 */

import type { Artifact } from '@clawwork/shared';

/**
 * 生成器版本后缀：`-<8hex>`。两条边界（2026-10-09，WorkBuddy A 批 Task 2）：
 *
 * ① **必须含至少一个 a–f 字母**：`20261007` 这种**纯数字日期**是人的命名，不是生成器
 *    hash —— 旧口径把它当版本后缀剥掉，两份按日期命名的稿子被并成一族、旧的被折走
 *    （只读探针 `artifact-version-probe.json` 实测）。
 * ② **剥后缀但保留扩展名**（见 `artifactFamilyKey`）：同 stem 的 `.pptx` 与 `.docx`
 *    是两份不同交付物，旧口径丢扩展名后会把它们并成一族。
 */
const VERSION_SUFFIX_RE = /^(.*)-([0-9a-f]{8})(\.[^.]*)?$/i;

export function artifactFamilyKey(name: string): string {
  const match = VERSION_SUFFIX_RE.exec(name);
  const stem = match && /[a-f]/i.test(match[2]!) ? `${match[1]}${match[3] ?? ''}` : name;
  return stem.trim().toLowerCase();
}

export interface ArtifactVersionGroups {
  /** 默认展示：每族最新可用版本（保持传入列表的时间倒序）。 */
  current: Artifact[];
  /** 折叠区：旧版本 + 问题文件（保持传入列表的时间倒序）。 */
  archived: Artifact[];
}

export function groupArtifactVersions(items: readonly Artifact[]): ArtifactVersionGroups {
  const families = new Map<string, Artifact[]>();
  for (const artifact of items) {
    // ⚠️ 族键 = 任务 + 文件名：跨任务不归并（见文件头 ①）。
    const key = `${artifact.taskId}\u0000${artifactFamilyKey(artifact.name)}`;
    const bucket = families.get(key);
    if (bucket) bucket.push(artifact);
    else families.set(key, [artifact]);
  }

  const current: Artifact[] = [];
  const archived: Artifact[] = [];
  for (const bucket of families.values()) {
    const sorted = [...bucket].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const pick =
      sorted.find((artifact) => artifact.availability === 'available') ??
      // 没有确认可用的：`unknown`（连接中）顶上主列表 —— 折走它就是把"还不知道"当成"坏了"。
      sorted.find((artifact) => artifact.availability === 'unknown');
    for (const artifact of sorted) {
      if (artifact === pick) current.push(artifact);
      else archived.push(artifact);
    }
  }

  // 保持调用方给的时间倒序（分组会打乱顺序）
  const order = new Map(items.map((artifact, index) => [artifact.id, index]));
  const byOriginalOrder = (a: Artifact, b: Artifact) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  current.sort(byOriginalOrder);
  archived.sort(byOriginalOrder);
  return { current, archived };
}
