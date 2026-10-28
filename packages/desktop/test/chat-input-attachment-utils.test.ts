// @vitest-environment jsdom

/**
 * `processAttachmentFiles`（粘贴 / 选入的入料闸门）——2026-10-07 · 质量战役区 2 · P2-2。
 *
 * 入料侧 100MB（`MAX_ATTACHMENT_SIZE`）与发送侧预算（默认 18MiB 折算）之间差着一大截：
 * 以前收得进、发不出、**而且一句话都没有**。现在超发送预算的文件在**进来这一刻**提示
 * （合并成一条、文件名进 description），但**不拦截** —— 发送侧闸门仍在。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ toastError: vi.fn(), toastWarning: vi.fn() }));

vi.mock('../src/renderer/lib/toast', () => ({
  toast: { error: mocks.toastError, warning: mocks.toastWarning },
}));

import {
  MAX_ATTACHMENT_SIZE,
  MAX_SEND_MATERIAL_BYTES,
  materialBudgetMb,
} from '../src/renderer/components/ChatInput/constants';
import { processAttachmentFiles } from '../src/renderer/components/ChatInput/utils';

const t = (key: string) => key;

/** 造一个"size 很大但不用真分配内存"的 File（`size` 在实例上盖掉原型 getter）。 */
function fileWithSize(name: string, size: number, type = 'application/octet-stream'): File {
  const file = new File([new Uint8Array(1)], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

beforeEach(() => {
  mocks.toastError.mockReset();
  mocks.toastWarning.mockReset();
  Object.assign(URL, {
    createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
    revokeObjectURL: vi.fn(),
  });
});

describe('processAttachmentFiles：发得出去的边界提前说（P2-2）', () => {
  it('⭐ 单文件超发送预算 ⇒ 收下 + 一条提示（不拦、不静默），文案带上预算的 MB 数', () => {
    const accepted = processAttachmentFiles([fileWithSize('big.zip', MAX_SEND_MATERIAL_BYTES + 1)], t);

    expect(accepted, '只提示不拦截').toHaveLength(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'chatInput.materialSingleTooLarge',
      expect.objectContaining({ description: 'big.zip' }),
    );
    // 文案参数与闸门同源（materialBudgetMb 现算，不是写死的 25）
    expect(materialBudgetMb(MAX_SEND_MATERIAL_BYTES)).toBe(18);
  });

  it('多个超预算文件合并成一条提示（不刷屏），文件名都在 description 里', () => {
    const accepted = processAttachmentFiles(
      [fileWithSize('a.bin', MAX_SEND_MATERIAL_BYTES + 1), fileWithSize('b.bin', MAX_SEND_MATERIAL_BYTES + 2)],
      t,
    );

    expect(accepted).toHaveLength(2);
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1);
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'chatInput.materialSingleTooLarge',
      expect.objectContaining({ description: 'a.bin、b.bin' }),
    );
  });

  it('正常文件 ⇒ 一条提示都没有', () => {
    const accepted = processAttachmentFiles([fileWithSize('small.pdf', 1024)], t);

    expect(accepted).toHaveLength(1);
    expect(mocks.toastWarning).not.toHaveBeenCalled();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it('超 100MB 入料闸门 ⇒ 拒收 + attachmentTooLarge（不再叠发"发送时会带不上"）', () => {
    const accepted = processAttachmentFiles([fileWithSize('huge.iso', MAX_ATTACHMENT_SIZE + 1)], t);

    expect(accepted).toHaveLength(0);
    // ⚠️ 这里 toast 模块被直替：错误文案是 `t(key, {fileName})` 的**返回值**（单参调用），
    //    文件名被 t 吃掉（本文件 t 桩只回 key）——与真实 i18n 的插值路径一致。
    expect(mocks.toastError).toHaveBeenCalledWith('chatInput.attachmentTooLarge');
    expect(mocks.toastWarning, '已被拒收的文件不必再提发送预算').not.toHaveBeenCalled();
  });
});
