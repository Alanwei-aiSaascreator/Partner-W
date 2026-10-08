/**
 * 设置 → 「技能」那一页列的是**网关自带的技能**（`browser-automation` / `python-debugpy` …），
 * 名字与描述都是网关的英文原文 —— 中文界面上是一片英文（T-a4 的尾巴）。
 *
 * ## ⚠️ 为什么只能做**展示层**映射
 *
 * `skill.name` / `skill.description` 是**网关侧数据**（来自各 `SKILL.md` 的 frontmatter，
 * 见 `skills.status` 报告）。所以：
 * - 映射只发生在**显示**的那一步，`skill.name` / `skill.description` 一个字节都不动；
 * - **认不出来的一律原样显示** —— 我们自己的市场技能、用户从 ClawHub 装的、
 *   网关将来改了文案的，都走这条，绝不会被我们张冠李戴成别的技能；
 * - 认不出来的代价只是"又是英文"（**良性降级**），不是显示错的技能（恶性）。
 *
 * ## ⚠️ 判据②：名字对上**还不够**，描述也要对上
 *
 * 与 `cron-job-label.ts` 同一条纪律（那里是"名字对上还不够，载荷也要对上"）。
 * 只认名字的话，网关哪天把某个技能的**行为/文案改了**，页面还按我们那份旧译文描述它
 * —— 那是**过期且可能错误**的信息。所以这里要求描述**逐字相同**（只归一化空白：
 * YAML 的折叠/换行不该让我们失效）。
 *
 * 代价是**故意的**：网关改了描述 ⇒ 那一条退回英文。这是**判据生效**，不是 bug。
 *
 * ## 这份清单是怎么来的（别改成"猜"的）
 *
 * 2026-09-20 用**随包运行时的只读 CLI** 抄的（本仓库外跑，**没起网关**）：
 *
 * ```
 * OPENCLAW_STATE_DIR=<openclaw-state> node <deployed>/node_modules/openclaw/openclaw.mjs \
 *   skills list --json --agent main
 * ```
 *
 * `--agent main` 是当时采集清单的显式视角。现在客户端通过
 * `getSkillsStatus(gatewayId, agentId)` 传入有效管理默认助手或唯一助手，
 * 不依赖 ambient owner；不同助手的实际清单可能不同。
 * 当时普通 agent（如 `rongying-office`）只报 **14** 个 —— 少 4 个 `openclaw-custodian`。
 *
 * ⚠️ **要刷新这份清单**（网关升级后）：重跑上面那条命令，
 * 把新的 name/description 抄进 `GATEWAY_SKILL_DESCRIPTIONS`，
 * 并照 `REPORTED` 那份实测清单同步 `gateway-skill-label.test.ts`（它会判红提醒你）。
 */

/** 网关 `skills.status` 报出来的技能名（= 该技能的 `skillKey`）。 */
export const COVERED_GATEWAY_SKILLS: readonly string[] = [
  'add-model-provider',
  'browser-automation',
  'canvas',
  'cloud-image-bake',
  'configure-channel',
  'control-ui',
  'diagnose-gateway',
  'diagram-maker',
  'healthcheck',
  'node-connect',
  'node-inspect-debugger',
  'python-debugpy',
  'skill-creator',
  'spike',
  'taskflow',
  'taskflow-inbox-triage',
  'video-frames',
  'weather',
];

/**
 * 实测抄下来的**英文原文**（网关的 `skills.status` 报告，2026-09-20）。
 *
 * ⚠️ 这是**判据**，不是文案：显示用的是词表（`gatewaySkill.*`），
 * 这里只用来核对"网关照旧是那一条"。所以**一个字都别改**。
 */
