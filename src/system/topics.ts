// The command registry and the metadata module both read this list, so it lives apart to avoid an import cycle.
export const SYSTEM_TOPICS = [
  'overview',
  'capabilities',
  'commands',
  'tools',
  'skills',
  'memory',
  'architecture',
  'projections',
  'sources',
  'storage',
  'learning',
  'models',
  'connectors',
  'cli',
] as const;

export type SystemTopic = (typeof SYSTEM_TOPICS)[number];

export function isSystemTopic(value: unknown): value is SystemTopic {
  return typeof value === 'string' && (SYSTEM_TOPICS as readonly string[]).includes(value);
}
