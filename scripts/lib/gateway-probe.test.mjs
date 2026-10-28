/**
 * 网关探针（队列 T-a8「网关卡死：端口在听、连接能建、**所有 RPC 超时**」的取证工具）判据测试。
 *
 * 跑：`node --test scripts/lib/gateway-probe.test.mjs`
 *
 * 为什么这个文件必须存在（不是"顺手补的测试"）：老探针（`%TEMP%/claude/gw-probe.mjs`）
 * **只打印载荷字节数** ⇒ 复发时拿不到 Codex 点名的那几类证据（见
 * `docs/plan/2026-09-20-自主任务队列.md` T-a8 段）。新探针的每一类证据在这里各有一条判据，
 * 尤其是"**没取到**"必须照实写进报告 —— 报告里留白会被后人读成"没问题"。
 *
 * ⚠️ 这个文件里的**字段名与阈值**都不是猜的，出处写在 `scripts/lib/gateway-probe.mjs` 的常量注释里
 *    （随包运行时的 `HealthSnapshotSchema` / `gateway-dispatcher.ts` 的 owner 注释）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildRpcParams,
  classifyRpcResult,
  DEFAULT_RPC_METHODS,
  diffConfigTimeline,
  filterNdjsonWindow,
  judgeProbe,
  makeRpcRunner,
  OWNER_GATED_METHODS,
  pickAgentId,
  processCpuRatio,
  readEventLoop,
  renderReport,
  summarizeEventLoop,
} from './gateway-probe.mjs';

/** 造一个"网关自报"的 eventLoop 段（只填关心的字段，其余给中性值）。 */
function loop(over = {}) {
  return {
    degraded: false,
    degradedSinceMs: null,
    reasons: [],
    intervalMs: 1000,
    delayP99Ms: 1,
    delayMaxMs: 1,
    utilization: 0.1,
    cpuCoreRatio: 0.1,
    ...over,
  };
}

/** 报告要用的最小 facts（每个测试只覆盖自己那几项）。 */
function facts(over = {}) {
  return {
    generatedAt: '2026-09-20T10:00:00.000Z',
    probe: { stateDir: 'C:\\state', configPath: 'C:\\state\\openclaw.json', port: 18789, tokenPresent: true },
    connection: { reachable: true, connectOk: true, handshakeMs: 5, challengeMs: 2 },
    owner: { agentId: 'main', source: 'defaultId', agentsCount: 9 },
    rpcs: [
      {
        method: 'health',
        paramsSummary: '{}',
        status: 'ok',
        ok: true,
        elapsedMs: 12,
        code: null,
        message: null,
        payloadBytes: 900,
      },
      {
        method: 'tools.catalog',
        paramsSummary: '{agentId:main}',
        status: 'ok',
        ok: true,
        elapsedMs: 30,
        code: null,
        message: null,
        payloadBytes: 4000,
      },
    ],
    health: {
      summary: summarizeEventLoop([
        { atMs: 0, eventLoop: loop({ delayMaxMs: 1400, degraded: true, reasons: ['event_loop_delay'] }) },
      ]),
    },
    config: { sha256: 'a'.repeat(64), size: 4096, mtimeMs: 1, timeline: [], backups: [] },
    process: { found: false, warning: '没取到端口拥有者' },
    logs: { found: false, warning: '没找到客户端调试日志' },
    warnings: ['没取到端口拥有者'],
    ...over,
  };
}

test('① 默认五个 RPC 与顺序 = T-a8 现场那五条', () => {
  assert.deepEqual(DEFAULT_RPC_METHODS, ['health', 'config.get', 'tools.catalog', 'sessions.list', 'skills.status']);
  assert.deepEqual(OWNER_GATED_METHODS, ['tools.catalog']);
  // ⚠️ OWNER_GATED_METHODS 是"必须带 owner"的**规格**，buildRpcParams 的 switch 必须逐条满足它
  //    —— 否则清单和实现会各自漂，而两条断言都还是绿的（这正是"清单不更新"那种假绿）。
  for (const method of OWNER_GATED_METHODS) {
    const params = buildRpcParams(method);
    assert.ok(
      Object.hasOwn(params, 'agentId') || Object.hasOwn(params, 'agentScope'),
      `${method} 在 OWNER_GATED_METHODS 里，但 buildRpcParams 没给它 owner`,
    );
  }
});

