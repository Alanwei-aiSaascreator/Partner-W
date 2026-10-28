import { createHash } from 'node:crypto';

/**
 * partner-w-skill-proposal-name-v1 —— BUG-032：中文（及任何非 ASCII）技能名在
 * proposal 边界被 `normalizeSkillIndexName` 归空后拒收（「Skill name must contain
 * at least one letter or number.」），后台技能审查 cron 同 run 换名重试白烧 token。
 *
 * ## 为什么不改 `normalizeSkillIndexName` 本体
 *
 * 它是 `skill-index-BZ3fgTvf.mjs:5-6` 的 ASCII 归一函数，被 status 查询 / filters /
 * commands 复用（`status-DzRggwg_.mjs`、`workspace-skill-prompt-*.mjs` 等多处消费
 * `normalizedName` / `normalizedSkillKey`）。直接放宽 Unicode = 同时改动多个协议面。
 *
 * ## 修法（只在 proposal 边界）
 *
 * `store-BJ-Ovzb6.mjs` 的 `resolveSkillProposalTarget` 把「展示名」直接当目录键；
 * 改为经 `resolveSkillProposalKey` 派生**安全 ASCII 键**：
 *   - 纯 ASCII 名（含 -/_ 空格）⇒ 走原归一，行为逐字不变（不重命名任何已有技能）；
 *   - 含非 ASCII 字母/数字（中文、中英混、带音标等）⇒ `skill-` + 规范化名称
 *     sha256 前 16 位十六进制（受控前缀 + 名称 hash；不含点/斜杠，天然无穿越）；
 *   - Windows 保留设备名（con/prn/aux/nul/com1-9/lpt1-9 归一结果）⇒ 同走 hash 键，
 *     不让 proposal 落进一个 Windows 建不出来的目录；
 *   - 纯空 / 纯分隔符 / 纯符号（含纯 emoji）⇒ 仍返回 undefined，调用方保留原拒绝。
 *
 * 展示名保留：`resolveSkillProposalName`（create 分支）与 `proposeCreateSkill` 的
 * draft.name 改为**派生出 hash 键时用原名**（其余情况仍用 key，ASCII 面零变化）——
 * 与随包技能惯例一致（`name: 网页交付（…）` + 目录/键为 ASCII）。
 *
 * owner 命名域 / 目录 containment / 冲突检测全部不动：目标目录仍是
 * `resolveWorkshopSkillsDir(config, agentId)` 下的 `path.resolve(root, skillKey)`，
 * `assertInsideSkillsRoot` 两道断言原样保留。
 *
 * 锚点 = npm 2026.9.3 原始模块 sha256（已与部署缓存逐字节核对一致）：
 *   - store-BJ-Ovzb6.mjs   af018202b0af3a40358c4437966f54a25a90b4591e6afe7f6675da7a25daaea0
 *   - service-Kxol3V88.mjs 5c7ff4f381e5057d123b1c4e73178f98175caf63df1fc3d78f4ac5cd3aef24a4
 * 上游换版 ⇒ 构建期 hash 漂移直接失败（fail-closed），不静默改错文件。
 */

export const SKILL_PROPOSAL_TARGET_ENTRY = 'node_modules/openclaw/dist/store-BJ-Ovzb6.mjs';
export const SKILL_PROPOSAL_TARGET_SOURCE_SHA256 = 'af018202b0af3a40358c4437966f54a25a90b4591e6afe7f6675da7a25daaea0';
export const SKILL_PROPOSAL_DRAFT_ENTRY = 'node_modules/openclaw/dist/service-Kxol3V88.mjs';
export const SKILL_PROPOSAL_DRAFT_SOURCE_SHA256 = '5c7ff4f381e5057d123b1c4e73178f98175caf63df1fc3d78f4ac5cd3aef24a4';
export const SKILL_PROPOSAL_NAME_PATCH_ID = 'partner-w-skill-proposal-name-v1';

