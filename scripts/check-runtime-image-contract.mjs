#!/usr/bin/env node
/**
 * **真实运行时**的图像接线合同检查。
 *
 * 这一条测的不是我们的代码，而是**我们与运行时之间那份合约**：
 *   写进 `openclaw.json` 的那三个键，运行时认不认、认成什么、以及它**打给谁**。
 * 单测验不了这个 —— 单检验的是"我以为的格式"（本仓为此栽过一次：
 * 往配置里写了一个 schema 不认的键，结果是**整份配置**被判非法）。
 *
 * 做法：真的把随包 OpenClaw 跑起来，真的让它发一次 HTTP，然后在**我们自己的本地 fake relay**
 * 上把请求抓下来看。中间没有任何 mock。
 *
 * 它验四件事：
 *   ① 请求打到 `<baseUrl>/images/generations`，且路径里带着我们给的那段 `/v1`；
 *   ② 带的凭据是**我们写进去的 relay key**，不是任何供应商 Key；
 *   ③ `n = 1` 且模型是 allowlist 里那一个；
 *   ④ 反向对照：不开 `allowPrivateNetwork` 时，本机地址会被运行时**主动拒绝**
 *      —— 证明那条闸门是真的（也说明生产为什么没事：我们的 relay 是公网 https）。
 *
 * ⚠️ 它**不在 `pnpm check` 里**（要解 439MB 的运行时包、要起真进程）。
 *    跑法：`pnpm check:runtime-image-contract`
 *    依赖：本机装了 7-Zip，且 `runtime-out/win32-x64/*.7z` 在。
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_ROOT = join(tmpdir(), 'mofang-runtime-contract');

/**
 * `runtime-out/` 是 **gitignore 的产物**，所以它只在"构建过的那份检出"里有 ——
 * 从 worktree 跑时通常不在自己脚下（worktree 在 `<主检出>/.worktrees/<名字>/`）。
 * 依次找：环境变量 → 自己脚下 → 主检出脚下。
 */
function findRuntimeOut() {
  const candidates = [
    process.env.MOFANG_RUNTIME_OUT,
    join(ROOT, 'runtime-out'),
    // worktree 在 `<主检出>/.worktrees/<名字>/` ⇒ 上两级才回到主检出。
    join(ROOT, '..', '..', 'runtime-out'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'win32-x64'))) return candidate;
  }
  return null;
}

/** 我们写进配置的那把钥匙。它**只**该出现在出站请求的 Authorization 上。 */
const RELAY_KEY = 'rly_contract_test_key_0123456789';
const IMAGE_PATH = '/v1/images/generations';
/** 供应商 Key 的**哨兵**：我们要证明它一次都没被用上。 */
const CANARY = 'canary-dashscope-key-should-never-be-used';

function findArchive() {
  const runtimeOut = findRuntimeOut();
  if (!runtimeOut) return null;
  const dir = join(runtimeOut, 'win32-x64');
  if (!existsSync(dir)) return null;
  const hit = readdirSync(dir).find((name) => name.endsWith('.7z'));
  return hit ? join(dir, hit) : null;
}

function findSevenZip() {
  for (const candidate of ['C:/Program Files/7-Zip/7z.exe', 'C:/Program Files (x86)/7-Zip/7z.exe']) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** 解包到缓存目录（`runtime-out` 里那份是 .7z，扩展名骗人但格式是 zip）。 */
function ensureExtracted(archivePath) {
  const extracted = join(CACHE_ROOT, 'unpacked');
  const marker = join(extracted, 'node_modules', 'openclaw', 'openclaw.mjs');
  if (existsSync(marker)) return extracted;

  const sevenZip = findSevenZip();
  if (!sevenZip) throw new Error('找不到 7-Zip（装一个，或改 findSevenZip 的候选路径）');
  rmSync(CACHE_ROOT, { recursive: true, force: true });
  mkdirSync(CACHE_ROOT, { recursive: true });
  console.log(`[contract] 解包运行时（第一次会慢，之后走缓存）…`);
  execFileSync(sevenZip, ['x', '-y', `-o${extracted}`, archivePath], { stdio: ['ignore', 'ignore', 'inherit'] });
  return extracted;
}

/** 一个只会做一件事的 relay：把收到的请求记下来，然后回一张假图。 */
function startFakeRelay() {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.url?.endsWith('/images/generations')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            created: Math.floor(Date.now() / 1000),
            data: [{ b64_json: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'), mime_type: 'image/png' }],
          }),
        );
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fake relay: no route' } }));
    });
  });

  return new Promise((resolvePromise) => {
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({ server, seen, port: server.address().port });
    });
  });
}

