import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export async function runImageReview(request, { fetcher = globalThis.fetch, loadTools } = {}) {
  const billingProof = request.billingSessionProof;
  if (
    typeof request.billingSessionId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,256}$/.test(request.billingSessionId) ||
    request.billingSessionId === request.taskId ||
    request.billingSessionId === request.sessionKey ||
    billingProof?.source !== 'gateway-chat-history' ||
    billingProof.taskId !== request.taskId ||
    billingProof.sessionKey !== request.sessionKey ||
    billingProof.runId !== request.runId ||
    billingProof.billingSessionId !== request.billingSessionId
  )
    throw Error('visual-billing-session-unverified');
  const cfg = JSON.parse(fs.readFileSync(request.configFile, 'utf8'));
  if (!request.imageModel?.startsWith('clawrouter/') || !request.licenseHash || !request.taskId || !request.runId)
    throw Error('visual-configuration-unavailable');
  const provider = cfg.models?.providers?.clawrouter;
  if (!provider?.apiKey || provider.baseUrl.replace(/\/+$/, '') !== request.guardBaseUrl.replace(/\/+$/, ''))
    throw Error('visual-guard-mismatch');
  const capability = await fetcher(`${provider.baseUrl.replace(/\/+$/, '')}/v1/ppt-test/capabilities`, {
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    signal: globalThis.AbortSignal.timeout(15000),
  });
  const guard = await capability.json();
  if (
    !capability.ok ||
    guard.guardVersion !== 'ppt-budget-v1' ||
    guard.licenseHash !== request.licenseHash ||
    guard.currency !== 'CNY' ||
    guard.batchCapMicros !== '500000000' ||
    guard.batchId !== request.batchId
  )
    throw Error('visual-budget-guard-unavailable');
  const pkg = JSON.parse(fs.readFileSync(path.join(request.openclawRoot, 'package.json'), 'utf8'));
  if (pkg.version !== '2026.9.3') throw Error('visual-runtime-version-unavailable');
  const verifyImage = (image) => {
    if (
      createHash('sha256')
        .update(fs.readFileSync(path.join(request.workspace, image.image)))
        .digest('hex') !== image.sha256
    )
      throw Error('visual-image-version-mismatch');
  };
  for (const image of request.pages) verifyImage(image);
  const createTools = loadTools
    ? await loadTools(request.openclawRoot)
    : (await import(pathToFileURL(path.join(request.openclawRoot, 'dist/agent-tools-lIs_Y2DS.mjs')).href)).t;
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.imageModel = { primary: request.imageModel, fallbacks: [] };
  const pages = [],
    callIds = [];
  for (let offset = 0; offset < request.pages.length; offset += 4) {
    const images = request.pages.slice(offset, offset + 4);
    for (const image of images) verifyImage(image);
    const callId = `${request.runId}:model:${parseInt(request.outputSha256.slice(0, 10), 16) + offset}`;
    provider.headers = {
      ...Object.fromEntries(
        Object.entries(provider.headers ?? {}).filter(
          ([name]) => !['x-clawrouter-session-id', 'x-request-id'].includes(name.toLowerCase()),
        ),
      ),
      'x-clawrouter-session-id': request.billingSessionId,
      'x-request-id': callId,
    };
    const tools = createTools({
      config: cfg,
      workspaceDir: request.workspace,
      agentDir: request.agentDir,
      sessionKey: request.sessionKey,
      modelId: request.imageModel,
      modelHasVision: false,
    });
    const imageTool = tools.find((tool) => tool.name === 'view_image');
    if (!imageTool) throw Error('visual-image-tool-unavailable');
    const result = await imageTool.execute(callId, {
      model: request.imageModel,
      paths: images.map((p) => path.join(request.workspace, p.image)),
      prompt: `Review final PPTX ${request.outputSha256}, version ${request.revision}. Images in order are pages ${images.map((p) => p.page).join(', ')}. Inspect small text, clipping, occlusion, empty placeholders, broken Chinese words, chart/text conflicts and seriously unbalanced content. Ordinary white space is fine. Return JSON only: {"pages":[{"page":1,"issues":[{"problem":"specific issue","suggestion":"fix the affected page without changing facts/data"}]}]}. Include every provided page, including pages with no issues.`,
    });
    const text = result.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, '');
    const review = JSON.parse(text);
    if (!Array.isArray(review.pages)) throw Error('visual-response-invalid');
    pages.push(...review.pages);
    callIds.push(callId);
  }
  return { callId: callIds.join(','), pages };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const request = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    process.stdout.write(JSON.stringify(await runImageReview(request)) + '\n');
  } catch (error) {
    const code = error instanceof Error && /^visual-/.test(error.message) ? error.message : 'visual-review-failed';
    process.stdout.write(JSON.stringify({ error: code }) + '\n');
    process.exitCode = 1;
  }
}
