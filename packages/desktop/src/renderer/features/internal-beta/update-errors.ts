/**
 * 把 electron-updater 的英文报错翻成用户看得懂的中文。
 *
 * 为什么需要它（2026-09-17）：更新面板以前直接把 `err.message` 摆在界面上，
 * 用户看到的是 `HttpError: 404 Not Found - GET https://…/updates/latest.yml`。
 * 而更新服务（Nginx `/updates/`）**当时还没部署**，所以这个界面必然出现在
 * 每一次"检查更新"上 —— 一段英文堆栈既像 bug、又不告诉用户该怎么办。
 *
 * 约束（与 `gateway-error-message.ts` 同一套路）：
 *   - 认得的错误给**中文**，并且**不带**任何英文原文 / URL / 版本号片段；
 *   - 认不出来的给按操作区分的兜底中文（原始报错进调试日志，见 main 的 `updater.*`）；
 *   - 只做展示，不改任何更新行为。
 */

import type { PortableUpdateErrorCode } from '@clawwork/shared';

type UpdateOperation = 'check' | 'download' | 'install' | 'updater';

/**
 * 盘上运行的错误 → 界面**该给用户的下一个动作**。
 *
 * ⚠️ 这里**没有**「忽略并继续安装」这个动作，而且是刻意的：签名、清单、策略这几类
 *    失败意味着"这份更新不是我们发的"，或者"这个启动器已经配不上它"。
 *    给一个"忽略"按钮等于把校验当摆设 —— 设计文档 §10 明确禁止。
 */
export type PortableErrorAction = 'retry' | 'free-space' | 'replace-package' | 'contact-support';

/**
 * 失败的**类别** —— 与"能不能重试、下一步做什么"绑在一起的判据。
 *
 * 分开这六类的理由只有一个：它们给用户的建议不一样。
 *   · `no-update`   ：源上还没有这个版本 —— **不是错误**，说"当前频道暂无更新"；
 *   · `network`     ：连不上/超时 —— 可重试；
 *   · `untrusted`   ：签名/清单不可信 —— **不可重试**，换完整交付包；
 *   · `space`       ：空间不足 —— 可重试，但先要看见"还差多少"；
 *   · `launcher`    ：启动器不兼容/不是配套那把 —— 换**基础包**（便携更新从不换启动器）；
 *   · `filesystem`  ：磁盘/文件系统问题（写失败、只读、exFAT 限制）—— 与空间不足分开。
 */
export type PortableErrorCategory = 'no-update' | 'network' | 'untrusted' | 'space' | 'launcher' | 'filesystem';

export interface PortableErrorInfo {
  category: PortableErrorCategory;
  /** 用户**再点一次**有没有意义。与 `action` 是两件事：`contact-support` 也是"别再自己试了"。 */
  retryable: boolean;
  action: PortableErrorAction;
  text: string;
}

