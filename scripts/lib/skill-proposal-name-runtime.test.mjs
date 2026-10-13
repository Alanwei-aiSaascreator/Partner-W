import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  patchSkillProposalTargetRuntime,
  patchSkillProposalDraftNameRuntime,
  SKILL_PROPOSAL_HELPERS,
} from './skill-proposal-name-runtime.mjs';

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/**
 * 与随包 `skill-index-BZ3fgTvf.mjs:5-6` 逐字一致的归一实现（测试替身）。
 * 真模块上的逐条行为已在离线导入证据里核对（E-032-060-report §4）——这里只保证
 * 补丁逻辑与派生规则在给定归一契约下的正确性。
 */
const normalizeSkillIndexName = (value) =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

const storeFixture = `import { a as normalizeSkillIndexName } from "./skill-index-BZ3fgTvf.mjs";
function resolveSkillProposalName(kind, target) {
\treturn kind === "create" ? target.skillKey : target.skillName;
}
function resolveSkillProposalTarget(params) {
\tconst skillKey = normalizeSkillIndexName(params.skillName);
\tif (!skillKey) throw new Error("Skill name must contain at least one letter or number.");
\treturn { skillKey };
}
export { resolveSkillProposalName, resolveSkillProposalTarget };`;

const fixtureHash = (source) => createHash('sha256').update(source).digest('hex');

function evaluate(patched) {
  return new Function(
    'normalizeSkillIndexName',
    'sha256Hex',
    patched.replace(/^import[^\n]+\n/m, '').replace(/^export \{[^}]*\};?\s*$/m, '') +
      ';return { resolveSkillProposalTarget, resolveSkillProposalName };',
  )(normalizeSkillIndexName, sha256Hex);
}

test('RED baseline: fixture without the patch rejects a pure-Chinese skill name', () => {
  const pristine = evaluate(storeFixture);
  assert.throws(
    () => pristine.resolveSkillProposalTarget({ skillName: '中文技能' }),
    /Skill name must contain at least one letter or number\./,
  );
  assert.equal(normalizeSkillIndexName('中文技能'), '');
});

test('patched fixture derives a bounded safe key for non-ASCII names and keeps display name', () => {
  const patched = patchSkillProposalTargetRuntime(storeFixture, fixtureHash(storeFixture));
  const { resolveSkillProposalTarget, resolveSkillProposalName } = evaluate(patched);

  const cn = resolveSkillProposalTarget({ skillName: '中文技能' });
  assert.match(cn.skillKey, /^skill-[0-9a-f]{16}$/);
  assert.equal(resolveSkillProposalTarget({ skillName: '中文技能' }).skillKey, cn.skillKey);
  assert.notEqual(resolveSkillProposalTarget({ skillName: '中文技能B' }).skillKey, cn.skillKey);

  // 中英混 / 带音标：不再被静默截成 'abc' / 'caf'
  assert.match(resolveSkillProposalTarget({ skillName: '中文abc' }).skillKey, /^skill-[0-9a-f]{16}$/);
  assert.match(resolveSkillProposalTarget({ skillName: 'café' }).skillKey, /^skill-[0-9a-f]{16}$/);

  // 纯 ASCII 行为逐字不变（不重命名已有技能）
  assert.equal(resolveSkillProposalTarget({ skillName: 'My Skill' }).skillKey, 'my-skill');
  assert.equal(resolveSkillProposalTarget({ skillName: 'my-skill' }).skillKey, 'my-skill');
  // 全角经 NFKC 折叠成 ASCII 键（旧行为会拒收）
  assert.equal(resolveSkillProposalTarget({ skillName: 'ＡＢＣ' }).skillKey, 'abc');

  // Windows 保留设备名不再落成 con/com1 目录
  assert.match(resolveSkillProposalTarget({ skillName: 'CON' }).skillKey, /^skill-[0-9a-f]{16}$/);
  assert.match(resolveSkillProposalTarget({ skillName: 'com1' }).skillKey, /^skill-[0-9a-f]{16}$/);

  // 穿越形态：键里没有点/斜杠，'.' 段被归一吃掉
  assert.equal(resolveSkillProposalTarget({ skillName: '../evil' }).skillKey, 'evil');
  assert.match(resolveSkillProposalTarget({ skillName: '中文..' }).skillKey, /^skill-[0-9a-f]{16}$/);

  // 纯空 / 纯分隔符 / 纯符号（含纯 emoji）仍拒绝
  for (const bad of ['', '   ', '---', '..', '///', '...', '🚀', '　']) {
    assert.throws(() => resolveSkillProposalTarget({ skillName: bad }), /at least one letter or number/);
  }

  // 展示名：创建时保留原中文名；键不一致或纯 ASCII 时回退到 key
  assert.equal(resolveSkillProposalName('create', { skillName: '中文技能', skillKey: cn.skillKey }), '中文技能');
  assert.equal(resolveSkillProposalName('create', { skillName: '中文技能', skillKey: 'skill-other' }), 'skill-other');
  assert.equal(resolveSkillProposalName('create', { skillName: 'My Skill', skillKey: 'my-skill' }), 'my-skill');
  assert.equal(resolveSkillProposalName('update', { skillName: '中文技能', skillKey: cn.skillKey }), '中文技能');
});

