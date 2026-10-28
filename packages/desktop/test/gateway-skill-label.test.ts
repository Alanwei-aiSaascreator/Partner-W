import { describe, expect, it } from 'vitest';
import { COVERED_GATEWAY_SKILLS, gatewaySkillLabel } from '../src/renderer/lib/gateway-skill-label.js';

/**
 * 设置 → 「技能」那一页列的是**网关自带的技能**，名字与描述都是网关的英文原文
 * （`browser-automation` / `python-debugpy` …）。详见 `lib/gateway-skill-label.ts` 顶部注释。
 *
 * ## ⚠️ `REPORTED` 是**实测抄下来的原文**，不是编的
 *
 * 2026-09-20 用随包运行时的**只读 CLI** 数的（本仓库外跑，没起网关）：
 *
 * ```
 * OPENCLAW_STATE_DIR=<openclaw-state> node <deployed>/node_modules/openclaw/openclaw.mjs \
 *   skills list --json --agent main
 * ```
 *
 * `--agent main` 是必须的：本机 `agents.defaults.systemAgent.agentId = "main"`，
 * 而客户端调 `skills.status` **不带 agentId** ⇒ 网关解析到的就是 `main` ⇒
 * **这一页实际是 18 个**（普通 agent 只有 14 个：少 4 个 `openclaw-custodian`）。
 */
const REPORTED: Record<string, string> = {
  'add-model-provider':
    'Add and live-prove a model provider with non-interactive config one-liners, without exposing credentials.',
  'browser-automation':
    'Use when controlling web pages with the OpenClaw browser tool, especially multi-step flows, login checks, tab management, or recovery from stale refs/timeouts.',
  canvas: 'Present hosted widget documents on a connected macOS panel and control panel visibility or navigation.',
  'cloud-image-bake': 'Bake, select, prove, and safely retire a Cloud Worker image with crabbox and config one-liners.',
  'configure-channel':
    'Configure and prove a chat channel with non-interactive one-liners; secrets only as SecretRefs.',
  'control-ui':
    'Operate and troubleshoot the OpenClaw Control UI: navigate connected clients, organize sessions, build session dashboards, and handle direct or Tailscale-hosted Gateways.',
  'diagnose-gateway': 'Diagnose Gateway, config, secrets, channels, and port failures with read-only one-liners.',
  'diagram-maker': 'Create SVG/HTML or Excalidraw diagrams for concepts, architecture, flows, and whiteboards.',
  healthcheck:
    'Audit/harden OpenClaw hosts: SSH, firewall, updates, exposure, backups, disk encryption, gateway security.',
  'node-connect':
    'Diagnose OpenClaw Control UI browser and native Android, iOS, or macOS node connection failures across route, auth, pairing, QR/setup-code, and reconnect states.',
  'node-inspect-debugger': 'Debug Node.js with node inspect, --inspect, breakpoints, CDP, heap, and CPU profiles.',
  'python-debugpy': 'Debug Python with pdb, breakpoint(), post-mortem inspection, and debugpy remote attach.',
  'skill-creator':
    'Author or review AgentSkills: create, repair, validate, or restructure SKILL.md files and bundled resources.',
  spike: 'Run throwaway prototypes to validate feasibility, compare approaches, and report a verdict.',
  taskflow:
    'Run approval-gated workflows with durable TaskFlow state; distinguish workflow execution from linking real detached tasks.',
  'taskflow-inbox-triage':
    'Preview synthetic inbox routing with a real TaskFlow approval pause, and identify the adapters needed for live triage.',
  'video-frames': 'Extract frames or short clips from videos using ffmpeg.',
  weather:
    'Current weather and forecasts with web_fetch, falling back to wttr.in curl for locations, rain, temperature, travel planning.',
};

