import type { RelayLivenessPublicState } from '@clawwork/shared';

/**
 * relay 存活状态 → 横幅该不该出现、说哪句话（纯函数，组件只渲染）。
 *
 * 只有 `down` 出横幅：`unknown`＝还没结论 / 不在探活窗口（启动期有自己的表达），
 * `up`＝一切正常。与 gateway 横幅同一条纪律：**"不知道"不许说成"断了"**
 * （判据链的由来见 `gateway-display-phase.ts` 的实机现场）。
 */
export interface RelayConnectionNotice {
  textKey: 'connection.relayUnreachable';
}

export function deriveRelayConnectionNotice(input: {
  liveness: RelayLivenessPublicState | null | undefined;
}): RelayConnectionNotice | null {
  return input.liveness?.phase === 'down' ? { textKey: 'connection.relayUnreachable' } : null;
}
