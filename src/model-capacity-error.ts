const CAPACITY_MESSAGE =
  /high demand|service unavailable|temporarily unavailable|quota exceeded|rate limit/i;

export function isModelCapacityError(error: unknown, depth = 0): boolean {
  if (depth > 5) {
    return false;
  }
  if (typeof error === 'string') {
    return CAPACITY_MESSAGE.test(error) || /\b(?:429|503)\b/.test(error);
  }
  if (!error || typeof error !== 'object') {
    return false;
  }

  const value = error as Record<string, unknown>;
  if (
    value.statusCode === 429 ||
    value.statusCode === 503 ||
    value.status === 429 ||
    value.status === 503
  ) {
    return true;
  }
  if (typeof value.message === 'string' && isModelCapacityError(value.message)) {
    return true;
  }

  return (
    isModelCapacityError(value.cause, depth + 1) ||
    isModelCapacityError(value.lastError, depth + 1)
  );
}
