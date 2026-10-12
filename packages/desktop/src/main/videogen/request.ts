import type { VideogenFailure } from '@clawwork/shared';
import {
  VIDEOGEN_ASPECT_RATIOS,
  VIDEOGEN_DURATION_MAX,
  VIDEOGEN_DURATION_MIN,
  VIDEOGEN_PROMPT_MAX_CHARS,
  VIDEOGEN_RESOLUTIONS,
} from '@clawwork/shared';
import { documentFileStem } from '../util/document-file-name.js';

/**
 * ```` ```videogen ```` 块的**内容 schema**（助手提交的"请生成一段视频"请求）。
 *
 * ## P0 只做文生视频，而且只认这几个字段
 *
 * 端脑 H3 还支持首尾帧 / 参考图 / 参考视频（multipart 上传），但本轮**未接上传管线**。
 * 那类字段（`imageUrl` / `firstFrame` / `videoUrl` / `model`…）在这里是**严格拒收**的
 * （`videogen-unsupported-field`）——静默忽略会让用户以为图被用上了。
 * 想开新面：加字段 + 加上传管线 + 改这里的白名单与文案，一次做完。
 *
 * ## 默认值在这里填，且与 relay 的默认**逐字一致**
 *
 * relay（`services/relay/src/video.ts`）对缺省 duration/resolution/aspect 有自己的默认；
 * 客户端**总是发显式值**（本文件把默认填好），所以 relay 的默认正常路径不会被触发。
 * 两侧白名单/区间由测试钉住（`videogen-request.test.ts` 读 shared 常量断言）。
 *
 * ## 校验失败 = **结构化 failure**，不是抛错
 *
 * 与 `htmlgen/request.ts` 同款：失败要跨 IPC 上屏（走 `VideogenFailure` 的码 + 数据），
 * 所以这里返回判别联合，`detail` 是给日志的英文细节（与文案无关）。
 */

export const VIDEOGEN_DEFAULT_DURATION = 10;
export const VIDEOGEN_DEFAULT_RESOLUTION = '768P';
export const VIDEOGEN_DEFAULT_ASPECT_RATIO = '16:9';

/** 标题上限（进文件名；清洗在 `documentFileStem`，这里只挡长度）。 */
export const VIDEOGEN_MAX_TITLE_CHARS = 60;

/** 根级允许的键。未知键 = 拒收（见文件头注释）。 */
const ROOT_KEYS = new Set(['prompt', 'duration', 'resolution', 'aspectRatio', 'title']);

export interface VideogenRequest {
  prompt: string;
  duration: number;
  resolution: (typeof VIDEOGEN_RESOLUTIONS)[number];
  aspectRatio: (typeof VIDEOGEN_ASPECT_RATIOS)[number];
  /** 已解析的标题（可能为空串 ⇒ 文件名回落到 prompt 前缀）。 */
  title: string;
}

export type VideogenParseResult =
  | { ok: true; request: VideogenRequest }
  | { ok: false; failure: VideogenFailure; detail: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

export function parseVideogenRequest(raw: unknown): VideogenParseResult {
  if (!isPlainObject(raw)) {
    return { ok: false, failure: { code: 'videogen-block-invalid' }, detail: 'request must be a JSON object' };
  }

  const unknownKey = Object.keys(raw).find((key) => !ROOT_KEYS.has(key));
  if (unknownKey) {
    return {
      ok: false,
      // 回显字段路径（截断：模型可能写一长串），文案会说"当前版本不支持这个字段"。
      failure: { code: 'videogen-unsupported-field', field: unknownKey.slice(0, 40) },
      detail: `unsupported field "${unknownKey}" (only: ${[...ROOT_KEYS].join(', ')})`,
    };
  }

  const prompt = asTrimmedString(raw.prompt) ?? '';
  if (!prompt) {
    return { ok: false, failure: { code: 'videogen-prompt-missing' }, detail: 'prompt is required and non-empty' };
  }
  if (prompt.length > VIDEOGEN_PROMPT_MAX_CHARS) {
    return {
      ok: false,
      failure: { code: 'videogen-prompt-too-long', maxChars: VIDEOGEN_PROMPT_MAX_CHARS },
      detail: `prompt exceeds ${VIDEOGEN_PROMPT_MAX_CHARS} characters (${prompt.length})`,
    };
  }

  let duration = VIDEOGEN_DEFAULT_DURATION;
  if (raw.duration !== undefined && raw.duration !== null) {
    if (
      typeof raw.duration !== 'number' ||
      !Number.isInteger(raw.duration) ||
      raw.duration < VIDEOGEN_DURATION_MIN ||
      raw.duration > VIDEOGEN_DURATION_MAX
    ) {
      return {
        ok: false,
        failure: { code: 'videogen-duration-invalid', min: VIDEOGEN_DURATION_MIN, max: VIDEOGEN_DURATION_MAX },
        detail: `duration must be an integer in [${VIDEOGEN_DURATION_MIN}, ${VIDEOGEN_DURATION_MAX}]`,
      };
    }
    duration = raw.duration;
  }

  let resolution: VideogenRequest['resolution'] = VIDEOGEN_DEFAULT_RESOLUTION;
  if (raw.resolution !== undefined && raw.resolution !== null) {
    const value = asTrimmedString(raw.resolution);
    if (!value || !(VIDEOGEN_RESOLUTIONS as readonly string[]).includes(value)) {
      return {
        ok: false,
        failure: { code: 'videogen-resolution-invalid', allowed: VIDEOGEN_RESOLUTIONS },
        detail: `resolution must be one of: ${VIDEOGEN_RESOLUTIONS.join(', ')}`,
      };
    }
    resolution = value as VideogenRequest['resolution'];
  }

  let aspectRatio: VideogenRequest['aspectRatio'] = VIDEOGEN_DEFAULT_ASPECT_RATIO;
  if (raw.aspectRatio !== undefined && raw.aspectRatio !== null) {
    const value = asTrimmedString(raw.aspectRatio);
    if (!value || !(VIDEOGEN_ASPECT_RATIOS as readonly string[]).includes(value)) {
      return {
        ok: false,
        failure: {
          code: 'videogen-aspect-invalid',
          allowed: VIDEOGEN_ASPECT_RATIOS,
          value: String(raw.aspectRatio).slice(0, 20),
        },
        detail: `aspectRatio must be one of: ${VIDEOGEN_ASPECT_RATIOS.join(', ')}`,
      };
    }
    aspectRatio = value as VideogenRequest['aspectRatio'];
  }

  let title = '';
  if (raw.title !== undefined && raw.title !== null) {
    const value = asTrimmedString(raw.title);
    if (value === null) {
      return { ok: false, failure: { code: 'videogen-block-invalid' }, detail: 'title must be a string when present' };
    }
    title = value.slice(0, VIDEOGEN_MAX_TITLE_CHARS);
  }

  return { ok: true, request: { prompt, duration, resolution, aspectRatio, title } };
}

/** 文件名：标题做主名（与 docgen/htmlgen 共用同一份清洗规则），扩展名固定 `.mp4`。 */
export function videoFileNameFor(request: Pick<VideogenRequest, 'prompt' | 'title'>): string {
  const fallback = request.prompt.replace(/\s+/g, ' ').trim().slice(0, 20);
  return `${documentFileStem(request.title || fallback, '短视频')}.mp4`;
}
