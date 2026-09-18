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

type UpdateOperation = 'check' | 'download' | 'install' | 'updater';

const OPERATION_LABEL: Record<UpdateOperation, string> = {
  check: '检查更新',
  download: '下载更新',
  install: '安装更新',
  updater: '更新',
};

/** 判定顺序：内容比操作更能说明"该怎么办"，所以先按内容认，认不出才用操作兜底。 */
function classify(
  raw: string,
): 'no-metadata' | 'network' | 'signature' | 'cancelled' | 'no-update' | 'portable' | null {
  if (/cancel/i.test(raw)) return 'cancelled';
  if (/no-update-available/i.test(raw)) return 'no-update';
  if (/portable-manual-update/i.test(raw)) return 'portable';
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
    case 'portable':
      // U 盘版：更新包不该装到本机（那只会多出一份副本，盘上那份还是旧的）
      return 'U 盘版请手动换包：拿到新版本后，用新的「荣盈魔方」文件夹替换盘上那份即可。';
    case 'network':
      return '连不上更新服务器，请检查网络后重试。';
    case 'signature':
      return '安装包校验失败，已停止安装。请重新下载或联系管理员。';
    default:
      return `${OPERATION_LABEL[operation]}没完成，请稍后重试。`;
  }
}
