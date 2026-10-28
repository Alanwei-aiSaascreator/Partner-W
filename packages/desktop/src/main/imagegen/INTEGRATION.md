# Image generation integration patch (2026-10-15 local candidate)

## Shared entry points (root-owned files)

- `src/main/ipc/data-handlers.ts`: import `startImagegenJobs` from `../imagegen/start.js`; add `imagegen` to `StructuredFenceKind` and `hasStructuredFence` list. In the existing `structured.status === 'complete'` background job block call `startImagegenJobs({workspacePath:input.workspacePath,taskId:input.taskId,sessionKey:input.sessionKey,messageId:input.messageId,runId:input.runId,content:structured.content})`. Truncated imagegen must broadcast `imagegen:failed` with `[{code:'imagegen-block-invalid'}]`, never start network work.
- `packages/shared/src/artifact-delivery-activity.ts`: phase `generating-image`; existing phase label maps need imagegen.generating.
- `src/main/db/index.ts`: imagegen_request_identities(operation_key TEXT PRIMARY KEY, request_id TEXT NOT NULL, task_id TEXT NOT NULL, request_fingerprint TEXT NOT NULL, created_at TEXT NOT NULL).
- `src/preload/index.ts` and `clawwork.d.ts`: event `imagegen:failed`, expose `onImagegenFailed` following `onVideogenFailed` with typed failure list. Root should move/export `ImagegenFailure` and `ImagegenFailureCode` from imagegen/request.ts into shared if crossing IPC.
- Renderer: hook onImagegenFailed in existing MainArea registration (like useVideogenFailureToast); localize following codes. Preserve no raw upstream errors.
- B `services/relay/src/index.ts`: registerImagegenRoutes(app,{authenticate:resolveAuth,rpc:serviceRpc,upstream:cfg.upstreams.bailian,enabled:process.env.IMAGEGEN_ENABLED==='true'}). Actual names follow voice route deps. Default is false; migration has no seeded price and capabilities returns unavailable until verified price rows enabled.

## Error copy

| code                         | zh                                                         | en                                                                                                        |
| ---------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| imagegen-block-invalid       | 图片生成请求不完整或包含暂不支持的规格，请调整后重试。     | The image request is incomplete or uses an unsupported specification.                                     |
| imagegen-unavailable         | 图片生成尚未开通，当前不会扣费。                           | Image generation is not enabled. No new generation was submitted.                                         |
| imagegen-request-unconfirmed | 图片任务结果尚未确认，请保留原操作编号查询，不要重新生成。 | The image request is unconfirmed. Keep its operation ID to recover it; do not start a new generation.     |
| imagegen-generation-failed   | 图片生成失败，请调整内容后再生成。                         | Image generation failed. Revise the request before generating again.                                      |
| imagegen-result-unconfirmed  | 图片结果或结算尚未确认，未登记成果。可沿用原操作编号查询。 | The result or settlement is unconfirmed. No artifact was registered. Recover using the same operation ID. |
| imagegen-image-invalid       | 返回的图片无法完整打开或尺寸不符，未登记成果。             | The returned image is incomplete or has the wrong dimensions. No artifact was registered.                 |
| imagegen-save-failed         | 图片尚未保存成功。请保留原操作编号恢复，不要重复生成。     | The image has not been saved. Recover with the same operation ID instead of regenerating.                 |
| imagegen-workspace-changed   | 工作区或登录状态已变化，已停止保存本次图片。               | The workspace or authorization changed. Image delivery was stopped.                                       |

## New model skill contract (root to place in packages/desktop/our-skills/image-generation/SKILL.md)

---

name: image-generation
description: Generate one raster image from a text prompt through the desktop image delivery service. Never claim availability or completion until the service confirms it.

---

Only one text-to-image model is currently wired: qwen-image-plus. Availability is feature-gated and requires verified image-specific pricing. Do not infer that the feature is enabled merely because this skill is present. When unavailable, explain that image generation is not enabled; do not switch providers or invoke an unrelated image_generate tool.

When the user explicitly requests an image, put exactly one closed imagegen JSON fence in the assistant message. The desktop performs the generation and registers the artifact; writing JSON to a file is not delivery. No reference image/edit mode, batch generation, custom URLs, alternate models, or arbitrary resolutions are supported.

```imagegen
{"operationId":"poster-autumn-001","model":"qwen-image-plus","prompt":"A minimalist autumn landscape, warm soft light","size":"1328*1328","title":"Autumn landscape"}
```

operationId must be 8-80 ASCII letters, digits, underscores or hyphens. It identifies the user's logical generation, not the assistant reply. For a timeout, uncertain result, save failure, or an explicit recovery request, copy exactly the previous operationId and the original prompt/specification. Do not invent a new ID to get past an error. Only when the user explicitly asks for a new image/variation should you issue a new operationId. Changing input under an old operationId is refused.

Allowed size values: 1328*1328, 1664*928, 928\*1664. Prompt: 1-800 Unicode code points. Title: at most 80 characters. Do not add other JSON keys. Only one fence per response. Say that generation has been requested, never that an image exists until the artifact appears. Model output, billing, validated local file and artifact availability are separate states.

## Sources and reuse

- Official Qwen image API (checked 2026-10-15): https://help.aliyun.com/zh/model-studio/qwen-image-api . Async task creation, polling and usage.image_count; actual dimensions are verified from downloaded PNG, not fabricated usage fields.
- Existing R adapter services/relay/src/media/qwen-image.ts: reused protocol, asynchronous task and asset-boundary design only. Zero-billing entitlement paths were not copied.
- Apache-2.0 official DashScope SDK inspected as reference: https://github.com/dashscope/dashscope-sdk-python . A Python SDK dependency is not introduced into the Node relay; the existing fetch adapter boundary is sufficient.
- MIT third-party qwen-image-mcp discovery: https://github.com/yingcaihuang/qwen-image-mcp . Not adopted because MCP server orchestration would duplicate the existing relay/task/artifact infrastructure.

Verification to date is offline injected provider and local route testing; no paid generation, migration deploy, product UI or remote artifact-open claim is implied.

Final recovery behavior: after a local identity exists, the desktop only queries/downloads that request ID. It never POSTs again, including when capabilities are disabled. The stored fingerprint rejects changed input under the same operation ID. Generation/model title does not affect operation identity. Current license and workspace are checked before new submission, polling and save; old authorization results are not broadcast.

## Independent artifact review fixes (2026-10-15)

Production `startImagegenJobs` callers must pass `sourceCurrent` bound to the source run/workspace/license generation and `retainSource` from the existing run lifecycle. Retention is released in `finally`; canceled or replaced source runs must not be adopted by current credentials.

Replay now looks up the exact task + full license-scoped operation source key, reopens the existing file through verified descriptor access, and validates PNG signature/header, decoded dimensions and registered length. Corrupt files are refused without creating another row or submitting another provider request. Concurrent publication is serialized per source key; the persisted identity is rechecked after capability lookup before any create.

The terminal activity's optional `artifactId` references the original artifact row across messages. It survives SQLite reopen; the image card accepts only that exact available PNG in the same task. `artifact:list`, `artifact:get` and `artifact:open-file` revalidate only imagegen-source images; unrelated artifact behavior is unchanged.

Owner regression: 104 tests passed across nine targeted files, including six real SQLite/filesystem scenarios. Independent artifact probes: 2/2 passed unchanged. No paid call, deployment or live product-success claim.
