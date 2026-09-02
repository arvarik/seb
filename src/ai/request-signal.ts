import { AsyncLocalStorage } from 'node:async_hooks';

import type { ToolSet } from 'ai';

const REQUEST_SIGNAL = new AsyncLocalStorage<AbortSignal>();

export function currentRequestSignal(): AbortSignal | undefined {
  return REQUEST_SIGNAL.getStore();
}

/** Combines the current request cancellation with one bounded timeout. */
export function currentRequestSignalWithTimeout(timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = currentRequestSignal();
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function throwIfRequestAborted(): void {
  currentRequestSignal()?.throwIfAborted();
}

export function runWithRequestSignal<T>(
  signal: AbortSignal | undefined,
  run: () => T,
): T {
  signal?.throwIfAborted();
  return signal ? REQUEST_SIGNAL.run(signal, run) : run();
}

export function bindToolRequestSignals<TOOLS extends ToolSet>(tools: TOOLS): TOOLS {
  for (const definition of Object.values(tools)) {
    const execute = definition.execute;
    if (!execute) continue;
    definition.execute = ((input, options) => {
      return runWithRequestSignal(
        options.abortSignal,
        () => execute(input, options),
      );
    }) as typeof execute;
  }
  return tools;
}
