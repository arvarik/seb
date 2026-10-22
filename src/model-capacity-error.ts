const CAPACITY_MESSAGE =
  /high demand|service unavailable|temporarily unavailable|quota exceeded|rate limit|resource.*exhausted|overloaded|too many requests|bad gateway|gateway timeout/i;

const CAPACITY_STATUS_CODES = new Set([429, 502, 503, 504, 524, 529]);
const CAPACITY_ERROR_CODES = new Set([
  'insufficient-quota',
  'overloaded-error',
  'rate-limit-exceeded',
  'resource-exhausted',
]);

export type ModelErrorCategory =
  | 'authentication'
  | 'cancelled'
  | 'capacity'
  | 'incomplete'
  | 'invalid-request'
  | 'provider'
  | 'provider-timeout'
  | 'timeout';

export type ModelErrorSurface =
  | 'cli'
  | 'connector'
  | 'interactive'
  | 'neutral';

export interface ModelErrorContext {
  credentialName?: string;
  providerLabel: string;
}

const GEMINI_ERROR_CONTEXT: ModelErrorContext = {
  credentialName: 'GOOGLE_GENERATIVE_AI_API_KEY',
  providerLabel: 'Gemini',
};

export function isModelCapacityError(error: unknown, depth = 0): boolean {
  if (depth > 5) {
    return false;
  }
  if (typeof error === 'string') {
    return CAPACITY_MESSAGE.test(error) || /\b(?:429|502|503|504|524|529)\b/.test(error);
  }
  if (!error || typeof error !== 'object') {
    return false;
  }

  const value = error as Record<string, unknown>;
  const name = normalizedCode(value.name);
  if (name === 'aborterror' || name === 'timeouterror') return false;
  const code = normalizedCode(value.code);
  if (code && CAPACITY_ERROR_CODES.has(code)) return true;
  const status = numericStatus(value.statusCode ?? value.status);
  if (status !== null) {
    return CAPACITY_STATUS_CODES.has(status);
  }
  if (typeof value.message === 'string' && isModelCapacityError(value.message)) {
    return true;
  }

  return (
    isModelCapacityError(value.cause, depth + 1) ||
    isModelCapacityError(value.lastError, depth + 1) ||
    isModelCapacityError(value.error, depth + 1)
  );
}

export function classifyModelError(
  error: unknown,
  depth = 0,
): ModelErrorCategory | null {
  if (depth > 5 || !error) return null;
  if (typeof error === 'string') return classifyModelErrorText(error);
  if (typeof error !== 'object') return null;

  const value = error as Record<string, unknown>;
  const status = numericStatus(value.statusCode ?? value.status);
  const code = normalizedCode(value.code);
  const name = normalizedCode(value.name);
  if (name === 'incompletemodelresponseerror') return 'incomplete';
  if (name === 'timeouterror') return 'timeout';
  if (name === 'aborterror') return 'cancelled';
  if (
    status === 400 ||
    code === 'invalid-argument' ||
    code === 'invalid-request' ||
    code === 'invalid-request-error'
  ) {
    return 'invalid-request';
  }
  if (
    status === 401 ||
    status === 403 ||
    code === 'api-key-invalid' ||
    code === 'permission-denied' ||
    code === 'unauthenticated' ||
    code === 'unauthorized'
  ) {
    return 'authentication';
  }
  if (status === 408 || status === 504 || status === 524) return 'provider-timeout';
  if (status === 429 || status === 503 || status === 529) return 'capacity';
  if (status === 502) return 'provider';
  if (isModelCapacityError(error)) return 'capacity';
  if (
    code === 'etimedout' ||
    code === 'und-err-connect-timeout'
  ) {
    return 'timeout';
  }
  if (
    code === 'econnreset' ||
    code === 'econnrefused' ||
    code === 'und-err-socket' ||
    code === 'enotfound'
  ) {
    return 'provider';
  }
  if (
    name === 'apicallerror' ||
    name === 'ai-apicallerror' ||
    name === 'retryerror' ||
    name === 'ai-retryerror'
  ) {
    return 'provider';
  }

  return classifyModelError(value.message, depth + 1) ??
    classifyModelError(value.error, depth + 1) ??
    classifyModelError(value.cause, depth + 1) ??
    classifyModelError(value.lastError, depth + 1) ??
    classifyModelError(value.data, depth + 1);
}

export function formatModelErrorForUser(
  error: unknown,
  surface: ModelErrorSurface = 'neutral',
  context: ModelErrorContext = GEMINI_ERROR_CONTEXT,
): string {
  const healthCheck = surface === 'interactive'
    ? 'Run `/doctor`'
    : surface === 'cli'
    ? 'Run `seb doctor`'
    : 'Run the Seb health check';
  const diagnostics = surface === 'interactive'
    ? 'Run `/doctor` and `/stats session`'
    : surface === 'cli'
    ? 'Run `seb doctor` and `seb stats`'
    : surface === 'connector'
    ? 'Run the Seb health check and inspect the connector service logs'
    : 'Run the Seb health check and inspect the local statistics';
  switch (classifyModelError(error)) {
    case 'authentication':
      return context.credentialName
        ? `${context.providerLabel} rejected ${context.credentialName}. Update the credential. ${healthCheck}, then retry.`
        : `${context.providerLabel} rejected the authentication configuration. Check the endpoint authentication settings. ${healthCheck}, then retry.`;
    case 'cancelled':
      return `The request stopped before ${context.providerLabel} finished.`;
    case 'capacity':
      return `${context.providerLabel} has no available capacity. Try the request again or select another model.`;
    case 'incomplete':
      return `${context.providerLabel} stopped before it completed the answer. Ask a narrower question, then retry.`;
    case 'invalid-request':
      return `${context.providerLabel} rejected the request as invalid. ${diagnostics}, then retry.`;
    case 'provider':
      return `${context.providerLabel} encountered a connection or service issue. ${diagnostics}, then retry.`;
    case 'provider-timeout':
      return `The ${context.providerLabel} service timed out before it returned a response. Retry the request.`;
    case 'timeout':
      return `${context.providerLabel} did not finish before the request deadline. Retry the request.`;
    default:
      return `${context.providerLabel} could not complete the request. ${diagnostics}, then retry.`;
  }
}

function numericStatus(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string' || !/^\d{3}$/u.test(value.trim())) return null;
  return Number(value.trim());
}

function normalizedCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replaceAll('_', '-');
  return normalized || null;
}

function classifyModelErrorText(value: string): ModelErrorCategory | null {
  const text = value.slice(0, 1_000).toLowerCase();
  if (/\b(?:408|504|524)\b/u.test(text) || /gateway timeout/u.test(text)) {
    return 'provider-timeout';
  }
  if (CAPACITY_MESSAGE.test(text) || /\b(?:429|503|529)\b/u.test(text)) {
    return 'capacity';
  }
  if (/api key|permission denied|unauthenticated|unauthorized/u.test(text)) {
    return 'authentication';
  }
  if (/invalid[_ -](?:argument|request)|\b400\b/u.test(text)) {
    return 'invalid-request';
  }
  if (/timed? out|timeout/u.test(text)) return 'timeout';
  if (/\b502\b|bad gateway|econnreset|socket hang up|fetch failed/u.test(text)) {
    return 'provider';
  }
  return null;
}