export const GATEWAY_SKILL_DESCRIPTIONS: Record<string, string> = {
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

type Translate = (key: string, opts?: Record<string, unknown>) => string;

/**
 * 名字 → 显示文案。⚠️ `t` 的键**必须写成字面量**：本仓库的 `check:i18n` 靠扫描
 * 带引号的字面量键做「代码 → 词表」的反向断言，拼串（或把键存进表里再传变量）
 * 会让"键打错了"这种错**静默漏过**（运行时就显示成生键名）。
 *
 * ⚠️ 连**注释里**都别写出「t 加圆括号加引号」那种字样：那个扫描器**不剥注释**，
 * 会把文档里的例子当成真键（我这个文件第一版就是这么被 `check:i18n` 抓红的）。
 */
function labelFor(name: string, t: Translate): { name: string; description: string } | null {
  switch (name) {
    case 'add-model-provider':
      return {
        name: t('gatewaySkill.addModelProvider.name'),
        description: t('gatewaySkill.addModelProvider.description'),
      };
    case 'browser-automation':
      return {
        name: t('gatewaySkill.browserAutomation.name'),
        description: t('gatewaySkill.browserAutomation.description'),
      };
    case 'canvas':
      return { name: t('gatewaySkill.canvas.name'), description: t('gatewaySkill.canvas.description') };
    case 'cloud-image-bake':
      return {
        name: t('gatewaySkill.cloudImageBake.name'),
        description: t('gatewaySkill.cloudImageBake.description'),
      };
    case 'configure-channel':
      return {
        name: t('gatewaySkill.configureChannel.name'),
        description: t('gatewaySkill.configureChannel.description'),
      };
    case 'control-ui':
      return { name: t('gatewaySkill.controlUi.name'), description: t('gatewaySkill.controlUi.description') };
    case 'diagnose-gateway':
      return {
        name: t('gatewaySkill.diagnoseGateway.name'),
        description: t('gatewaySkill.diagnoseGateway.description'),
      };
    case 'diagram-maker':
      return { name: t('gatewaySkill.diagramMaker.name'), description: t('gatewaySkill.diagramMaker.description') };
    case 'healthcheck':
      return { name: t('gatewaySkill.healthcheck.name'), description: t('gatewaySkill.healthcheck.description') };
    case 'node-connect':
      return { name: t('gatewaySkill.nodeConnect.name'), description: t('gatewaySkill.nodeConnect.description') };
    case 'node-inspect-debugger':
      return {
        name: t('gatewaySkill.nodeInspectDebugger.name'),
        description: t('gatewaySkill.nodeInspectDebugger.description'),
      };
    case 'python-debugpy':
      return {
        name: t('gatewaySkill.pythonDebugpy.name'),
        description: t('gatewaySkill.pythonDebugpy.description'),
      };
    case 'skill-creator':
      return { name: t('gatewaySkill.skillCreator.name'), description: t('gatewaySkill.skillCreator.description') };
    case 'spike':
      return { name: t('gatewaySkill.spike.name'), description: t('gatewaySkill.spike.description') };
    case 'taskflow':
      return { name: t('gatewaySkill.taskflow.name'), description: t('gatewaySkill.taskflow.description') };
    case 'taskflow-inbox-triage':
      return {
        name: t('gatewaySkill.taskflowInboxTriage.name'),
        description: t('gatewaySkill.taskflowInboxTriage.description'),
      };
    case 'video-frames':
      return { name: t('gatewaySkill.videoFrames.name'), description: t('gatewaySkill.videoFrames.description') };
    case 'weather':
      return { name: t('gatewaySkill.weather.name'), description: t('gatewaySkill.weather.description') };
    default:
      return null;
  }
}

/**
 * 只归一化**空白**（YAML 折叠、首尾空格）。大小写/标点不同 ⇒ **不认**：
 * 那说明网关改了文案，我们那份译文可能已经不对了。
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * 网关自带技能的**显示名与显示描述**；认不出来返回 `null`（调用方原样显示网关的值）。
 */
export function gatewaySkillLabel(
  skill: { name: string; description?: string },
  t: Translate,
): { name: string; description: string } | null {
  const expected = Object.prototype.hasOwnProperty.call(GATEWAY_SKILL_DESCRIPTIONS, skill.name)
    ? GATEWAY_SKILL_DESCRIPTIONS[skill.name]
    : undefined;
  if (expected === undefined) return null;
  if (normalizeWhitespace(skill.description ?? '') !== normalizeWhitespace(expected)) return null;
  return labelFor(skill.name, t);
}
