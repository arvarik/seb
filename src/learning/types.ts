import { z } from 'zod';
import { projectionParametersSchema } from '../projection/statistics.js';

export const learningSummarySchema = z.object({
  samples: z.number().int().nonnegative(),
  mae: z.number().finite().nonnegative().nullable(),
  rmse: z.number().finite().nonnegative().nullable(),
  bias: z.number().finite().nullable(),
}).strict();
const entitySchema = z.object({
  name: z.string().max(100), team: z.string().max(10), position: z.string().max(10),
  games: z.number().int().nonnegative(), averagePoints: z.number().finite(),
  recentPoints: z.number().finite(), averageOpportunities: z.number().finite(),
  recentOpportunities: z.number().finite(),
}).strict();
export const learningRevisionSchema = z.object({
  schemaVersion: z.literal(1), modelVersion: z.literal('ensemble-v1'),
  season: z.number().int().min(1999).max(2100), throughWeek: z.number().int().min(1).max(18),
  createdAt: z.iso.datetime(), dataChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  scoring: z.record(z.string(), z.number().finite()),
  parameters: projectionParametersSchema,
  candidate: projectionParametersSchema,
  promoted: z.boolean(), reason: z.string().max(1000),
  validationWeeks: z.array(z.number().int().min(1).max(18)),
  baseline: learningSummarySchema, candidateMetrics: learningSummarySchema,
  residuals: z.record(z.string(), z.array(z.number().finite()).max(5000)),
  players: z.record(z.string(), entitySchema),
  teams: z.record(z.string(), learningSummarySchema),
  sources: z.array(z.string().url()).max(10),
}).strict();
export type LearningRevision = z.infer<typeof learningRevisionSchema>;
export const projectionOverrideSchema = z.object({
  schemaVersion: z.literal(1),
  enabled: z.boolean().optional(),
  parameters: projectionParametersSchema.optional(),
}).strict();