const PORTABLE_ERRORS: Readonly<Record<PortableUpdateErrorCode, PortableErrorInfo>> = {
  network: {
    category: 'network',
    retryable: true,
    action: 'retry',
    text: '连不上更新服务器，请检查网络后重试。',
  },
  'feed-response': {
    category: 'network',
    retryable: true,
    action: 'retry',
    text: '更新服务返回的内容看不懂，请稍后重试。',
  },
  'update-not-published': {
    category: 'no-update',
    retryable: true,
    action: 'retry',
    // ⚠️ 刻意不写成"失败"：源上还没有这个版本是最正常的状态（每次发版之前都是它）。
    text: '当前频道暂无更新，你的版本已经是最新的。新的更新发布后会自动出现。',
  },
  'signature-invalid': {
    category: 'untrusted',
    retryable: false,
    action: 'replace-package',
    text: '更新包的签名校验没过，这份包不是我们发布的。请从官方渠道重新获取完整的交付包。',
  },
  'manifest-invalid': {
    category: 'untrusted',
    retryable: false,
    action: 'replace-package',
    text: '更新清单不完整或不是当前渠道的。请从官方渠道重新获取完整的交付包。',
  },
  'unsupported-policy': {
    category: 'untrusted',
    retryable: false,
    action: 'replace-package',
    text: '这份更新要求强制安装，当前版本不支持。请获取新的完整交付包。',
  },
  'launcher-incompatible': {
    category: 'launcher',
    retryable: false,
    action: 'replace-package',
    text: 'U 盘上的启动器版本太旧，装不了这份更新。请用新的完整基础包重新交付一次。',
  },
  'launcher-unavailable': {
    category: 'launcher',
    retryable: false,
    action: 'replace-package',
    // 只换客户端、留下旧启动器的盘会走到这里 —— 那正是要拦住的那种交付。
    text: '没能认出 U 盘上配套的启动器（可能只换了客户端、留下了旧启动器）。请用完整的新的基础包重新交付一次。',
  },
  'disk-space': {
    category: 'space',
    retryable: true,
    action: 'free-space',
    text: 'U 盘空间不足，更新已经暂停。清理出空间后可以重试，现有数据没有受影响。',
  },
  'volume-readonly': {
    category: 'filesystem',
    retryable: true,
    action: 'contact-support',
    text: 'U 盘当前不可写。请确认没有写保护，然后重试。',
  },
  'filesystem-error': {
    category: 'filesystem',
    retryable: true,
    action: 'retry',
    // 与"空间不足"分开：清空间解决不了这类问题（写失败、exFAT 命名限制、半途断电的残留）。
    text: '写 U 盘时出错了（不是空间不足）。请重试；如果一直失败，请把这块 U 盘插到另一台电脑上再试一次。',
  },
  'package-integrity': {
    category: 'network',
    retryable: true,
    action: 'retry',
    text: '更新包下载不完整。重试即可，系统会重新下载。',
  },
  'archive-unsafe': {
    category: 'untrusted',
    retryable: true,
    action: 'retry',
    text: '更新包里有不安全的内容，已经拒绝解压。请重试，或从官方渠道重新获取交付包。',
  },
  'file-integrity': {
    category: 'untrusted',
    retryable: true,
    action: 'retry',
    text: '更新包里的文件和清单对不上，已经拒绝安装。请重试，或从官方渠道重新获取交付包。',
  },
  'file-in-use': {
    category: 'filesystem',
    retryable: true,
    action: 'retry',
    text: '有文件正被占用，暂时换不了目录。请关闭其它正在使用这块 U 盘的程序后重试。',
  },
  'launcher-start-failed': {
    category: 'launcher',
    retryable: true,
    action: 'retry',
    text: '启动器没能起来，更新没有开始。你的当前版本和数据都没有受影响，可以直接重试。',
  },
  'health-timeout': {
    category: 'launcher',
    retryable: true,
    action: 'retry',
    text: '新版本启动后没能完成自检，已经恢复到更新前的版本。你的数据没有受影响。',
  },
  'rollback-failed': {
    category: 'filesystem',
    retryable: false,
    action: 'contact-support',
    text: '更新失败，自动恢复也没能完成。请不要拔出 U 盘、不要删除任何文件，并把这台电脑上的「.荣盈魔方更新」目录提供给技术支持。',
  },
  cancelled: {
    category: 'no-update',
    retryable: true,
    action: 'retry',
    text: '已取消更新，当前版本可以继续使用。',
  },
  unknown: {
    category: 'filesystem',
    retryable: true,
    action: 'retry',
    text: '更新没能完成。请重试；如果一直失败，请把「.荣盈魔方更新」目录提供给技术支持。',
  },
};