test('② tools.catalog 必须带 owner：有 agentId 用它，没有退回 agentScope=all，绝不发空参数', () => {
  assert.deepEqual(buildRpcParams('tools.catalog', { agentId: 'main' }), { includePlugins: true, agentId: 'main' });
  assert.deepEqual(buildRpcParams('tools.catalog'), { includePlugins: true, agentScope: 'all' });
  const noOwner = buildRpcParams('tools.catalog');
  // 两个 owner 字段一起给会被网关拒（`usage-lCaKvodi.mjs` 里那条判断）
  assert.equal(Object.hasOwn(noOwner, 'agentId'), false);
});

test('③ 另外四条不许自己加 owner；health 只在首次带 probe=true', () => {
  assert.deepEqual(buildRpcParams('config.get', { agentId: 'main' }), {});
  assert.deepEqual(buildRpcParams('sessions.list', { agentId: 'main' }), {});
  assert.deepEqual(buildRpcParams('health'), {});
  assert.deepEqual(buildRpcParams('health', { probe: true }), { probe: true });
  // skills.status 不带也能落到 ambient owner（见 gateway-skill-label.ts 的实机注释），给了就带上
  assert.deepEqual(buildRpcParams('skills.status'), {});
  assert.deepEqual(buildRpcParams('skills.status', { agentId: 'main' }), { agentId: 'main' });
});

test('④ pickAgentId 与客户端同判据：defaultId 优先，退回 agents[0].id，都没有就是没有', () => {
  assert.equal(pickAgentId({ defaultId: 'main', agents: [{ id: 'a' }] }), 'main');
  assert.equal(pickAgentId({ agents: [{ id: 'a' }, { id: 'b' }] }), 'a');
  assert.equal(pickAgentId({}), undefined);
  assert.equal(pickAgentId({ agents: [] }), undefined);
  assert.equal(pickAgentId(undefined), undefined);
});

test('⑤ readEventLoop 照抄随包运行时的 HealthSnapshotSchema 八个字段', () => {
  assert.deepEqual(
    readEventLoop({
      ts: 1,
      eventLoop: {
        degraded: true,
        degradedSinceMs: 1200,
        reasons: ['event_loop_delay', 'cpu'],
        intervalMs: 1000,
        delayP99Ms: 90,
        delayMaxMs: 986,
        utilization: 1,
        cpuCoreRatio: 0.65,
      },
    }),
    {
      degraded: true,
      degradedSinceMs: 1200,
      reasons: ['event_loop_delay', 'cpu'],
      intervalMs: 1000,
      delayP99Ms: 90,
      delayMaxMs: 986,
      utilization: 1,
      cpuCoreRatio: 0.65,
    },
  );
});

test('⑥ 没有 eventLoop 段就是没有：不去别的形状里瞎找（形状漂移要看得见）', () => {
  assert.equal(readEventLoop({ ts: 1 }), null);
  assert.equal(readEventLoop({ eventLoop: null }), null);
  assert.equal(readEventLoop(undefined), null);
  // ⚠️ 唯一权威形状是 payload.eventLoop；嵌套别的形状不许被"兼容"掉
  assert.equal(readEventLoop({ health: { eventLoop: { delayMaxMs: 1 } } }), null);
});

test('⑦ 字段缺或类型不对 ⇒ 记 null 或空数组，绝不编造 0', () => {
  const got = readEventLoop({ eventLoop: { degraded: 'yes', reasons: ['cpu', 7, null], delayMaxMs: '986' } });
  assert.equal(got.degraded, false);
  assert.deepEqual(got.reasons, ['cpu']);
  assert.equal(got.delayMaxMs, null);
  assert.equal(got.cpuCoreRatio, null);
  assert.equal(got.degradedSinceMs, null);
  assert.equal(got.intervalMs, null);
});

