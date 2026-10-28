import { describe, expect, it } from 'vitest';
import { fileExtensionOf, openFailureKind, openFailureMessageKey } from '../src/renderer/lib/open-failure';

describe('open-failure（BUG-042-b 打开失败分类唯一真源）', () => {
  it('只把主进程的两个稳定标记分到专档，其余一律中性（绝不说"损坏"）', () => {
    expect(openFailureKind('artifact invalid')).toBe('invalid');
    expect(openFailureKind('artifact no-opener')).toBe('no-opener');
    expect(openFailureKind('artifact missing')).toBe('other');
    expect(openFailureKind('artifact unsafe')).toBe('other');
    expect(openFailureKind('EPERM: operation not permitted, open ...')).toBe('other');
    expect(openFailureKind('')).toBe('other');
  });

  it('扩展名：含点原样、无扩展/隐藏名回空', () => {
    expect(fileExtensionOf('报告.docx')).toBe('.docx');
    expect(fileExtensionOf('archive.tar.gz')).toBe('.gz');
    expect(fileExtensionOf('无扩展名')).toBe('');
    expect(fileExtensionOf('.hidden')).toBe('');
  });

  it('文案键映射（FileBrowser 与 ArtifactCard 共用，漂移即红）', () => {
    expect(openFailureMessageKey('invalid')).toBe('artifactCard.openFailed');
    expect(openFailureMessageKey('no-opener')).toBe('artifactCard.noAppToOpen');
    expect(openFailureMessageKey('other')).toBe('artifactCard.error');
  });
});
