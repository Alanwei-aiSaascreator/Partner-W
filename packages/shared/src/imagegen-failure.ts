export type ImagegenFailureCode =
  | 'imagegen-block-invalid'
  | 'imagegen-unavailable'
  | 'imagegen-request-unconfirmed'
  | 'imagegen-generation-failed'
  | 'imagegen-result-unconfirmed'
  | 'imagegen-image-invalid'
  | 'imagegen-save-failed'
  | 'imagegen-workspace-changed';
export interface ImagegenFailure {
  code: ImagegenFailureCode;
}
