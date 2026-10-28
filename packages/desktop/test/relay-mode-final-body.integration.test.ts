import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { expect, it } from 'vitest';
import { buildGatewayEnvironment } from '../src/main/runtime/gateway-process.js';
import { buildRelayPatch } from '../src/main/commercial/relay-config.js';

/**
 * ⭐ Cephalon 批（Task 4 复验整改·最终 HTTP body 离线捕获）。
 *
 * 目的：证明**网关模型参数合并 → OpenAI 序列化 → 最终上游 HTTP body** 这一整条产品路径上，
 * 三档 × 新旧模式任务发往 `glm-5.3-flash` 的请求**不含 `enable_search` 字段**（完全缺失，
 * 不是 false），并用**同一路径**捕获旧 Qwen 的 `enable_search=true` 正对照（证明接收器
 * 覆盖了注入环节）、PPT 新渠道 body。
 *
 * 做法（不手写序列化器、不另建服务、不换 SDK）：
 *   · 运行时 = **实际交付的随包 runtime**（`openclaw.mjs agent --local`，内嵌一轮，经其
 *     既有模型参数合并与 OpenAI 序列化路径出站）——由 `RY_FINAL_BODY_RUNTIME` 指向
 *     `node_modules/openclaw` 目录，缺省跳过（默认套件不受影响）；
 *   · 配置 = 现有 `buildRelayPatch` 生成（旧盘夹具带旧 Qwen 搜索配置，webSearch:true），
 *     唯一改动 = 把 provider baseUrl 重定向到本测试的 **127.0.0.1 接收器**；
 *   · 接收器按 `body.stream` 回最小 OpenAI 响应；记录每次 /chat/completions 的**最终 body**；
 *   · 旧任务 = 同一会话先跑旧模型（qwen3.7-flash，正对照），再切到 GLM 跑（正常切换路径）。
 *
 * 本测试**不调用付费模型**（接收器本地应答）、不连公网、不碰生产配置/账本。
 * 真实上游效果、GLM 档位强度生效仍属 Task 5 门槛（见计划 §Task 4/5）。
 */

const runtimeOpenclaw = process.env.RY_FINAL_BODY_RUNTIME;
const outFile = process.env.RY_FINAL_BODY_OUT;

interface CapturedRequest {
  path: string;
  body: Record<string, unknown>;
}

/**
 * 目录等价夹具（形状 = relay `/v1/catalog` 的 `providers[].models[]`，clawrouter 扩展
 * `parseCatalogModel` 的必填项：id/upstream；能力声明走 `capabilities: ['llm.chat']` ⇒
 * openai-compatible 直连路由；思考档声明走 `supportedReasoningEfforts`）。
 */
