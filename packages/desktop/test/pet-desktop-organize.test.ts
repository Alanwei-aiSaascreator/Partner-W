import { describe, expect, it } from 'vitest';
import { planDesktopOrganize, petCategoryOf } from '../src/main/pet/desktop.js';

/**
 * 小盈「整理桌面」（2026-10-17 用户给的范围：可以看桌面、帮忙整理、**删除/移动前提示**）。
 *
 * 纯函数钉死两件事：**归到哪个文件夹**、**哪些文件不碰**。
 * 破坏性动作（真正移动/删除）不在纯函数里 —— 必须先给用户看计划再确认。
 */
describe('petCategoryOf', () => {
  it('按扩展名归类（大小写不敏感）', () => {
    expect(petCategoryOf('a.PNG')).toBe('images');
    expect(petCategoryOf('报告.pdf')).toBe('documents');
    expect(petCategoryOf('数据.xlsx')).toBe('sheets');
    expect(petCategoryOf('演示.pptx')).toBe('slides');
    expect(petCategoryOf('包.zip')).toBe('archives');
    expect(petCategoryOf('安装.exe')).toBe('installers');
    expect(petCategoryOf('音乐.mp3')).toBe('media');
    expect(petCategoryOf('未知.xyz')).toBe('other');
    expect(petCategoryOf('没有扩展名')).toBe('other');
  });
});

describe('planDesktopOrganize', () => {
  it('把文件按类别分组，空类不出现', () => {
    const plan = planDesktopOrganize([{ name: 'a.png' }, { name: 'b.jpg' }, { name: 'c.pdf' }, { name: 'd.zip' }]);
    expect(plan.map((group) => group.category)).toEqual(['images', 'documents', 'archives']);
    expect(plan[0].files).toEqual(['a.png', 'b.jpg']);
  });

  it('⭐ 不碰文件夹、隐藏文件与空名（用户说"删东西提示"，这里是"不乱动东西"）', () => {
    const plan = planDesktopOrganize([
      { name: '公文包', isDirectory: true },
      { name: '.secret' },
      { name: '' },
      { name: 'ok.txt' },
    ]);
    const all = plan.flatMap((group) => group.files);
    expect(all).toEqual(['ok.txt']);
  });

  it('同组内按名字稳定排序（同样的桌面两次给同样的计划）', () => {
    const plan = planDesktopOrganize([{ name: 'b.png' }, { name: 'a.png' }]);
    expect(plan[0].files).toEqual(['a.png', 'b.png']);
  });
});