/** 类别 / 可重试 / 下一步 / 文案，一次拿全。 */
export function classifyPortableError(code: PortableUpdateErrorCode): PortableErrorInfo {
  return PORTABLE_ERRORS[code] ?? PORTABLE_ERRORS.unknown;
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * 空间不足要说得出**还差多少**：只丢一句"空间不足"，用户不知道要清出 100 MB 还是 10 GB。
 * 数字来自公开状态里的 `requiredBytes` / `availableBytes`（见 main 侧 `publish('error', …)`）。
 * 拿不到数字就退回不带数字的那句 —— 不能因此崩，也不能把 `undefined` 摆到界面上。
 */
function describeSpaceError(detail?: { requiredBytes?: number; availableBytes?: number }): string | null {
  const required = detail?.requiredBytes;
  const available = detail?.availableBytes;
  if (typeof required !== 'number' || typeof available !== 'number') return null;
  if (!Number.isFinite(required) || !Number.isFinite(available)) return null;
  const missing = Math.max(0, required - available);
  return `U 盘空间不足：这次更新需要至少 ${formatGiB(required)} 可用，现在只剩 ${formatGiB(available)}（还差 ${formatGiB(missing)}）。清理出空间后可以重试，现有数据没有受影响。`;
}

export function portableErrorAction(code: PortableUpdateErrorCode): PortableErrorAction {
  return classifyPortableError(code).action;
}

export function describePortableError(
  code: PortableUpdateErrorCode,
  detail?: { requiredBytes?: number; availableBytes?: number },
): string {
  if (code === 'disk-space') {
    const withNumbers = describeSpaceError(detail);
    if (withNumbers !== null) return withNumbers;
  }
  return classifyPortableError(code).text;
}

const OPERATION_LABEL: Record<UpdateOperation, string> = {
  check: '检查更新',
  download: '下载更新',
  install: '安装更新',
  updater: '更新',
};

/** 判定顺序：内容比操作更能说明"该怎么办"，所以先按内容认，认不出才用操作兜底。 */
function classify(
  raw: string,
): 'no-metadata' | 'network' | 'signature' | 'cancelled' | 'no-update' | 'portable-service' | null {
  if (/cancel/i.test(raw)) return 'cancelled';
  if (/no-update-available/i.test(raw)) return 'no-update';
  if (/portable-unavailable/i.test(raw)) return 'portable-service';
  if (/latest.*ya?ml|no published|not found|404|cannot find/i.test(raw)) return 'no-metadata';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|getaddrinfo|network|socket hang up/i.test(raw)) {
    return 'network';
  }
  if (/signature|checksum|sha512|verify/i.test(raw)) return 'signature';
  return null;
}

/**
 * 盘上那条链失败时给的是**错误码**（`disk-space` / `launcher-unavailable` …），
 * 不是 electron-updater 的英文原文。
 *
 * ⚠️ 不认的话会一路落到 `default` ⇒ 用户看到"下载更新没完成，请稍后重试"，
 *    而 `launcher-unavailable` 那种**明确不该重试**的（要换完整基础包）也被建议重试 ——
 *    分类白做了。
 */
function asPortableErrorCode(value: string): PortableUpdateErrorCode | null {
  return Object.hasOwn(PORTABLE_ERRORS, value) ? (value as PortableUpdateErrorCode) : null;
}

export function describeUpdateError(
  raw: string | undefined,
  operation: UpdateOperation,
  detail?: { requiredBytes?: number; availableBytes?: number },
): string {
  const text = (raw ?? '').trim();
  const portableCode = asPortableErrorCode(text);
  if (portableCode !== null) return describePortableError(portableCode, detail);
  switch (classify(text)) {
    case 'cancelled':
      return '已取消更新。';
    case 'no-update':
      return '当前没有可下载的更新。';
    case 'no-metadata':
      // 说实话：这是**服务端**还没准备好，不是用户的锅，也不是"已是最新"
      return '更新服务还没有提供更新清单（服务端未就绪），当前版本可以继续使用。';
    case 'portable-service':
      // 盘上运行、但整目录更新服务没建起来：重开一次就好，不是用户的错，也不是"已是最新"
      return '盘上运行的更新服务还没准备好。请重新打开一次荣盈魔方再试。';
    case 'network':
      return '连不上更新服务器，请检查网络后重试。';
    case 'signature':
      return '安装包校验失败，已停止安装。请重新下载或联系管理员。';
    default:
      return `${OPERATION_LABEL[operation]}没完成，请稍后重试。`;
  }
}
