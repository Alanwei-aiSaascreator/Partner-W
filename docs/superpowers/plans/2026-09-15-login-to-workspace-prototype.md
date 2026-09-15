# Login-to-Workspace Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build one polished, self-contained HTML prototype that demonstrates the complete Rongying Cube journey from phone login through purpose selection, activation, in-workspace service preparation, assistant onboarding, a simulated task, and remaining-usage review.

**Architecture:** Create a single HTML deliverable with embedded CSS, SVG mascot, semantic page sections, and a small deterministic state machine. Add a Node contract verifier outside the deliverable so required screens, labels, model consistency, remaining-quota language, and reduced-motion support can be checked without a live backend.

**Tech Stack:** HTML5, CSS custom properties, inline SVG, vanilla JavaScript, Node.js built-in `assert`, in-app browser visual verification.

---

## File structure

- Create `docs/prototypes/rongying-cube-login-to-workspace-v2.html`: the only user-facing prototype artifact; owns visual tokens, screens, mascot, mock data, and interactions.
- Create `scripts/verify-login-to-workspace-prototype.mjs`: a small read-only contract check for required screens and cross-screen consistency.
- Read `docs/superpowers/specs/2026-09-15-login-to-workspace-experience-design.md`: source of truth for accepted experience decisions.
- Read `F:/edge doenloads/royin-usb-login-v5-final.html`: visual and mascot-motion reference only; do not modify it.

### Task 1: Add the prototype contract test

**Files:**

- Create: `scripts/verify-login-to-workspace-prototype.mjs`
- Test: `scripts/verify-login-to-workspace-prototype.mjs`

- [ ] **Step 1: Write the failing contract verifier**

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prototypePath = path.join(repoRoot, 'docs', 'prototypes', 'rongying-cube-login-to-workspace-v2.html');
const html = await readFile(prototypePath, 'utf8');

const requiredScreens = ['login', 'purpose', 'activation', 'workspace', 'assistant', 'usage'];
for (const screen of requiredScreens) {
  assert.match(html, new RegExp(`id=["']screen-${screen}["']`), `missing ${screen} screen`);
}

for (const phrase of [
  '登录荣盈魔方',
  '你主要想用它做什么',
  '激活并进入工作台',
  '正在准备你的 AI 工作台',
  'deepseek-v4-flash',
  '剩余点数',
  '本次消耗',
  '重新尝试',
]) {
  assert.ok(html.includes(phrase), `missing required copy: ${phrase}`);
}

for (const assistant of ['罗盘助手', '内容创作', '电商运营', '生活家庭', '高效办公', '学习研究', '拍摄剪辑']) {
  assert.ok(html.includes(assistant), `missing assistant: ${assistant}`);
}