test('target patch mechanics: idempotent, hash-pinned, anchor-pinned', () => {
  const patched = patchSkillProposalTargetRuntime(storeFixture, fixtureHash(storeFixture));
  assert.ok(patched.includes(SKILL_PROPOSAL_HELPERS));
  // 二次执行幂等：再打一遍返回逐字同一份
  assert.equal(patchSkillProposalTargetRuntime(patched, fixtureHash(storeFixture)), patched);
  // 源 hash 漂移 ⇒ 拒绝
  assert.throws(
    () => patchSkillProposalTargetRuntime(`${storeFixture}\n// drift`, fixtureHash(storeFixture)),
    /hash drift/,
  );
  // 锚点缺失/重复 ⇒ 拒绝（匹配数断言）
  const anchorBroken = storeFixture.replace(
    'const skillKey = normalizeSkillIndexName(params.skillName);',
    'const skillKey = somethingElse(params.skillName);',
  );
  assert.throws(() => patchSkillProposalTargetRuntime(anchorBroken, fixtureHash(anchorBroken)), /anchor drift/);
});

test('service draft-name patch: rewires create draft to the display-name helper only', () => {
  const serviceFixture = `function proposeCreateSkill(input) {
\tconst name = normalizeRequired(input.name, "Skill name");
\treturn createPendingSkillProposal(input, {
\t\tconfig,
\t\tagentId,
\t\tkind: "create",
\t\tdraft: {
\t\t\tname: target.skillKey,
\t\t\tdescription,
\t\t\tcontent: input.content
\t\t}
\t});
}`;
  const patched = patchSkillProposalDraftNameRuntime(serviceFixture, fixtureHash(serviceFixture));
  assert.ok(patched.includes('resolveSkillProposalName("create", { skillName: name, skillKey: target.skillKey })'));
  assert.ok(!patched.includes('name: target.skillKey,'));
  assert.equal(patchSkillProposalDraftNameRuntime(patched, fixtureHash(serviceFixture)), patched);
  assert.throws(
    () => patchSkillProposalDraftNameRuntime(`${serviceFixture}\n// drift`, fixtureHash(serviceFixture)),
    /hash drift/,
  );
  // 更新链路的 draft（name: target.skillName）不属于本次补丁面
  assert.throws(
    () =>
      patchSkillProposalDraftNameRuntime(
        serviceFixture.replace('name: target.skillKey,', 'name: target.skillName,'),
        fixtureHash(serviceFixture.replace('name: target.skillKey,', 'name: target.skillName,')),
      ),
    /anchor drift/,
  );
});
