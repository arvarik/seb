export { MODEL_FAMILIES, isModelFamily } from './model-provider.js';
import {
  MODEL_PROVIDER_LABELS,
  isModelFamily,
  ModelProviderConfigurationError,
  validateModelId,
  validateModelProviderApiKey,
  type ModelProviderId,
  type ResolvedModelProvider,
} from './model-provider.js';

export interface ModelFamilyResolutionOptions {
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

const MAX_CATALOG_BYTES = 1024 * 1024;
const MAX_CATALOG_PAGES = 20;
const MAX_CATALOG_MODELS = 10_000;

/** Resolve both families from one complete catalog. Never persist the resolved version. */
export async function resolveModelFamilies(
  selection: ResolvedModelProvider,
  options: ModelFamilyResolutionOptions = {},
): Promise<ResolvedModelProvider> {
  const primaryFamily = isModelFamily(selection.provider, selection.model);
  const fallbackFamily = isModelFamily(selection.provider, selection.fallbackModel);
  if (!primaryFamily && !fallbackFamily) return selection;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  signal.throwIfAborted();
  let models: string[];
  try {
    models = await readModelCatalog(selection, options.fetch ?? globalThis.fetch, signal);
  } catch {
    signal.throwIfAborted();
    throw new ModelProviderConfigurationError(
      `Seb could not read the ${MODEL_PROVIDER_LABELS[selection.provider]} model list. Retry, or enter an exact model ID to skip discovery.`,
    );
  }
  const resolve = (model: string, family: boolean): string => {
    if (!family) return model;
    const latest = latestModelInFamily(selection.provider, model, models);
    if (!latest) {
      throw new ModelProviderConfigurationError(
        `No stable ${model} model appears in the provider model list. Enter an exact model ID or choose another family.`,
      );
    }
    return latest;
  };
  return {
    ...selection,
    model: resolve(selection.model, primaryFamily),
    fallbackModel: resolve(selection.fallbackModel, fallbackFamily),
  };
}

/** Compare numeric versions, then snapshots. Exclude previews and other model classes. */
export function latestModelInFamily(
  provider: ModelProviderId,
  family: string,
  models: readonly string[],
): string | undefined {
  if (!isModelFamily(provider, family)) return undefined;
  const candidates = models.flatMap((id) => {
    const version = familyVersion(provider, family, id);
    return version ? [{ id, version }] : [];
  });
  candidates.sort((left, right) => {
    for (let index = 0; index < Math.max(left.version.length, right.version.length); index += 1) {
      const difference = (right.version[index] ?? 0) - (left.version[index] ?? 0);
      if (difference) return difference;
    }
    return left.id.localeCompare(right.id);
  });
  return candidates[0]?.id;
}

function familyVersion(provider: ModelProviderId, family: string, id: string): number[] | undefined {
  let match: RegExpMatchArray | null = null;
  if (provider === 'google') {
    const kind = family.slice('gemini-'.length);
    match = id.match(new RegExp(`^gemini-(\\d+(?:\\.\\d+)?)-${kind}(?:-(\\d{3}))?$`, 'u'));
  } else if (provider === 'anthropic') {
    const kind = family.slice('claude-'.length);
    match = id.match(new RegExp(`^claude-${kind}-(\\d+(?:[.-]\\d{1,2})?)(?:-(\\d{8}))?$`, 'u')) ??
      id.match(new RegExp(`^claude-(\\d+(?:-\\d{1,2})?)-${kind}(?:-(\\d{8}))?$`, 'u'));
  } else if (provider === 'openai') {
    const kind = family === 'gpt' ? '' : `-${family.slice('gpt-'.length)}`;
    match = id.match(new RegExp(`^gpt-(\\d+(?:\\.\\d+)?)${kind}(?:-(\\d{4}-\\d{2}-\\d{2}))?$`, 'u'));
  }
  if (!match?.[1]) return undefined;
  const version = match[1].split(/[.-]/u).map(Number);
  return [version[0] ?? 0, version[1] ?? 0, Number(match[2]?.replaceAll('-', '') ?? 0)];
}

async function readModelCatalog(
  selection: ResolvedModelProvider,
  fetch: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<string[]> {
  const provider = selection.provider;
  const key = validateModelProviderApiKey(selection.apiKey ?? '');
  const endpoint = provider === 'google'
    ? 'https://generativelanguage.googleapis.com/v1beta/models'
    : provider === 'anthropic' ? 'https://api.anthropic.com/v1/models'
      : 'https://api.openai.com/v1/models';
  const headers: Record<string, string> = provider === 'google'
    ? { 'x-goog-api-key': key }
    : provider === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      : { Authorization: `Bearer ${key}` };
  const models = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let remainingBytes = MAX_CATALOG_BYTES;
  for (let page = 0; page < MAX_CATALOG_PAGES; page += 1) {
    const url = new URL(endpoint);
    if (provider === 'google') {
      url.searchParams.set('pageSize', '1000');
      if (cursor) url.searchParams.set('pageToken', cursor);
    } else if (provider === 'anthropic') {
      url.searchParams.set('limit', '1000');
      if (cursor) url.searchParams.set('after_id', cursor);
    }
    signal.throwIfAborted();
    const response = await fetch(url, { headers, redirect: 'error', signal });
    if (!response.ok || response.redirected) throw new Error('Model list request failed.');
    const text = await readCatalogText(response, remainingBytes, signal);
    remainingBytes -= Buffer.byteLength(text, 'utf8');
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) throw new Error('Invalid model list.');
    const entries = provider === 'google' ? value.models : value.data;
    if (!Array.isArray(entries)) throw new Error('Invalid model list.');
    if (entries.length + models.size > MAX_CATALOG_MODELS) throw new Error('Too many models.');
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      if (typeof entry.shutdown_date === 'string' && Date.parse(entry.shutdown_date) <= Date.now()) continue;
      if (provider === 'google' && (!Array.isArray(entry.supportedGenerationMethods) ||
        !entry.supportedGenerationMethods.includes('generateContent'))) continue;
      const rawId = provider === 'google' ? entry.name : entry.id;
      if (typeof rawId !== 'string') continue;
      try {
        models.add(validateModelId(provider === 'google' ? rawId.replace(/^models\//u, '') : rawId));
      } catch {
        // Invalid entries cannot become request paths.
      }
    }
    const next = provider === 'google' ? value.nextPageToken
      : value.has_more === true ? value.last_id : undefined;
    if (next === undefined || next === null || next === '') {
      if (value.has_more === true) throw new Error('Missing model cursor.');
      return [...models];
    }
    if (typeof next !== 'string' || next.length > 2048 || cursors.has(next)) {
      throw new Error('Invalid model cursor.');
    }
    cursors.add(next);
    cursor = next;
  }
  throw new Error('The model list is incomplete.');
}

async function readCatalogText(response: Response, limit: number, signal: AbortSignal): Promise<string> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('Model list exceeds 1 MiB.');
  }
  if (!response.body) throw new Error('Empty model list.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('Model list exceeds 1 MiB.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