test('⑧ 每条 RPC 的结论分四态：timeout / ok / needs-owner / error', () => {
  assert.equal(classifyRpcResult({ status: 'TIMEOUT' }), 'timeout');
  assert.equal(classifyRpcResult({ ok: true, payload: {} }), 'ok');
  assert.equal(
    classifyRpcResult({
      ok: false,
      error: {
        code: 'INVALID_REQUEST',
        message:
          'Multiple agents are configured, but session key "main" has no explicit owner. Pass agentId or use an agent-prefixed session key.',
      },
    }),
    'needs-owner',
  );
  // 码放在 details 里（pairing 那种形状）同样要认出来
  assert.equal(
    classifyRpcResult({
      ok: false,
      error: { message: 'this Gateway request has no explicit owner', details: { code: 'INVALID_REQUEST' } },
    }),
    'needs-owner',
  );
  assert.equal(classifyRpcResult({ ok: false, error: { code: 'INVALID_REQUEST', message: 'auth denied' } }), 'error');
  assert.equal(
    classifyRpcResult({ ok: false, error: { code: 'INTERNAL', message: 'x has no explicit owner' } }),
    'error',
  );
});

test('⑨ summarizeEventLoop：峰值、去重排序的 reasons、degraded 只看收到的样本', () => {
  const s = summarizeEventLoop([
    { atMs: 0, eventLoop: null },
    {
      atMs: 1000,
      eventLoop: loop({
        delayMaxMs: 986,
        utilization: 0.9,
        cpuCoreRatio: 0.65,
        degraded: true,
        reasons: ['event_loop_delay'],
        degradedSinceMs: 500,
      }),
    },
    {
      atMs: 2000,
      eventLoop: loop({
        delayMaxMs: 1400,
        utilization: 1,
        cpuCoreRatio: 0.7,
        degraded: true,
        reasons: ['cpu', 'event_loop_delay'],
        degradedSinceMs: 1500,
      }),
    },
  ]);
  assert.equal(s.samples, 3);
  assert.equal(s.received, 2);
  assert.equal(s.present, true);
  assert.equal(s.peak.delayMaxMs, 1400);
  assert.equal(s.peak.utilization, 1);
  assert.equal(s.peak.cpuCoreRatio, 0.7);
  assert.equal(s.degradedAny, true);
  assert.deepEqual(s.reasons, ['cpu', 'event_loop_delay']);
  assert.equal(s.degradedSinceMs, 1500);
});

test('⑩ summarizeEventLoop：一条都没收到 ⇒ present=false 且峰值全 null（不是 0）', () => {
  const s = summarizeEventLoop([
    { atMs: 0, eventLoop: null },
    { atMs: 1000, eventLoop: null },
  ]);
  assert.equal(s.present, false);
  assert.equal(s.received, 0);
  assert.equal(s.samples, 2);
  assert.equal(s.degradedAny, false);
  assert.deepEqual(s.reasons, []);
  assert.equal(s.peak.delayMaxMs, null);
  assert.equal(s.peak.utilization, null);
});

test('⑪ 配置时间线：内容真变 = changed；同字节重写 = touched；没动过 = 空', () => {
  const entry = (sha256, mtimeMs, size = 100) => ({ sha256, mtimeMs, size });
  const line = diffConfigTimeline([
    { atMs: 0, entry: entry('a', 1000) },
    { atMs: 1000, entry: entry('a', 1000) },
    { atMs: 2000, entry: entry('b', 2500) },
    { atMs: 3000, entry: entry('b', 3200) },
  ]);
  assert.deepEqual(
    line.map((e) => [e.kind, e.offsetMs]),
    [
      ['baseline', 0],
      ['changed', 2000],
      ['touched', 3000],
    ],
  );
  assert.equal(line[1].sha256, 'b');
  assert.equal(diffConfigTimeline([{ atMs: 0, entry: entry('a', 1000) }]).length, 1);
  assert.deepEqual(diffConfigTimeline([]), []);
});

