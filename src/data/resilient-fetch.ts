const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

type Fetch = typeof globalThis.fetch;

export interface RequestPolicy {
  circuitBreakerCooldownMs: number;
  circuitBreakerThreshold: number;
  maxAttempts: number;
  maxRetryDelayMs: number;
  retryBaseDelayMs: number;
  timeoutMs: number;
}

export interface ResilientFetchOptions {
  fetch?: Fetch;
  now?: () => number;
  policy?: Partial<RequestPolicy>;
  random?: () => number;
  sleep?: (
    delayMs: number,
    signal?: AbortSignal | null,
  ) => Promise<void>;
}

export interface RequestAttemptObserver {
  (event: {
    attempt: number;
    delayMs: number | null;
    status: number | null;
    url: string;
  }): void;
}

export const DEFAULT_REQUEST_POLICY: RequestPolicy = {
  circuitBreakerCooldownMs: 30_000,
  circuitBreakerThreshold: 5,
  maxAttempts: 3,
  maxRetryDelayMs: 5_000,
  retryBaseDelayMs: 250,
  timeoutMs: 15_000,
};

export class CircuitOpenError extends Error {
  readonly retryAt: string;
  readonly url: string;

  constructor(url: string, retryAt: string) {
    super(`The request circuit is open until ${retryAt}.`);
    this.name = 'CircuitOpenError';
    this.retryAt = retryAt;
    this.url = url;
  }
}

export class ResilientFetch {
  private readonly circuits = new Map<string, { consecutiveFailures: number; openUntil: number }>();
  private readonly fetchImplementation: Fetch;
  private readonly now: () => number;
  private readonly policy: RequestPolicy;
  private readonly random: () => number;
  private readonly sleep: (
    delayMs: number,
    signal?: AbortSignal | null,
  ) => Promise<void>;

  constructor(options: ResilientFetchOptions = {}) {
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.policy = { ...DEFAULT_REQUEST_POLICY, ...options.policy };
    validatePolicy(this.policy);
    this.random = options.random ?? Math.random;
    this.sleep = options.sleep ?? wait;
  }

  async request(
    input: string | URL,
    init: RequestInit = {},
    onAttempt?: RequestAttemptObserver,
  ): Promise<Response> {
    const url = String(input);
    init.signal?.throwIfAborted();
    const circuit = this.circuit(url);
    this.assertCircuit(url, circuit);
    let finalError: unknown;

    for (let attempt = 1; attempt <= this.policy.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchImplementation(input, {
          ...init,
          signal: combineSignals(init.signal, AbortSignal.timeout(this.policy.timeoutMs)),
        });
        if (init.signal?.aborted) {
          void response.body?.cancel().catch(() => undefined);
          throw abortReason(init.signal);
        }
        if (!RETRYABLE_STATUS_CODES.has(response.status)) {
          this.recordSuccess(circuit);
          onAttempt?.({ attempt, delayMs: null, status: response.status, url });
          return response;
        }

        finalError = new Error(`The source returned HTTP ${response.status}.`);
        if (attempt === this.policy.maxAttempts) {
          this.recordFailure(circuit);
          onAttempt?.({ attempt, delayMs: null, status: response.status, url });
          return response;
        }

        const delayMs = retryDelay(
          response.headers.get('retry-after'),
          attempt,
          this.policy,
          this.random,
          this.now(),
        );
        onAttempt?.({ attempt, delayMs, status: response.status, url });
        void response.body?.cancel().catch(() => undefined);
        await waitForRetry(this.sleep(delayMs, init.signal), init.signal);
      } catch (error) {
        finalError = error;
        if (init.signal?.aborted) {
          throw abortReason(init.signal);
        }
        if (attempt === this.policy.maxAttempts) {
          this.recordFailure(circuit);
          throw error;
        }
        const delayMs = retryDelay(
          null,
          attempt,
          this.policy,
          this.random,
          this.now(),
        );
        onAttempt?.({ attempt, delayMs, status: null, url });
        await waitForRetry(this.sleep(delayMs, init.signal), init.signal);
      }
    }

    this.recordFailure(circuit);
    throw finalError ?? new Error('The request failed without an error response.');
  }

  /** Without a URL, report aggregate diagnostics for existing callers. */
  state(url?: string): { consecutiveFailures: number; openUntil: string | null } {
    const states = url ? [this.circuit(url)] : [...this.circuits.values()];
    const openUntil = Math.max(0, ...states.map((state) => state.openUntil));
    return {
      consecutiveFailures: states.reduce((sum, state) => sum + state.consecutiveFailures, 0),
      openUntil: openUntil > this.now() ? new Date(openUntil).toISOString() : null,
    };
  }

  private circuit(url: string): { consecutiveFailures: number; openUntil: number } {
    const origin = new URL(url).origin;
    let circuit = this.circuits.get(origin);
    if (!circuit) {
      circuit = { consecutiveFailures: 0, openUntil: 0 };
      this.circuits.set(origin, circuit);
    }
    return circuit;
  }

  private assertCircuit(url: string, circuit: { consecutiveFailures: number; openUntil: number }): void {
    if (circuit.openUntil > this.now()) {
      throw new CircuitOpenError(url, new Date(circuit.openUntil).toISOString());
    }
    if (circuit.openUntil !== 0) {
      circuit.openUntil = 0;
      circuit.consecutiveFailures = 0;
    }
  }

  private recordFailure(circuit: { consecutiveFailures: number; openUntil: number }): void {
    circuit.consecutiveFailures += 1;
    if (circuit.consecutiveFailures >= this.policy.circuitBreakerThreshold) {
      circuit.openUntil = this.now() + this.policy.circuitBreakerCooldownMs;
    }
  }

  private recordSuccess(circuit: { consecutiveFailures: number; openUntil: number }): void {
    circuit.consecutiveFailures = 0;
    circuit.openUntil = 0;
  }
}

function retryDelay(
  retryAfter: string | null,
  attempt: number,
  policy: RequestPolicy,
  random: () => number,
  now: number,
): number {
  const serverDelay = parseRetryAfter(retryAfter, now);
  if (serverDelay !== null) {
    return Math.min(serverDelay, policy.maxRetryDelayMs);
  }
  const ceiling = Math.min(
    policy.retryBaseDelayMs * 2 ** (attempt - 1),
    policy.maxRetryDelayMs,
  );
  return Math.floor(Math.max(0, Math.min(random(), 1)) * ceiling);
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function combineSignals(
  signal: AbortSignal | null | undefined,
  timeout: AbortSignal,
): AbortSignal {
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function wait(
  delayMs: number,
  signal?: AbortSignal | null,
): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForRetry(
  pending: Promise<void>,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  if (!signal) return pending;
  if (signal.aborted) {
    void pending.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    pending.then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    }).catch(() => undefined);
  });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function validatePolicy(policy: RequestPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`The request policy value ${name} must be nonnegative.`);
    }
  }
  if (!Number.isInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new RangeError('The request policy needs at least one attempt.');
  }
  if (!Number.isInteger(policy.circuitBreakerThreshold) || policy.circuitBreakerThreshold < 1) {
    throw new RangeError('The circuit breaker threshold must be at least one.');
  }
}