assert.match(html, /window\.addEventListener\(['"]pointermove['"]/, 'mascot pointer tracking missing');
assert.match(html, /mode-code/, 'verification-code eye-cover state missing');
assert.match(html, /prefers-reduced-motion:\s*reduce/, 'reduced-motion fallback missing');
assert.doesNotMatch(html, />[^<]*(gateway|端口|容器)[^<]*</i, 'technical copy leaked into visible UI');

console.log('Login-to-workspace prototype contract passed.');
```

- [ ] **Step 2: Run the verifier and confirm the expected failure**

Run:

```powershell
node scripts/verify-login-to-workspace-prototype.mjs
```

Expected: `ENOENT` for `docs/prototypes/rongying-cube-login-to-workspace-v2.html`.

- [ ] **Step 3: Commit the failing contract**

```powershell
git add scripts/verify-login-to-workspace-prototype.mjs
git commit -m "test(prototype): define login workspace flow contract"
```

### Task 2: Build the visual shell and complete screen structure

**Files:**

- Create: `docs/prototypes/rongying-cube-login-to-workspace-v2.html`
- Test: `scripts/verify-login-to-workspace-prototype.mjs`

- [ ] **Step 1: Create the document, tokens, and state containers**

The document must be self-contained and begin with this structure:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>荣盈魔方 · 登录到工作台交互预览</title>
    <style>
      :root {
        --brand-deep: #090711;
        --nav: #13131c;
        --nav-raised: #1a1a25;
        --paper: #ffffff;
        --canvas: #f4f3ef;
        --ink: #16131d;
        --muted: #777281;
        --line: #e9e6ec;
        --purple: #8d28df;
        --pink: #e11a72;
        --red: #ff3658;
        --orange: #ff7a34;
        --brand-gradient: linear-gradient(96deg, #a319ba 0%, #e3197d 34%, #ff3658 66%, #ff7d34 100%);
        --shadow: 0 18px 48px rgb(22 19 29 / 12%);
      }
      * {
        box-sizing: border-box;
      }
      html,
      body {
        min-height: 100%;
        margin: 0;
      }
      body {
        background: var(--canvas);
        color: var(--ink);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
      }
      button,
      input,
      textarea {
        font: inherit;
      }
      button {
        cursor: pointer;
      }
      .screen {
        display: none;
        min-height: 100vh;
      }
      .screen.is-active {
        display: flex;
      }
      @media (prefers-reduced-motion: reduce) {
        *,
        *::before,
        *::after {
          scroll-behavior: auto !important;
          transition-duration: 0.01ms !important;
          animation-duration: 0.01ms !important;
          animation-iteration-count: 1 !important;
        }
      }
    </style>
  </head>
  <body>
    <div class="prototype-badge">交互设计预览 · 数据均为模拟</div>
    <main id="app">
      <section class="screen is-active" id="screen-login" aria-labelledby="login-title"></section>
      <section class="screen" id="screen-purpose" aria-labelledby="purpose-title"></section>
      <section class="screen" id="screen-activation" aria-labelledby="activation-title"></section>
      <section class="screen" id="screen-workspace" aria-labelledby="workspace-title"></section>
      <section class="screen" id="screen-assistant" aria-labelledby="assistant-title"></section>
      <section class="screen" id="screen-usage" aria-labelledby="usage-title"></section>
    </main>
  </body>
</html>
```

- [ ] **Step 2: Add the split login and guided onboarding layouts**

Implement:

- A 44% dark brand panel and 56% light form panel at desktop widths.
- A compact top brand row with device-service status.
- A login form with phone and six-digit code fields, agreement checkbox, inline validation, and one primary action at each phase.
- Purpose cards for six approved use cases; one selected at a time.
- Activation form with demo code `RYMF-2026-DEMO`, account-binding explanation, and remaining-balance preview.

Use real button labels from the spec and do not add identity, role, team, marketplace, creator-center, or game modules.

- [ ] **Step 3: Add the three-column workspace layouts**

Implement one reusable shell in both `screen-workspace` and `screen-assistant`:

```html
<div class="workspace-shell">
  <nav class="primary-nav" aria-label="主要导航"></nav>
  <aside class="assistant-rail" aria-label="助手列表"></aside>
  <section class="workspace-content"></section>
</div>
```

The loading version contains a large readiness panel in the conversation region and a disabled composer. The ready version contains an assistant-specific welcome, four task suggestions, model selector, file-scope button, and composer.

- [ ] **Step 4: Run formatting and the contract verifier**

Run:

```powershell
pnpm exec prettier --write docs/prototypes/rongying-cube-login-to-workspace-v2.html scripts/verify-login-to-workspace-prototype.mjs
node scripts/verify-login-to-workspace-prototype.mjs
```

Expected: contract still fails only for interactions and required dynamic copy not yet added in Task 3.

- [ ] **Step 5: Commit the visual shell**

```powershell
git add docs/prototypes/rongying-cube-login-to-workspace-v2.html
git commit -m "feat(prototype): build login workspace visual shell"
```

### Task 3: Implement the mascot and onboarding interactions

**Files:**

- Modify: `docs/prototypes/rongying-cube-login-to-workspace-v2.html`
- Test: `scripts/verify-login-to-workspace-prototype.mjs`

- [ ] **Step 1: Add the inline SVG mascot and its named parts**

Create one inline SVG with stable identifiers used by CSS and JavaScript:

```html
<svg class="mascot" id="mascot" viewBox="0 0 360 300" role="img" aria-label="荣盈魔方品牌角色">
  <g id="character">
    <rect x="84" y="58" width="192" height="205" rx="58" fill="#251634" stroke="url(#mascot-edge)" stroke-width="4" />
    <g class="face-eye" id="eye-left">
      <ellipse cx="144" cy="150" rx="19" ry="23" fill="#fff" />
      <circle class="pupil" id="pupil-left" cx="144" cy="151" r="8.5" fill="#17101e" />
    </g>
    <g class="face-eye" id="eye-right">
      <ellipse cx="216" cy="150" rx="19" ry="23" fill="#fff" />
      <circle class="pupil" id="pupil-right" cx="216" cy="151" r="8.5" fill="#17101e" />
    </g>
    <path d="M166 197q14 12 28 0" fill="none" stroke="#ff9874" stroke-width="5" stroke-linecap="round" />
    <g class="cover-hand" id="cover-left"><ellipse cx="143" cy="151" rx="30" ry="26" fill="#321f48" /></g>
    <g class="cover-hand" id="cover-right"><ellipse cx="217" cy="151" rx="30" ry="26" fill="#321f48" /></g>
  </g>
</svg>
```

Define `mascot-edge` and hand gradients in `<defs>`. Add decorative details only inside the mascot; do not add additional floating page ornaments.

- [ ] **Step 2: Implement pointer tracking, blinking, and code-cover state**

```js
const mascot = document.querySelector('#mascot');
const pupils = [...document.querySelectorAll('.pupil')];
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

function trackPointer(event) {
  if (reduceMotion.matches || !mascot || !mascot.closest('.is-active')) return;
  const rect = mascot.getBoundingClientRect();
  const dx = Math.max(-1, Math.min(1, (event.clientX - (rect.left + rect.width / 2)) / 260));
  const dy = Math.max(-1, Math.min(1, (event.clientY - (rect.top + rect.height / 2)) / 220));
  for (const pupil of pupils) pupil.style.transform = `translate(${dx * 6}px, ${dy * 5}px)`;
}

window.addEventListener('pointermove', trackPointer, { passive: true });
document.querySelector('#login-code').addEventListener('focus', () => mascot.classList.add('mode-code'));
document.querySelector('#login-code').addEventListener('blur', () => mascot.classList.remove('mode-code'));

function scheduleBlink() {
  window.setTimeout(
    () => {
      if (!reduceMotion.matches && !mascot.classList.contains('mode-code')) {
        mascot.classList.add('is-blinking');
        window.setTimeout(() => mascot.classList.remove('is-blinking'), 110);
      }
      scheduleBlink();
    },
    2600 + Math.random() * 2800,
  );
}
scheduleBlink();
```

- [ ] **Step 3: Implement the onboarding state machine**

```js
const state = {
  phone: '',
  demoCode: '',
  purpose: 'content',
  activationCode: 'RYMF-2026-DEMO',
  model: 'deepseek-v4-flash',
  remaining: 5020,
  loadingRun: 0,
};

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((screen) => {
    screen.classList.toggle('is-active', screen.id === `screen-${name}`);
  });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function issueDemoCode() {
  state.demoCode = String(Math.floor(100000 + Math.random() * 900000));
  document.querySelector('#demo-code-hint').textContent = `演示验证码：${state.demoCode}`;
  document.querySelector('#login-code').value = state.demoCode;
}

function choosePurpose(button) {
  state.purpose = button.dataset.purpose;
  document.querySelectorAll('[data-purpose]').forEach((item) => item.classList.toggle('is-selected', item === button));
  document.querySelector('#purpose-recommendation').textContent = `将优先为你准备${button.dataset.assistant}`;
}
```

Validate an 11-digit phone, six-digit code, checked agreement, and non-empty activation code. Keep entered values on errors. Login success moves to `purpose`, purpose continue moves to `activation`, and successful activation moves to `workspace`.

- [ ] **Step 4: Run the verifier and manually exercise onboarding**

Run:

```powershell
node scripts/verify-login-to-workspace-prototype.mjs
```

Expected: `Login-to-workspace prototype contract passed.`

Then open the file through a local server and confirm phone focus, code focus, mascot state, purpose selection, and activation transitions.

- [ ] **Step 5: Commit onboarding interactions**

```powershell
git add docs/prototypes/rongying-cube-login-to-workspace-v2.html scripts/verify-login-to-workspace-prototype.mjs
git commit -m "feat(prototype): add guided onboarding interactions"
```

### Task 4: Implement service readiness, assistants, and simulated task completion

**Files:**

- Modify: `docs/prototypes/rongying-cube-login-to-workspace-v2.html`
- Test: `scripts/verify-login-to-workspace-prototype.mjs`

- [ ] **Step 1: Define assistant-specific data**

```js
const assistants = {
  compass: {
    name: '罗盘助手',
    description: '描述目标，我会帮你选择合适的助手和模型。',
    prompts: ['整理电脑文件', '写一份活动方案', '分析一组资料', '规划本周任务'],
  },
  content: {
    name: '内容创作',
    description: '从选题到成稿，完成文案、脚本与内容改写。',
    prompts: ['写短视频开头', '生成公众号提纲', '改写产品故事', '拆解一个选题'],
  },
  commerce: {
    name: '电商运营',
    description: '围绕商品、活动和客户沟通推进经营任务。',
    prompts: ['生成商品卖点', '设计促销活动', '整理差评原因', '写客服回复'],
  },
  life: {
    name: '生活家庭',
    description: '把出行、采购、家庭计划和日常事务整理清楚。',
    prompts: ['制定旅行计划', '生成一周菜单', '整理采购清单', '规划家庭预算'],
  },
  office: {
    name: '高效办公',
    description: '处理文档、会议、表格和工作汇报。',
    prompts: ['整理会议纪要', '生成周报', '分析表格', '润色邮件'],
  },
  research: {
    name: '学习研究',
    description: '梳理资料、比较观点并形成可验证的结论。',
    prompts: ['总结一份论文', '制作学习计划', '对比两个观点', '整理研究笔记'],
  },
  video: {
    name: '拍摄剪辑',
    description: '完成脚本、分镜、镜头清单与剪辑节奏设计。',
    prompts: ['生成拍摄脚本', '制作分镜表', '整理镜头清单', '优化剪辑节奏'],
  },
};
```

- [ ] **Step 2: Implement semantic readiness progress and retry**

```js
const readinessSteps = [
  { label: '连接 AI 服务', progress: 22 },
  { label: '准备默认模型', progress: 48 },
  { label: '加载专业助手', progress: 76 },
  { label: '工作台已就绪', progress: 100 },
];

function runReadiness() {
  const run = ++state.loadingRun;
  document.querySelector('#readiness-retry').hidden = true;
  readinessSteps.forEach((step, index) => {
    window.setTimeout(() => {
      if (run !== state.loadingRun) return;
      document.querySelector('#readiness-label').textContent = step.label;
      document.querySelector('#readiness-value').textContent = `${step.progress}%`;
      document.querySelector('#readiness-bar').style.width = `${step.progress}%`;
      if (step.progress === 100) window.setTimeout(() => showScreen('assistant'), 500);
    }, index * 850);
  });
}

document.querySelector('#readiness-retry').addEventListener('click', runReadiness);
```

Include a visible accelerated-demo note. Add a “模拟等待超过 90 秒” control that reveals the explanation, `重新尝试`, and `查看详情` states without forcing an actual 90-second wait.

- [ ] **Step 3: Implement assistant switching, model consistency, and task result**

On assistant selection, update the title, description, prompts, placeholder, and active navigation row from the same `assistants` object. Use a single `state.model` value for selector, response label, top summary, and usage ledger.

Submitting a task must render these semantic stages in one compact activity group:

```js
const taskStages = ['理解任务', '查看已授权资料', '组织结果'];
```

Then reveal a simulated answer, result location, open-folder action, remaining balance, and this-run consumption. Deduct a deterministic `18` points so the review is repeatable.

- [ ] **Step 4: Build the remaining-usage screen**

The screen must show:

- `剩余点数 5,002` after one simulated task.
- A progress bar whose width equals `remaining / total`, labeled `本周期还可使用`.
- A ledger row containing the same selected model, input/output token counts, and `本次消耗 18 点`.
- A primary action to return to the assistant and a secondary action to replay the full flow.

- [ ] **Step 5: Run contract and format checks**

Run:

```powershell
pnpm exec prettier --check docs/prototypes/rongying-cube-login-to-workspace-v2.html scripts/verify-login-to-workspace-prototype.mjs
node scripts/verify-login-to-workspace-prototype.mjs
```

Expected: both commands exit `0`.

- [ ] **Step 6: Commit the complete flow**

```powershell
git add docs/prototypes/rongying-cube-login-to-workspace-v2.html scripts/verify-login-to-workspace-prototype.mjs
git commit -m "feat(prototype): complete login to workspace review flow"
```

### Task 5: Visual, interaction, and accessibility verification

**Files:**

- Modify if needed: `docs/prototypes/rongying-cube-login-to-workspace-v2.html`
- Test: `scripts/verify-login-to-workspace-prototype.mjs`

- [ ] **Step 1: Start a local static server**

Run:

```powershell
python -m http.server 55472 --bind 127.0.0.1 --directory docs/prototypes
```

Expected: server reports `Serving HTTP on 127.0.0.1 port 55472`.

- [ ] **Step 2: Complete the happy path in the in-app browser**

Open `http://127.0.0.1:55472/rongying-cube-login-to-workspace-v2.html` and verify:

1. Login with a generated demo code.
2. Select `内容创作`.
3. Activate with `RYMF-2026-DEMO`.
4. Observe the real shell while readiness progresses.
5. Enter the content assistant.
6. Switch from `deepseek-v4-flash` to another model and back.
7. Submit one task.
8. Open remaining usage.
9. Confirm model and cost labels match.

- [ ] **Step 3: Verify error and recovery states**

Check invalid phone, unchecked agreement, wrong code, blank activation, simulated 90-second timeout, retry, and replay flow. Expected: no state clears user input unexpectedly and each error offers a next action.

- [ ] **Step 4: Verify desktop scaling and reduced motion**

Inspect at 1440×900 and 1280×720. Expected: no horizontal scroll, composer remains visible, and the purpose grid does not collapse below readable widths. Emulate reduced motion and confirm pupils remain static while focus-driven eye-cover state still communicates privacy.

- [ ] **Step 5: Inspect browser logs and run final checks**

Run:

```powershell
node scripts/verify-login-to-workspace-prototype.mjs
pnpm exec prettier --check docs/prototypes/rongying-cube-login-to-workspace-v2.html scripts/verify-login-to-workspace-prototype.mjs
git diff --check
```

Expected: contract passes, formatting passes, no browser console errors, and `git diff --check` prints nothing.

- [ ] **Step 6: Commit any verification fixes**

```powershell
git add docs/prototypes/rongying-cube-login-to-workspace-v2.html scripts/verify-login-to-workspace-prototype.mjs
git commit -m "fix(prototype): polish verified review experience"
```