test('⑫ filterNdjsonWindow：按 ts 取窗口，时间戳读不出来的行单独记账', () => {
  const text = [
    JSON.stringify({ ts: '2026-09-20T10:00:00.000Z', event: 'a' }),
    'not json',
    JSON.stringify({ ts: '2026-09-20T10:00:05.000Z', event: 'b' }),
    JSON.stringify({ event: 'no-ts' }),
    '',
  ].join('\n');
  const got = filterNdjsonWindow(text, {
    fromMs: Date.parse('2026-09-20T09:59:00.000Z'),
    toMs: Date.parse('2026-09-20T10:00:02.000Z'),
  });
  assert.equal(got.keptCount, 1);
  assert.equal(got.totalCount, 4);
  assert.equal(got.skippedCount, 2);
  assert.ok(got.kept[0].includes('"a"'));
});

test('⑬ processCpuRatio：窗口内进程自己烧了几个核；样本不够就是 null', () => {
  assert.equal(
    processCpuRatio([
      { atMs: 0, cpuSeconds: 10 },
      { atMs: 1000, cpuSeconds: 11 },
    ]),
    1,
  );
  assert.equal(
    processCpuRatio([
      { atMs: 0, cpuSeconds: 10 },
      { atMs: 2000, cpuSeconds: 10.5 },
    ]),
    0.25,
  );
  assert.equal(processCpuRatio([{ atMs: 0, cpuSeconds: 10 }]), null);
  assert.equal(processCpuRatio([]), null);
  assert.equal(
    processCpuRatio([
      { atMs: 0, cpuSeconds: 10 },
      { atMs: 0, cpuSeconds: 11 },
    ]),
    null,
  );
});

test('⑭ judgeProbe 六态：没连上 / 握手没过 / 全超时 / 部分超时 / 活着 / 没跑成', () => {
  const run = (method, status) => ({ method, status });
  const conn = (over = {}) => ({ reachable: true, connectOk: true, ...over });
  assert.equal(judgeProbe({ connection: conn({ reachable: false }), rpcs: [] }).verdict, 'unreachable');
  assert.equal(
    judgeProbe({ connection: conn({ connectOk: false, error: 'auth denied' }), rpcs: [] }).verdict,
    'connect-failed',
  );
  assert.equal(
    judgeProbe({ connection: conn(), rpcs: [run('health', 'timeout'), run('config.get', 'timeout')] }).verdict,
    'stall',
  );
  assert.equal(
    judgeProbe({ connection: conn(), rpcs: [run('health', 'ok'), run('config.get', 'timeout')] }).verdict,
    'partial',
  );
  assert.equal(
    judgeProbe({ connection: conn(), rpcs: [run('health', 'ok'), run('config.get', 'ok')] }).verdict,
    'alive',
  );
  assert.equal(judgeProbe({ connection: conn(), rpcs: [] }).verdict, 'unknown');
});

test('⑮ judgeProbe 的三条附注：needs-owner 不算活着、eventLoop 缺席的含义、CPU 与"忙"不符', () => {
  const needsOwner = judgeProbe({
    connection: { reachable: true, connectOk: true },
    rpcs: [
      { method: 'health', status: 'ok' },
      { method: 'tools.catalog', status: 'needs-owner' },
    ],
    health: { summary: { present: false } },
  });
  assert.equal(needsOwner.verdict, 'alive');
  assert.ok(needsOwner.caveats.some((c) => c.includes('owner')));
  assert.ok(needsOwner.caveats.some((c) => c.includes('eventLoop')));

  const blocked = judgeProbe({
    connection: { reachable: true, connectOk: true },
    rpcs: [{ method: 'health', status: 'timeout' }],
    process: { found: true, cpuRatio: 0.01 },
  });
  assert.equal(blocked.verdict, 'stall');
  // ⚠️ 判据串必须打在**报告里真会出现的字**上：第一版这里写 `includes('CPU')`、负向那条写
  //    `includes('CPU 近乎')`，而报告里的原话是 `CPU ≈ 0.01 核（近乎不动）` —— 'CPU 近乎'
  //    永远不会出现 ⇒ 那条负向断言**恒真**（变异体 M30 就是这么把它抓出来的，见提交说明）。
  assert.ok(
    blocked.caveats.some((c) => c.includes('近乎不动')),
    'CPU 近乎不动时应当有一条附注',
  );

  // CPU 真的很高时不许说"不符"（那是另一种形态）
  const busy = judgeProbe({
    connection: { reachable: true, connectOk: true },
    rpcs: [{ method: 'health', status: 'timeout' }],
    process: { found: true, cpuRatio: 0.9 },
  });
  assert.equal(
    busy.caveats.some((c) => c.includes('近乎不动')),
    false,
  );
});