/** 插入 store 的辅助函数（同一份文本既用于打补丁，也被测试原样抽取执行）。 */
export const SKILL_PROPOSAL_HELPERS = `// partner-w-skill-proposal-name-v1 (helpers)
function isWindowsReservedSkillKey(skillKey) {
\treturn /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(skillKey);
}
function losesAsciiIdentity(displayName) {
\treturn /[\\p{L}\\p{N}]/u.test(displayName.replace(/[A-Za-z0-9]/gu, ""));
}
function resolveSkillProposalKey(skillName) {
\tif (typeof skillName !== "string") return void 0;
\tconst displayName = skillName.normalize("NFKC").trim();
\tif (!/[\\p{L}\\p{N}]/u.test(displayName)) return void 0;
\tconst asciiKey = normalizeSkillIndexName(displayName);
\tif (asciiKey && !losesAsciiIdentity(displayName) && !isWindowsReservedSkillKey(asciiKey)) return asciiKey;
\treturn "skill-" + sha256Hex(displayName).slice(0, 16);
}
function skillProposalDisplayName(skillName, skillKey) {
\tconst displayName = typeof skillName === "string" ? skillName.normalize("NFKC").trim() : "";
\tif (displayName && losesAsciiIdentity(displayName) && resolveSkillProposalKey(displayName) === skillKey) return displayName;
\treturn skillKey;
}`;

const targetOriginal = `function resolveSkillProposalTarget(params) {
\tconst skillKey = normalizeSkillIndexName(params.skillName);`;
const targetPatched = `${SKILL_PROPOSAL_HELPERS}
function resolveSkillProposalTarget(params) {
\tconst skillKey = resolveSkillProposalKey(params.skillName);`;

const nameOriginal = `function resolveSkillProposalName(kind, target) {
\treturn kind === "create" ? target.skillKey : target.skillName;
}`;
const namePatched = `function resolveSkillProposalName(kind, target) {
\tif (kind !== "create") return target.skillName;
\treturn skillProposalDisplayName(target.skillName, target.skillKey);
}`;

const draftOriginal = `\t\tdraft: {
\t\t\tname: target.skillKey,`;
const draftPatched = `\t\tdraft: {
\t\t\tname: resolveSkillProposalName("create", { skillName: name, skillKey: target.skillKey }),`;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function assertAnchors(source, originals) {
  for (const anchor of originals) {
    if (source.split(anchor).length !== 2) throw new Error('skill proposal name anchor drift');
  }
}

/** store-BJ-Ovzb6.mjs：目录键派生 + create 展示名。 */
export function patchSkillProposalTargetRuntime(source, expectedHash = SKILL_PROPOSAL_TARGET_SOURCE_SHA256) {
  const alreadyPatched = source.includes(SKILL_PROPOSAL_HELPERS);
  const original = alreadyPatched
    ? source.replace(targetPatched, targetOriginal).replace(namePatched, nameOriginal)
    : source;
  if (sha256(original) !== expectedHash) throw new Error('skill proposal target source hash drift');
  assertAnchors(original, [targetOriginal, nameOriginal]);
  if (alreadyPatched) return source;
  return original.replace(targetOriginal, targetPatched).replace(nameOriginal, namePatched);
}

/** service-Kxol3V88.mjs：create 的 draft.name 经同一判定保留展示名。 */
export function patchSkillProposalDraftNameRuntime(source, expectedHash = SKILL_PROPOSAL_DRAFT_SOURCE_SHA256) {
  const alreadyPatched = source.includes(draftPatched);
  const original = alreadyPatched ? source.replace(draftPatched, draftOriginal) : source;
  if (sha256(original) !== expectedHash) throw new Error('skill proposal draft source hash drift');
  assertAnchors(original, [draftOriginal]);
  if (alreadyPatched) return source;
  return original.replace(draftOriginal, draftPatched);
}
