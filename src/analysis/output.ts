import { z } from 'zod';

export const FANTASY_ANALYSIS_SCHEMA_VERSION = 1 as const;

export const fantasyAnalysisSchema = z.object({
  schemaVersion: z
    .literal(FANTASY_ANALYSIS_SCHEMA_VERSION)
    .describe('The Seb fantasy analysis schema version.'),
  kind: z
    .enum([
      'player',
      'fantasy-matchup',
      'fantasy-league',
      'nfl-team',
      'news',
      'general',
    ])
    .describe('The primary subject type for this analysis.'),
  subject: z.string().trim().min(1).max(200).describe('The exact analysis subject.'),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(2_000)
    .describe('A concise conclusion that uses only retrieved evidence.'),
  recommendation: z
    .object({
      action: z.string().trim().min(1).max(500),
      rationale: z.string().trim().min(1).max(1_000),
    })
    .nullable()
    .describe('A recommended action, or null when the evidence does not support one.'),
  confidence: z.object({
    level: z.enum(['low', 'medium', 'high']),
    score: z.number().min(0).max(1),
    rationale: z.string().trim().min(1).max(1_000),
  }),
  metrics: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(100),
        value: z.union([z.number(), z.string().trim().min(1).max(200)]),
        unit: z.string().trim().min(1).max(50).nullable(),
        context: z.string().trim().min(1).max(500).nullable(),
      }),
    )
    .max(20),
  strengths: z.array(z.string().trim().min(1).max(500)).max(10),
  weaknesses: z.array(z.string().trim().min(1).max(500)).max(10),
  risks: z.array(z.string().trim().min(1).max(500)).max(10),
  assumptions: z.array(z.string().trim().min(1).max(500)).max(10),
  limitations: z.array(z.string().trim().min(1).max(500)).max(10),
});

export type FantasyAnalysis = z.infer<typeof fantasyAnalysisSchema>;

export function formatFantasyAnalysis(analysis: FantasyAnalysis): string {
  const sections = [
    `# ${analysis.subject}`,
    '',
    analysis.summary,
    '',
    `Confidence: ${analysis.confidence.level} (${formatPercent(analysis.confidence.score)})`,
    '',
    analysis.confidence.rationale,
  ];

  if (analysis.recommendation) {
    sections.push(
      '',
      '## Recommendation',
      '',
      analysis.recommendation.action,
      '',
      analysis.recommendation.rationale,
    );
  }
  if (analysis.metrics.length > 0) {
    sections.push(
      '',
      '## Metrics',
      '',
      '| Metric | Value | Context |',
      '| --- | ---: | --- |',
      ...analysis.metrics.map((metric) =>
        `| ${escapeTable(metric.name)} | ${escapeTable(formatMetric(metric.value, metric.unit))} | ${escapeTable(metric.context ?? '')} |`,
      ),
    );
  }

  appendList(sections, 'Strengths', analysis.strengths);
  appendList(sections, 'Weaknesses', analysis.weaknesses);
  appendList(sections, 'Risks', analysis.risks);
  appendList(sections, 'Assumptions', analysis.assumptions);
  appendList(sections, 'Limitations', analysis.limitations);
  return `${sections.join('\n').trim()}\n`;
}

function appendList(target: string[], title: string, values: readonly string[]): void {
  if (values.length === 0) return;
  target.push('', `## ${title}`, '', ...values.map((value) => `- ${value}`));
}

function escapeTable(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function formatMetric(value: string | number, unit: string | null): string {
  return `${value}${unit ? ` ${unit}` : ''}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}
