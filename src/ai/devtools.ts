import { registerTelemetry, type Telemetry } from 'ai';

let configured = false;
let devToolsTelemetry: Telemetry | null = null;

export async function configureAiDevTools(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!devToolsRequested(environment.SEB_DEVTOOLS)) return false;
  if (environment.NODE_ENV === 'production') {
    throw new Error('SEB_DEVTOOLS must remain disabled in production.');
  }
  if (configured) return true;
  const { DevToolsTelemetry } = await import('@ai-sdk/devtools');
  devToolsTelemetry = DevToolsTelemetry();
  registerTelemetry(devToolsTelemetry);
  configured = true;
  return true;
}

export function activeAiDevToolsTelemetry(): readonly Telemetry[] {
  return devToolsTelemetry ? [devToolsTelemetry] : [];
}

export function devToolsRequested(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error('SEB_DEVTOOLS must equal true, false, 1, or 0.');
}