test('⑯ renderReport：每条 RPC 的**耗时**都入报告（老探针只打字节数）', () => {
  const data = facts();
  const report = renderReport(data);
  // ⚠️ 断言必须跟着夹具里的实际条目走：第一版这里写死了 `config.get`，
  //    而夹具根本没那条 ⇒ 报"报告里没有 config.get"，**是我的期望写错，不是实现错**。
  for (const run of data.rpcs) {
    assert.ok(report.includes(run.method), `报告里没有 ${run.method}`);
    assert.ok(report.includes(`${run.elapsedMs}ms`), `报告里没有 ${run.method} 的耗时`);
  }
});

test('㉑ 状态不在词表里 ⇒ **不许**判成"活着"（大写 TIMEOUT 就是这么栽的）', () => {
  const allUnknown = judgeProbe({
    connection: { reachable: true, connectOk: true },
    rpcs: [
      { method: 'health', status: 'TIMEOUT' },
      { method: 'config.get', status: 'TIMEOUT' },
    ],
  });
  assert.equal(allUnknown.verdict, 'unknown');
  assert.ok(allUnknown.caveats.some((c) => c.includes('词表')));

  const mixed = judgeProbe({
    connection: { reachable: true, connectOk: true },
    rpcs: [
      { method: 'health', status: 'ok' },
      { method: 'config.get', status: 'TIMEOUT' },
    ],
  });
  assert.equal(mixed.verdict, 'partial');
  assert.ok(mixed.caveats.some((c) => c.includes('词表')));
});

/** 假 socket：只实现 runner 需要的那两个方法，帧全记下来。 */
function fakeSocket() {
  const handlers = [];
  const sent = [];
  return {
    sent,
    addEventListener: (type, handler) => {
      if (type === 'message') handlers.push(handler);
    },
    send: (payload) => sent.push(JSON.parse(payload)),
    deliver: (frame) => {
      for (const handler of handlers) handler({ data: JSON.stringify(frame) });
    },
  };
}

test('㉒ 超时那条路必须走同一套状态词表（大写 TIMEOUT 曾让"全超时"判成"活着"）', async () => {
  const socket = fakeSocket();
  const rpc = makeRpcRunner(socket, 20);
  const run = await rpc('health', {});
  assert.equal(run.status, 'timeout');
  assert.equal(run.ok, false);
  assert.equal(typeof run.elapsedMs, 'number');
  // 而且这个 run 放进判读里必须算成卡死（端到端把两个函数接起来）
  assert.equal(judgeProbe({ connection: { reachable: true, connectOk: true }, rpcs: [run] }).verdict, 'stall');
});

test('㉓ 回包那条路：耗时/载荷字节数/错误码都记下来，needs-owner 认得出来', async () => {
  const socket = fakeSocket();
  const rpc = makeRpcRunner(socket, 1000);
  const pending = rpc('tools.catalog', { includePlugins: true, agentScope: 'all' });
  const request = socket.sent[0];
  assert.equal(request.method, 'tools.catalog');
  assert.deepEqual(request.params, { includePlugins: true, agentScope: 'all' });
  socket.deliver({
    type: 'res',
    id: request.id,
    ok: false,
    error: { code: 'INVALID_REQUEST', message: 'this Gateway request has no explicit owner' },
  });
  const run = await pending;
  assert.equal(run.status, 'needs-owner');
  assert.equal(run.code, 'INVALID_REQUEST');
  assert.equal(typeof run.elapsedMs, 'number');
  // 别人的帧不许串台（未知 id 直接忽略）
  socket.deliver({ type: 'res', id: 'nope', ok: true, payload: { big: 'x'.repeat(10) } });
  assert.equal(run.payloadBytes, 0);

  // 载荷字节数是老探针**唯一**的读数 ⇒ 真有载荷时必须真的数出来（恒为 0 就等于退回老探针）
  const second = rpc('health', { probe: true });
  const secondRequest = socket.sent[1];
  socket.deliver({ type: 'res', id: secondRequest.id, ok: true, payload: { ok: true, marker: 'm' } });
  const run2 = await second;
  assert.equal(run2.status, 'ok');
  assert.ok(run2.payloadBytes > 10, `载荷字节数没数出来（${run2.payloadBytes}）`);
});