/** 测试自己的**规格**：哪个技能用哪一组键（不跟着实现里的 camelCase 走，免得一起错）。 */
const EXPECTED_KEY_PREFIX: Record<string, string> = {
  'add-model-provider': 'gatewaySkill.addModelProvider',
  'browser-automation': 'gatewaySkill.browserAutomation',
  canvas: 'gatewaySkill.canvas',
  'cloud-image-bake': 'gatewaySkill.cloudImageBake',
  'configure-channel': 'gatewaySkill.configureChannel',
  'control-ui': 'gatewaySkill.controlUi',
  'diagnose-gateway': 'gatewaySkill.diagnoseGateway',
  'diagram-maker': 'gatewaySkill.diagramMaker',
  healthcheck: 'gatewaySkill.healthcheck',
  'node-connect': 'gatewaySkill.nodeConnect',
  'node-inspect-debugger': 'gatewaySkill.nodeInspectDebugger',
  'python-debugpy': 'gatewaySkill.pythonDebugpy',
  'skill-creator': 'gatewaySkill.skillCreator',
  spike: 'gatewaySkill.spike',
  taskflow: 'gatewaySkill.taskflow',
  'taskflow-inbox-triage': 'gatewaySkill.taskflowInboxTriage',
  'video-frames': 'gatewaySkill.videoFrames',
  weather: 'gatewaySkill.weather',
};

const fakeT = (key: string) => key;

const NAMES = Object.keys(REPORTED);

describe('gatewaySkillLabel —— 覆盖率（实测清单对得上）', () => {
  it('⭐ 覆盖的 18 个与实测报告逐字一致（少一个/多一个都红）', () => {
    expect([...COVERED_GATEWAY_SKILLS].sort()).toEqual([...NAMES].sort());
  });

  it('每个技能都有一组自己的键（规格表也不许漏）', () => {
    expect(Object.keys(EXPECTED_KEY_PREFIX).sort()).toEqual([...NAMES].sort());
  });
});

describe('gatewaySkillLabel —— 名字对上、描述也对上才换', () => {
  it.each(NAMES)('%s：换成它自己那组键（不串门）', (name) => {
    const label = gatewaySkillLabel({ name, description: REPORTED[name] }, fakeT);
    expect(label, `${name} 应当认得出来`).not.toBeNull();
    expect(label?.name).toBe(`${EXPECTED_KEY_PREFIX[name]}.name`);
    expect(label?.description).toBe(`${EXPECTED_KEY_PREFIX[name]}.description`);
  });

  it('⭐ 名字对上了、描述被改过 ⇒ **不认**（返回 null，调用方显示原文）', () => {
    const changed = `${REPORTED.weather} Now with hourly data.`;
    expect(gatewaySkillLabel({ name: 'weather', description: changed }, fakeT)).toBeNull();
  });

  it('⭐ 描述缺了/是空的 ⇒ 不认（不能凭名字就换）', () => {
    expect(gatewaySkillLabel({ name: 'weather' }, fakeT)).toBeNull();
    expect(gatewaySkillLabel({ name: 'weather', description: '' }, fakeT)).toBeNull();
  });

  it('⭐ 不认识的技能（我们自己的市场技能 / 用户装的）⇒ 不认', () => {
    expect(gatewaySkillLabel({ name: 'meeting-minutes', description: '把会议记录整理成结构化纪要' }, fakeT)).toBeNull();
    // 名字像但**多一个字**也不算
    expect(gatewaySkillLabel({ name: 'weather2', description: REPORTED.weather }, fakeT)).toBeNull();
    // 空名字
    expect(gatewaySkillLabel({ name: '', description: REPORTED.weather }, fakeT)).toBeNull();
  });

  it('空白差异（YAML 折叠/换行）**不算**改过 ⇒ 照样换', () => {
    const folded = REPORTED.weather.replace(/, /g, ',\n  ').replace(/: /g, ':\n  ');
    expect(gatewaySkillLabel({ name: 'weather', description: folded }, fakeT)?.name).toBe('gatewaySkill.weather.name');
    expect(gatewaySkillLabel({ name: 'weather', description: `  ${REPORTED.weather}  ` }, fakeT)?.name).toBe(
      'gatewaySkill.weather.name',
    );
  });

  it('⚠️ 归一化只吃空白 —— **大小写/标点不同照样不认**', () => {
    expect(gatewaySkillLabel({ name: 'weather', description: REPORTED.weather.toUpperCase() }, fakeT)).toBeNull();
  });
});
