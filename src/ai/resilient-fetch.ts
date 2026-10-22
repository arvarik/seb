export * from '../data/resilient-fetch.js';
import { DEFAULT_REQUEST_POLICY, type RequestPolicy } from '../data/resilient-fetch.js';

export const DEFAULT_MODEL_REQUEST_POLICY: RequestPolicy = {
  ...DEFAULT_REQUEST_POLICY,
  circuitBreakerCooldownMs: 60_000,
  maxRetryDelayMs: 8_000,
  retryBaseDelayMs: 500,
  timeoutMs: 30_000,
};
