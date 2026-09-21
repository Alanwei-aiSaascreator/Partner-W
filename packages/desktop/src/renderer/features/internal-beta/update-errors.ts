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

const PORTABLE_ERROR_ACTION: Readonly<Record<PortableUpdateErrorCode, PortableErrorAction>> = {
  network: 'retry',
  'feed-response': 'retry',
  'signature-invalid': 'replace-package',
  'manifest-invalid': 'replace-package',
  'unsupported-policy': 'replace-package',
  'launcher-incompatible': 'replace-package',
  'disk-space': 'free-space',
  'volume-readonly': 'contact-support',
  'package-integrity': 'retry',
  'archive-unsafe': 'retry',
  'file-integrity': 'retry',
  'file-in-use': 'retry',
  'launcher-start-failed': 'retry',
  'health-timeout': 'retry',
  'rollback-failed': 'contact-support',
  cancelled: 'retry',
  unknown: 'retry',
};

const PORTABLE_ERROR_TEXT: Readonly<Record<PortableUpdateErrorCode, string>> = {
  network: '连不上更新服务器，请检查网络后重试。',
  'feed-response': '更新服务返回的内容看不懂，请稍后重试。',
  'signature-invalid': '更新包的签名校验没过，这份包不是我们发布的。请从官方渠道重新获取完整的交付包。',
  'manifest-invalid': '更新清单不完整或不是当前渠道的。请从官方渠道重新获取完整的交付包。',
  'unsupported-policy': '这份更新要求强制安装，当前版本不支持。请获取新的完整交付包。',
  'launcher-incompatible': '启动器版本太旧，装不了这份更新。请获取新的完整交付包。',
  'disk-space': 'U 盘空间不足，更新已经暂停。清理出空间后可以重试，现有数据没有受影响。',
  'volume-readonly': 'U 盘当前不可写。请确认没有写保护，然后重试。',
  'package-integrity': '更新包下载不完整。重试即可，系统会重新下载。',
  'archive-unsafe': '更新包里有不安全的内容，已经拒绝解压。请重试，或从官方渠道重新获取交付包。',
  'file-integrity': '更新包里的文件和清单对不上，已经拒绝安装。请重试，或从官方渠道重新获取交付包。',
  'file-in-use': '有文件正被占用，暂时换不了目录。请关闭其它正在使用这块 U 盘的程序后重试。',
  'launcher-start-failed': '启动器没能起来，更新没有开始。你的当前版本和数据都没有受影响，可以直接重试。',
  'health-timeout': '新版本启动后没能完成自检，已经恢复到更新前的版本。你的数据没有受影响。',
  'rollback-failed':
    '更新失败，自动恢复也没能完成。请不要拔出 U 盘、不要删除任何文件，并把这台电脑上的「.荣盈魔方更新」目录提供给技术支持。',
  cancelled: '已取消更新，当前版本可以继续使用。',
  unknown: '更新没能完成。请重试；如果一直失败，请把「.荣盈魔方更新」目录提供给技术支持。',
};

export function portableErrorAction(code: PortableUpdateErrorCode): PortableErrorAction {
  return PORTABLE_ERROR_ACTION[code] ?? 'retry';
}

export function describePortableError(code: PortableUpdateErrorCode): string {
  return PORTABLE_ERROR_TEXT[code] ?? PORTABLE_ERROR_TEXT.unknown;
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

export function describeUpdateError(raw: string | undefined, operation: UpdateOperation): string {
  const text = (raw ?? '').trim();
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
