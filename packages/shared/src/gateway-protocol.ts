import type { ApprovalDecision, ExecApprovalRequest, ExecApprovalResolved } from './types.js';

export interface GatewayReqFrame {
  type: 'req';
  id: string;
  method: GatewayReqMethod;
  params: Record<string, unknown>;
}

export interface GatewayResFrame {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export interface GatewayEventFrame<TPayload = Record<string, unknown>> {
  type: 'event';
  event: GatewayEventName;
  seq?: number;
  payload: TPayload;
}

export type GatewayFrame = GatewayReqFrame | GatewayResFrame | GatewayEventFrame;

export type GatewayReqMethod = 'connect' | 'exec.approval.resolve' | 'question.resolve' | (string & {});

export type GatewayEventName =
  | 'exec.approval.requested'
  | 'exec.approval.resolved'
  | 'question.requested'
  | 'question.resolved'
  | (string & {});

export interface ExecApprovalResolveParams {
  id: string;
  decision: ApprovalDecision;
}

/**
 * `question.resolve` 的作答形态。**两层 `answers`** 是网关 schema
 * （`QuestionAnswersSchema = { answers: Record<questionId, string[]> }`）决定的，
 * 而且网关侧 schema 是 `closedObject`：多一个字段都会被拒。
 */
export interface QuestionResolveAnswerParams {
  id: string;
  answers: { answers: Record<string, string[]> };
  resolvedBy?: string;
  resolutionId?: string;
}

/** 取消 / 跳过：agent 收到 `status: "no_answer"` 后自行决定怎么办。 */
export interface QuestionResolveCancelParams {
  id: string;
  cancel: true;
  resolvedBy?: string;
}

export type QuestionResolveParams = QuestionResolveAnswerParams | QuestionResolveCancelParams;

export interface ExecApprovalRequestedEventFrame extends GatewayEventFrame<ExecApprovalRequest> {
  event: 'exec.approval.requested';
  payload: ExecApprovalRequest;
}

export interface ExecApprovalResolvedEventFrame extends GatewayEventFrame<ExecApprovalResolved> {
  event: 'exec.approval.resolved';
  payload: ExecApprovalResolved;
}

export type GatewayAuth =
  | { token: string; deviceToken?: string }
  | { password: string; deviceToken?: string }
  | { bootstrapToken: string; deviceToken?: string };

export interface GatewayConnectParams {
  minProtocol: 3;
  maxProtocol: 3 | 4;
  client: {
    id: string;
    displayName: string;
    version: string;
    platform: string;
    mode: 'backend';
    deviceFamily?: string;
  };
  caps: string[];
  auth: GatewayAuth;
  role: 'operator';
  scopes: string[];
  device?: {
    id: string;
    publicKey: string;
    signature: string;
    signedAt: number;
    nonce: string;
  };
}

export interface GatewayClientConfig {
  id: string;
  name: string;
  url: string;
  auth: GatewayAuth;
  tlsVerify?: boolean;
}
