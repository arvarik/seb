import { tool } from 'ai';
import { z } from 'zod';
import { getSystemMetadata, SYSTEM_TOPICS } from './metadata.js';

export function createSystemTools() {
  return {
    inspectSystemDocs: tool({
      description:
        "Inspect Seb's technical architecture, system design, deterministic algorithms, data sources, storage schemas, and capabilities. Use this when the user asks how Seb works, how projections are calculated, how storage/privacy works, what tools exist, or how Seb is designed.",
      inputSchema: z.object({
        topic: z
          .enum(SYSTEM_TOPICS)
          .optional()
          .describe(
            'The system topic to inspect: overview, architecture, projections, sources, storage, learning, models, connectors, cli',
          ),
      }),
      inputExamples: [
        { input: { topic: 'architecture' } },
        { input: { topic: 'projections' } },
        { input: { topic: 'storage' } },
      ],
      execute: async ({ topic }) => {
        return getSystemMetadata(topic);
      },
    }),
  };
}
