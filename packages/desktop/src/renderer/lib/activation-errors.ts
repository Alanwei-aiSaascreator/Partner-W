const ERROR_KEYS: Record<string, string> = {
  empty_key: 'activation.errorEmpty',
  license_not_found: 'activation.errorNotFound',
  license_inactive: 'activation.errorInactive',
  license_expired: 'activation.errorExpired',
  license_bound_elsewhere: 'activation.errorBoundElsewhere',
  activation_limit_reached: 'activation.errorLimit',
  activation_outcome_unknown: 'activation.errorOutcomeUnknown',
  not_configured: 'activation.errorNotConfigured',
};

export function activationErrorKey(errorCode: string | undefined): string {
  return ERROR_KEYS[errorCode ?? ''] ?? 'activation.errorGeneric';
}
