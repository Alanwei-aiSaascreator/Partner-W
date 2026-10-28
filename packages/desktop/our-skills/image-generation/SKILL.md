---
name: 图片生成（文字描述生成图片）
description: '将文字描述生成一张图片并保存到任务成果。仅在服务已开通时使用，未确认文件可用前不得宣称完成。'
metadata: { 'openclaw': { 'emoji': '🖼️', 'skillKey': 'image-generation' } }
---

Image generation IS wired in this product: the desktop turns the fence below into a real image, registers it as a task artifact and charges the account. Do not answer that image generation is unsupported, and do not call an unrelated image_generate tool or switch providers. Keep `"model":"qwen-image-plus"` exactly as written here — the relay accepts this label and routes it to the current upstream model. If the desktop reports a failure, repeat what it said and stop; do not retry with invented parameters.

When the user explicitly requests an image, put exactly one closed imagegen JSON fence in the assistant message. The desktop performs the generation and registers the artifact; writing JSON to a file is not delivery. No reference image/edit mode, batch generation, custom URLs, alternate models, or arbitrary resolutions are supported.

```imagegen
{"operationId":"poster-autumn-001","model":"qwen-image-plus","prompt":"A minimalist autumn landscape, warm soft light","size":"1328*1328","title":"Autumn landscape"}
```

operationId must be 8-80 ASCII letters, digits, underscores or hyphens. It identifies the user's logical generation, not the assistant reply. For a timeout, uncertain result, save failure, or an explicit recovery request, copy exactly the previous operationId and the original prompt/specification. Do not invent a new ID to get past an error. Only when the user explicitly asks for a new image/variation should you issue a new operationId. Changing input under an old operationId is refused.

Allowed size values: 1328*1328, 1664*928, 928\*1664. Prompt: 1-800 Unicode code points. Title: at most 80 characters. Do not add other JSON keys. Only one fence per response. Say that generation has been requested, never that an image exists until the artifact appears. Model output, billing, validated local file and artifact availability are separate states.