test('⑰ renderReport：health.eventLoop 的峰值与 reasons 入报告', () => {
  const report = renderReport(facts());
  assert.ok(report.includes('eventLoop'));
  assert.ok(report.includes('1400'));
  assert.ok(report.includes('event_loop_delay'));
});

test('⑱ renderReport：配置时间线入报告；没有变化时照实写"没观察到"', () => {
  const withChange = renderReport(
    facts({
      config: {
        sha256: 'b'.repeat(64),
        size: 4096,
        mtimeMs: 1,
        timeline: [
          { kind: 'baseline', offsetMs: 0, sha256: 'a'.repeat(64), size: 4096, mtimeMs: 1 },
          { kind: 'changed', offsetMs: 4200, sha256: 'b'.repeat(64), size: 4300, mtimeMs: 2 },
        ],
        backups: [],
      },
    }),
  );
  assert.ok(withChange.includes('配置时间线'));
  assert.ok(withChange.includes('4200'));
  assert.ok(withChange.includes('changed'));

  const noChange = renderReport(facts());
  assert.ok(/没观察到|无变化/.test(noChange));
});

test('⑲ renderReport：**没取到**的每一项都要写出来，且不许编造 PID', () => {
  const report = renderReport(facts());
  assert.ok(/进程|端口/.test(report));
  assert.ok(report.includes('没取到'), '没取到的东西必须照实写');
  assert.equal(/PID[:：]\s*\d+/.test(report), false, '没取到 pid 却报了一个 pid = 编造');
});

test('⑳ renderReport：带出处与可重跑命令（否则这份报告没法复现）', () => {
  const report = renderReport(facts());
  assert.ok(report.includes('gateway-probe.mjs'), '报告里没有可重跑命令');
  assert.ok(/出处/.test(report), '报告里没有出处段');
});

// ㉔/㉕ 是**事后补的**：写完变异体才发现这两处没有判据（见提交说明里的诚实记账）。
// 它们的"牙齿"来自变异体 M24/M25（把 【7】的警告吞掉、把 eventLoop 缺席那段跳过）。
test('㉔ renderReport：【7】照实列"没做到的"；没有时也要写"（无）"而不是留白', () => {
  const withWarning = renderReport(facts({ warnings: ['窗口内一次都没收到 eventLoop（别读成"没问题"）'] }));
  assert.ok(withWarning.includes('【7】'));
  assert.ok(withWarning.includes('窗口内一次都没收到 eventLoop（别读成"没问题"）'), '【7】把警告吞了 = 报告留白');
  const noWarning = renderReport(facts({ warnings: [] }));
  assert.ok(noWarning.includes('（无）'), '没有警告时留白 ⇒ 会被后人读成"没问题"');
});

test('㉕ renderReport：一次都没收到 eventLoop 时，要写明"没越过门槛，不是没测到"', () => {
  const report = renderReport(
    facts({
      health: {
        samples: 3,
        summary: summarizeEventLoop([
          { atMs: 0, eventLoop: null },
          { atMs: 1000, eventLoop: null },
          { atMs: 2000, eventLoop: null },
        ]),
      },
    }),
  );
  assert.ok(report.includes('一次都没收到'), 'eventLoop 缺席时没写明原因 ⇒ 留白会被读成"没问题"');
  assert.ok(report.includes('没测到'), '要把"不是没测到"这句话写出来');
});