const CATALOG_MODELS = [
  {
    id: 'glm-5.3-flash',
    displayName: 'GLM 5.3 Flash',
    upstream: 'glm-5.3-flash',
    capabilities: ['llm.chat'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'deepseek-v4-flash-cephalon',
    displayName: 'DeepSeek V4 Flash · Cephalon',
    upstream: 'deepseek-v4-flash',
    capabilities: ['llm.chat'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    upstream: 'deepseek-v4-flash',
    capabilities: ['llm.chat'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'qwen3.7-flash',
    displayName: 'Qwen3.7 Flash',
    upstream: 'qwen3.7-flash',
    capabilities: ['llm.chat', 'llm.search'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'qwen-turbo',
    displayName: 'Qwen Turbo',
    upstream: 'qwen-turbo',
    capabilities: ['llm.chat'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    id: 'qwen-plus',
    displayName: 'Qwen Plus',
    upstream: 'qwen-plus',
    capabilities: ['llm.chat'],
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
] as const;

function catalogResponse(): Record<string, unknown> {
  return {
    providers: [
      {
        id: 'bailian',
        displayName: '百炼',
        openaiCompatible: true,
        nativeBaseUrl: '/v1/native/bailian',
        routes: [],
        models: CATALOG_MODELS.map((model) => ({
          id: model.id,
          displayName: model.displayName,
          upstream: model.upstream,
          capabilities: [...model.capabilities],
          supportedReasoningEfforts: [...model.efforts],
          pricing: { maxInputTokens: 128000, defaultMaxOutputTokens: 8192 },
        })),
      },
    ],
  };
}

function startReceiver(): Promise<{
  port: number;
  captured: CapturedRequest[];
  requestLog: string[];
  close: () => Promise<void>;
}> {
  const captured: CapturedRequest[] = [];
  const requestLog: string[] = [];
  const server = http.createServer((req, res) => {
    requestLog.push(`${req.method} ${req.url}`);
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let parsed: Record<string, unknown> = {};
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        parsed = { __raw: raw.slice(0, 200) };
      }
      if (req.url?.includes('/chat/completions')) {
        captured.push({ path: req.url, body: parsed });
        if (parsed.stream === true) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          res.write(
            `data: ${JSON.stringify({
              id: 'cmpl-local',
              object: 'chat.completion.chunk',
              created: 0,
              model: parsed.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: 'local-ok' } }],
            })}\n\n`,
          );
          res.write(
            `data: ${JSON.stringify({
              id: 'cmpl-local',
              object: 'chat.completion.chunk',
              created: 0,
              model: parsed.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'cmpl-local',
              object: 'chat.completion',
              created: 0,
              model: parsed.model,
              choices: [{ index: 0, message: { role: 'assistant', content: 'local-ok' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          );
        }
        return;
      }
      if (req.url?.includes('/catalog')) {
        // clawrouter 扩展的目录发现端点（模型清单/能力/思考档声明的真身来源）。
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(catalogResponse()));
        return;
      }
      if (req.url?.includes('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `unhandled ${req.url}` } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({
        port,
        captured,
        requestLog,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

/** RFC 7386 JSON merge patch 的最小子集（null 删键 / 对象递归 / 其余替换）。 */
function applyMergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
      continue;
    }
    const current = out[key];
    if (
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof current === 'object' &&
      current !== null &&
      !Array.isArray(current)
    ) {
      out[key] = applyMergePatch(current as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

it.runIf(Boolean(runtimeOpenclaw))(
  '三档 × 新旧任务 / PPT 新渠道的最终 HTTP body：钉 GLM 且不含 enable_search（Qwen 正对照同路径）',
  async () => {
    const openclawDir = path.resolve(runtimeOpenclaw!);
    const cli = path.join(openclawDir, 'openclaw.mjs');
    expect(fs.existsSync(cli), `openclaw.mjs 不存在：${cli}`).toBe(true);

    const receiver = await startReceiver();
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ry-final-body-state-'));
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ry-final-body-work-'));
    try {
      // ── ① 旧盘夹具（升级存量盘形态：旧默认 + 旧 Qwen 搜索配置）──
      const oldDiskConfig: Record<string, unknown> = {
        agents: {
          defaults: {
            skipBootstrap: true,
            heartbeat: { every: '0m' },
            model: { primary: 'clawrouter/qwen3.7-flash' },
            // 运行时把 legacy `agents.defaults.models`（我们用来挂 enable_search 参数）当
            // 覆盖允许名单；CLI 的 `--model` 覆盖需要 modelPolicy.allow 放行（生产链走
            // sessions.patch，不经过这个 CLI 门——这是捕获夹具的等价放行）。
            modelPolicy: { allow: ['clawrouter/*'] },
          },
        },
        models: {
          providers: {
            clawrouter: {
              baseUrl: 'https://old-relay.invalid/relay',
              apiKey: 'rly_old_fixture_only',
              headers: {},
              // 目录在真机上是网关侧拉取后注入；离线夹具按同样形状声明模型清单
              //（name 为 schema 必填；reasoning + compat.supportedReasoningEfforts 镜像
              //  目录的 supportedThinkingLevels 声明——三档只发 low/high/max）。
              models: [
                {
                  id: 'glm-5.3-flash',
                  name: 'GLM 5.3 Flash',
                  reasoning: true,
                  compat: { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
                  contextWindow: 128000,
                  maxTokens: 8192,
                  input: ['text'],
                },
                {
                  id: 'deepseek-v4-flash-cephalon',
                  name: 'DeepSeek V4 Flash · Cephalon',
                  reasoning: true,
                  compat: { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
                  contextWindow: 128000,
                  maxTokens: 8192,
                  input: ['text'],
                },
                {
                  id: 'deepseek-v4-flash',
                  name: 'DeepSeek V4 Flash',
                  reasoning: true,
                  compat: { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
                  contextWindow: 128000,
                  maxTokens: 8192,
                  input: ['text'],
                },
                {
                  id: 'qwen3.7-flash',
                  name: 'Qwen3.7 Flash',
                  reasoning: true,
                  compat: { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
                  contextWindow: 128000,
                  maxTokens: 8192,
                  input: ['text'],
                },
                {
                  id: 'qwen-turbo',
                  name: 'Qwen Turbo',
                  reasoning: true,
                  compat: { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
                  contextWindow: 128000,
                  maxTokens: 8192,
                  input: ['text'],
                },
                {
                  id: 'qwen-plus',
                  name: 'Qwen Plus',
                  reasoning: true,
                  compat: { supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
                  contextWindow: 128000,
                  maxTokens: 8192,
                  input: ['text'],
                },
              ],
            },
          },
        },
      };

      // ── ② 配置由现有 buildRelayPatch 生成（webSearch:true ⇒ 白名单 Qwen 注入 enable_search）──
      const patch = buildRelayPatch({
        relayKey: 'rly_harness_final_body',
        deviceFingerprint: 'fp-harness',
        webSearch: true,
        existingConfig: oldDiskConfig as never,
      });
      expect(patch, 'buildRelayPatch 必须返回补丁（夹具给了 key）').not.toBeNull();
      const merged = applyMergePatch(oldDiskConfig, patch as Record<string, unknown>);
      // 唯一改动：指向本地接收器（apiKey/models/搜索参数全部保持 buildRelayPatch 的产物）。
      const provider = ((merged.models as Record<string, unknown>).providers as Record<string, unknown>)
        .clawrouter as Record<string, unknown>;
      provider.baseUrl = `http://127.0.0.1:${receiver.port}/v1`;
      expect(provider.apiKey, 'patch 必须带着 relay key').toBe('rly_harness_final_body');
      const defaultModels = ((merged.agents as Record<string, unknown>).defaults as Record<string, unknown>)
        .models as Record<string, unknown>;
      expect(
        (defaultModels['clawrouter/qwen3.7-flash'] as { params: { extra_body: { enable_search: boolean } } }).params
          .extra_body.enable_search,
        '正对照前提：白名单 Qwen 的 enable_search 由 buildRelayPatch 注入',
      ).toBe(true);
      expect(defaultModels['clawrouter/glm-5.3-flash'], 'GLM 不得有搜索参数').toBeUndefined();

      const configPath = path.join(stateDir, 'openclaw.json');
      fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));

      // ── ③ 驱动 CLI：openclaw agent --local（内嵌，无网关进程）──
      const productionEnv = { ...process.env };
      for (const key of Object.keys(productionEnv)) {
        if (key === 'VITEST' || key.startsWith('VITEST_') || key === 'NODE_ENV') delete productionEnv[key];
        // 本机可能配着 Clash 代理（含 127.0.0.1:7897）：子进程必须直连本地接收器，
        // 不能把 loopback 请求走代理（否则收不到、5s 超时）。
        if (/^(https?|all|no)_proxy$/i.test(key)) delete productionEnv[key];
      }
      const baseEnv = buildGatewayEnvironment(productionEnv, stateDir);
      baseEnv.OPENCLAW_CONFIG_PATH = configPath;
      // ⚠️ buildGatewayEnvironment 会从 Windows 注册表**重新继承系统代理**（本机 Clash）——
      // 会把 loopback 请求也送进代理，接收器永远收不到。测试里剥掉代理键（产品链路
      // 走公网 relay，不受此影响；这是测试基建对"本地接收器"的必要修正）。
      for (const key of Object.keys(baseEnv)) {
        if (/^(https?|all)_proxy$/i.test(key)) delete baseEnv[key];
      }

      // ⚠️ 必须**异步** spawn：接收器与测试同线程，`spawnSync` 会把事件循环锁死，
      // 接收器 5 秒内无法处理任何请求（实测 = CLI fetch timeout、接收器零请求）。
      const runAgent = (args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> =>
        new Promise((resolve) => {
          const child = spawn(process.execPath, [cli, 'agent', '--local', ...args], {
            env: baseEnv,
            cwd: workDir,
            windowsHide: true,
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
          const timer = setTimeout(() => child.kill(), 120000);
          child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ status: code, stdout, stderr });
          });
        });

      const capturedBodies: Array<{ label: string; body: Record<string, unknown> }> = [];
      const runAndCapture = async (label: string, args: string[]): Promise<Record<string, unknown>> => {
        const before = receiver.captured.length;
        const result = await runAgent(args);
        const fresh = receiver.captured.slice(before);
        const envProbe = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy']
          .map((key) => (baseEnv[key] !== undefined ? `${key}=${String(baseEnv[key]).slice(0, 60)}` : null))
          .filter(Boolean)
          .join(' ; ');
        expect(
          result.status,
          `${label} 非零退出\nstderr: ${result.stderr.slice(0, 2000)}\nreceived: ${receiver.requestLog.slice(before).join(' | ') || '<none>'}\nenvProbe: ${envProbe || '<no-proxy-keys>'} port=${receiver.port}`,
        ).toBe(0);
        const withModel = fresh.filter((entry) => typeof entry.body.model === 'string');
        expect(withModel.length, `${label} 应产生 ≥1 次 /chat/completions，实际 ${fresh.length}`).toBeGreaterThan(0);
        const body = withModel[withModel.length - 1]!.body;
        capturedBodies.push({ label, body });
        return body;
      };

      const modes = [
        { mode: 'fast', level: 'low' },
        { mode: 'smart', level: 'high' },
        { mode: 'deep', level: 'max' },
      ] as const;

      // 旧任务：同一会话先跑旧模型（正对照），再走正常切换路径换到 GLM。
      const qwenControls: Record<string, unknown>[] = [];
      for (const { mode, level } of modes) {
        const sessionKey = `agent:main:ryfb-old-${mode}`;
        qwenControls.push(
          await runAndCapture(`old-qwen-${mode}`, [
            '--session-key',
            sessionKey,
            '--model',
            'clawrouter/qwen3.7-flash',
            '--thinking',
            level,
            '-m',
            'ping',
          ]),
        );
        await runAndCapture(`glm-switched-${mode}`, [
          '--session-key',
          sessionKey,
          '--model',
          'clawrouter/glm-5.3-flash',
          '--thinking',
          level,
          '-m',
          'ping',
        ]);
      }
      // 新任务：全新会话直接 GLM。
      for (const { mode, level } of modes) {
        await runAndCapture(`glm-new-${mode}`, [
          '--session-key',
          `agent:main:ryfb-new-${mode}`,
          '--model',
          'clawrouter/glm-5.3-flash',
          '--thinking',
          level,
          '-m',
          'ping',
        ]);
      }
      // PPT 新渠道。
      await runAndCapture('cephalon-ppt', [
        '--session-key',
        'agent:main:ryfb-ppt',
        '--model',
        'clawrouter/deepseek-v4-flash-cephalon',
        '--thinking',
        'high',
        '-m',
        'ping',
      ]);

      // ── ④ 断言（脱敏输出；apiKey 从不进入 body/报告）──
      const glmBodies = capturedBodies.filter((entry) => entry.label.startsWith('glm-'));
      expect(glmBodies).toHaveLength(6); // 三档 × 新旧任务
      for (const { label, body } of glmBodies) {
        expect(body.model, label).toBe('glm-5.3-flash');
        expect(body, `${label}: enable_search 必须完全缺失`).not.toHaveProperty('enable_search');
      }
      for (const body of qwenControls) {
        expect(body.model).toBe('qwen3.7-flash');
        expect(body.enable_search, 'Qwen 正对照：同一路径必须能捕获 enable_search=true').toBe(true);
      }
      const cephalon = capturedBodies.find((entry) => entry.label === 'cephalon-ppt')!;
      expect(cephalon.body.model).toBe('deepseek-v4-flash-cephalon');
      expect(cephalon.body).not.toHaveProperty('enable_search');

      // 思考档映射：以**实际运行时映射**为准（2026.9.3 实测 = `reasoning_effort: low/high/max`
      // 进最终 body；字段名/值随运行时版本，报告落盘供审）。
      const thinkingFields: Record<string, unknown> = {};
      for (const { mode, level } of modes) {
        const body = capturedBodies.find((entry) => entry.label === `glm-new-${mode}`)!.body;
        const interesting = Object.fromEntries(
          Object.entries(body).filter(([key]) => /think|reason|effort|budget/i.test(key)),
        );
        thinkingFields[mode] = interesting;
        expect(body.reasoning_effort, `${mode} 档的思考映射`).toBe(level);
      }

      const report = {
        runtime: { cli, version: '2026.9.3 (1391f7c)' },
        receiverPort: receiver.port,
        bodies: capturedBodies.map(({ label, body }) => ({
          label,
          model: body.model,
          hasEnableSearch: Object.prototype.hasOwnProperty.call(body, 'enable_search'),
          enableSearchValue: body.enable_search ?? null,
          thinking: Object.fromEntries(Object.entries(body).filter(([key]) => /think|reason|effort|budget/i.test(key))),
        })),
        thinkingFields,
      };
      const serialized = JSON.stringify(report, null, 2);
      // 证据输出（脱敏：仅模型/开关/思考字段；console 在本仓库测试里不受 no-console 限制）
      console.log(`[ry-final-body] ${serialized}`);
      if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, serialized);
      }
    } finally {
      await receiver.close();
      fs.rmSync(stateDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  },
  600000,
);
