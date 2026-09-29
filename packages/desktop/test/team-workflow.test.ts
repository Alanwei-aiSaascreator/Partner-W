import { describe, expect, it } from 'vitest';
import { buildTeamWorkflowContext, mergeTeamWorkflowContext } from '../src/renderer/lib/team-workflow';

describe('reliable single-agent team workflow', () => {
  it('requires the four phases in order and keeps delivery honest', () => {
    const prompt = buildTeamWorkflowContext();

    const strategy = prompt.indexOf('1. 策略');
    const creation = prompt.indexOf('2. 创作');
    const quality = prompt.indexOf('3. 质检');
    const revision = prompt.indexOf('必要修订');
    const delivery = prompt.indexOf('4. 交付');
    expect(strategy).toBeGreaterThanOrEqual(0);
    expect(creation).toBeGreaterThan(strategy);
    expect(quality).toBeGreaterThan(creation);
    expect(revision).toBeGreaterThan(quality);
    expect(delivery).toBeGreaterThan(revision);
    expect(prompt).toContain('当前实际可用的工具');
    expect(prompt).toContain('产物确实存在');
    expect(prompt).toContain('验证');
    expect(prompt).toContain('不要声称完成');
    expect(prompt).toContain('sessions_spawn');
    expect(prompt).toContain('sessions_send');
  });

  it('places the team contract before other hidden context', () => {
    const merged = mergeTeamWorkflowContext('<artifacts-index>existing</artifacts-index>');
    expect(merged).toMatch(/^<team-workflow-contract>\n【团队任务执行合同/);
    expect(merged.indexOf('<artifacts-index>')).toBeGreaterThan(merged.indexOf('交付'));
  });
});
