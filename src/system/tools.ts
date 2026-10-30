import { tool } from 'ai';
import { z } from 'zod';
import { searchSebDocs } from './docs.js';
import { getSystemMetadata, SYSTEM_TOPICS, type SystemMetadataContext } from './metadata.js';

export function createSystemTools(getContext: () => SystemMetadataContext = () => ({})) {
  return {
    inspectSystemDocs: tool({
      description:
        "Inspect Seb's own capabilities, commands, tools, skills, memory, limits, and design. Use it whenever the user asks what Seb can do, how a Seb feature works, or how Seb is built. Add query to search Seb's documentation for one feature, setting, limit, or number.",
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(2)
          .max(200)
          .optional()
          .describe('Words to find in the README and docs, for example "saved notes" or "sleeper cache ttl".'),
        topic: z
          .enum(SYSTEM_TOPICS)
          .optional()
          .describe(`The system topic to inspect: ${SYSTEM_TOPICS.join(', ')}`),
      }),
      inputExamples: [
        { input: { topic: 'capabilities' } },
        { input: { topic: 'commands' } },
        { input: { query: 'saved notes' } },
      ],
      execute: async ({ query, topic }) => ({
        ...getSystemMetadata(topic, getContext()),
        ...(query ? { documentation: await searchSebDocs(query) } : {}),
      }),
    }),
  };
}