/**
 * 跑一次 `image generate`。
 *
 * ⚠️ 出站环境**照抄产品那套**（`buildGatewayEnvironment`）：把会触发"外置插件自动安装"的
 *    供应商变量摘掉，再塞哨兵 —— 于是"运行时有没有偷用供应商 Key"变成一个**可观测**的问题。
 */
function runImageGenerate({ nodeExe, cliPath, cwd, stateDir, baseUrl, allowPrivateNetwork, model }) {
  const config = {
    models: {
      providers: {
        openai: { baseUrl, apiKey: RELAY_KEY },
      },
    },
    agents: { defaults: { mediaModels: { image: { primary: model } } } },
  };
  // 反向对照那一轮刻意**不写**这个键 —— 运行时应当拒绝本机地址。
  //
  // ⚠️ 键名是 `dangerouslyAllowPrivateNetwork`，**不是** `allowPrivateNetwork`。
  //    运行时的读取函数（`isPrivateNetworkOptInEnabled`）接受好几种写法，
  //    但 **schema 只认这一个**，写别的会让**整份配置**被判非法（实测：
  //    `browser.ssrfPolicy: Unrecognized key: "allowPrivateNetwork"`）。
  //    这一条也是"别从读代码推断 schema"的现成例子。
  if (allowPrivateNetwork) config.browser = { ssrfPolicy: { dangerouslyAllowPrivateNetwork: true } };

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'openclaw.json'), JSON.stringify(config, null, 2));

  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, DASHSCOPE_API_KEY: CANARY, QWEN_API_KEY: CANARY };

  return new Promise((resolvePromise) => {
    const child = spawn(
      nodeExe,
      // ⚠️ 是 `capability image generate`，**不是** `image generate` ——
      //    后者会报 "OpenClaw does not know the command \"image\""（实测）。
      [cliPath, 'capability', 'image', 'generate', '--prompt', '一只在写代码的猫', '--model', model, '--json'],
      { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, out, err });
    });
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const archive = findArchive();
  if (!archive) {
    console.error('[contract] 找不到 runtime-out/win32-x64/*.7z —— 这条检查需要有那份运行时包。');
    process.exit(2);
  }
  const extracted = ensureExtracted(archive);
  const openclawDir = join(extracted, 'node_modules', 'openclaw');
  const cliPath = join(openclawDir, 'openclaw.mjs');
  const nodeExe = join(findRuntimeOut(), 'node', 'node.exe');

  assert(existsSync(cliPath), `运行时里没有 CLI：${cliPath}`);
  assert(existsSync(nodeExe), `运行时里没有随行 Node：${nodeExe}`);

  const { server, seen, port } = await startFakeRelay();
  const failures = [];

  try {
    // ── ① 正向：接线成立，请求形状正确 ───────────────────────────────────
    const okRun = await runImageGenerate({
      nodeExe,
      cliPath,
      cwd: openclawDir,
      stateDir: join(CACHE_ROOT, 'state-ok'),
      baseUrl: `http://127.0.0.1:${port}/v1`,
      allowPrivateNetwork: true,
      model: 'openai/qwen-image-1',
    });
    console.log(`[contract] 正向：exit=${okRun.code}`);
    if (okRun.code !== 0) console.log(okRun.err.slice(0, 1200));

    const imageCalls = seen.filter((s) => s.url?.endsWith(IMAGE_PATH));
    try {
      assert(okRun.code === 0, `image generate 应当成功，实际退出码 ${okRun.code}`);
      assert(imageCalls.length === 1, `应当正好有一次 ${IMAGE_PATH}，实际 ${imageCalls.length} 次（收到：${seen.map((s) => s.url).join(', ')}）`);
      const call = imageCalls[0];
      assert(
        call.headers.authorization === `Bearer ${RELAY_KEY}`,
        `出站凭据应当是我们写进去的 relay key，实际 ${String(call.headers.authorization)}`,
      );
      const body = JSON.parse(call.body);
      assert(body.n === 1 || body.n === undefined, `n 必须是 1（OpenAI 默认），实际 ${String(body.n)}`);
      assert(body.model === 'qwen-image-1', `模型应当是服务端 allowlist 里那个，实际 ${String(body.model)}`);
      assert(typeof body.prompt === 'string' && body.prompt.includes('猫'), 'prompt 应当原样送达');
      assert(!call.body.includes(CANARY), '请求体里不该出现供应商 Key');
      assert(!JSON.stringify(call.headers).includes(CANARY), '请求头里不该出现供应商 Key');
      // ⚠️ 断言按**实测到的真实形状**写（`capability image generate --json`）：
      //    { ok, capability, transport, provider, model, attempts, outputs:[{path,mimeType,size}] }
      //    第一版我凭想象断言"输出里有 b64_json"—— 而它回的是**落盘路径**，不是 base64。
      const payload = JSON.parse(okRun.out);
      assert(payload.ok === true, `图片生成应当成功：${okRun.out.slice(0, 400)}`);
      assert(payload.capability === 'image.generate', `capability 不对：${String(payload.capability)}`);
      assert(payload.provider === 'openai', `provider 应当是我们写进配置的那个：${String(payload.provider)}`);
      assert(payload.model === 'qwen-image-1', `model 应当是 allowlist 里那个：${String(payload.model)}`);
      assert(Array.isArray(payload.outputs) && payload.outputs.length === 1, '应当正好产出一张图');
      assert(payload.outputs[0].mimeType === 'image/png', `mimeType 不对：${String(payload.outputs[0].mimeType)}`);

      // ⭐ 图片**真的落到了磁盘**，而且进程退出之后还读得回来 ——
      //    这才是"重启后仍可打开"在运行时这一层的对应物。
      const written = payload.outputs[0].path;
      assert(existsSync(written), `运行时说产出了 ${written}，但那个文件不在`);
      assert(readFileSync(written).length === 4, '落盘的字节应当就是我们 fake relay 回的那 4 个字节');
      console.log(`[contract] ✅ 运行时把图片落到了磁盘：${written}`);
      console.log('[contract] ✅ 请求路径 / 凭据 / n=1 / 模型 / prompt 全部符合');
    } catch (error) {
      failures.push(`正向：${error.message}`);
    }

    // ── ③ 合同事实：运行时**不会**自己补 `/v1` ────────────────────────────
    //
    // 这条把"产品为什么必须写 `/v1`"变成证据而不是推断：给一个不带 `/v1` 的 baseUrl，
    // 它照样只在后面接 `/images/generations` ⇒ 打出来的是 `/images/generations`。
    // 我们的 relay 只认 `/v1/images/generations`（nginx 另外负责剥掉 `/relay`），
    // 所以 baseUrl 少一段的表现就是**404，而且不解释**。
    const noV1Before = seen.length;
    await runImageGenerate({
      nodeExe,
      cliPath,
      cwd: openclawDir,
      stateDir: join(CACHE_ROOT, 'state-no-v1'),
      baseUrl: `http://127.0.0.1:${port}`,
      allowPrivateNetwork: true,
      model: 'openai/qwen-image-1',
    });
    const noV1Calls = seen.slice(noV1Before).filter((s) => s.url?.endsWith('/images/generations'));
    try {
      assert(noV1Calls.length === 1, `不带 /v1 的那次应当也发出请求，实际 ${noV1Calls.length} 次`);
      assert(
        noV1Calls[0].url === '/images/generations',
        `运行时不该自己补 /v1（实际打到 ${String(noV1Calls[0].url)}）—— 这条要是红了，说明它其实会补，那产品那边就该去掉`,
      );
      console.log('[contract] ✅ 运行时不会自己补 /v1（产品必须自己带上，已由 relay-config 测试钉住）');
    } catch (error) {
      failures.push(`/v1 合同：${error.message}`);
    }

    // ── ② 反向对照：不开 allowPrivateNetwork，本机地址会被**运行时自己**拒掉 ──
    const before = seen.length;
    const denied = await runImageGenerate({
      nodeExe,
      cliPath,
      cwd: openclawDir,
      stateDir: join(CACHE_ROOT, 'state-denied'),
      baseUrl: `http://127.0.0.1:${port}/v1`,
      allowPrivateNetwork: false,
      model: 'openai/qwen-image-1',
    });
    try {
      assert(denied.code !== 0, '不开 allowPrivateNetwork 时本机地址应当被拒（否则那条闸门是假的）');
      assert(
        seen.length === before,
        '被拒的那次**一个请求都不该发出去** —— 发出去了说明拒绝发生在太晚的地方',
      );
      console.log('[contract] ✅ 反向对照：本机地址未被放行（闸门是真的）');
    } catch (error) {
      failures.push(`反向对照：${error.message}`);
    }
  } finally {
    server.close();
  }

  if (failures.length > 0) {
    console.error('\n[contract] ❌ 失败：');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log('\n[contract] 全部通过。');
}

await main();
