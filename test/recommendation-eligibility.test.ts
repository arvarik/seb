import { describe, expect, it } from 'vitest';

import {
  buildFreeformRecommendationEvidence,
  buildRecommendationEvidence,
  enforceFreeformRecommendation,
  enforceRecommendationEligibility,
  questionRequestsRecommendation,
  recommendationContextQuestion,
  type RecommendationEvidence,
  type RecommendationToolResult,
} from '../src/analysis/recommendation-eligibility.js';
import type { FantasyAnalysis } from '../src/analysis/output.js';
import type { DataSourceRecord } from '../src/sources.js';

describe('recommendation eligibility', () => {
  it('detects action requests without classifying a factual lookup', () => {
    expect(questionRequestsRecommendation('Should I start Example Player?')).toBe(true);
    expect(questionRequestsRecommendation('Rank my waiver targets.')).toBe(true);
    expect(questionRequestsRecommendation('Would you trade Player A for Player B?')).toBe(true);
    expect(questionRequestsRecommendation('Show Example Player statistics.')).toBe(false);
    expect(questionRequestsRecommendation('When is my trade deadline?')).toBe(false);
    expect(questionRequestsRecommendation('When does the NFL season start?')).toBe(false);
    expect(questionRequestsRecommendation('Show my waiver rules.')).toBe(false);
  });

  it('keeps the recommendation gate for a direct comparison follow-up', () => {
    const question = recommendationContextQuestion(
      'What about Player B instead?',
      'Should I start Player A?',
    );

    expect(questionRequestsRecommendation(question)).toBe(true);
    expect(recommendationContextQuestion(
      'Show the Week 4 schedule.',
      'Should I start Player A?',
    )).toBe('Show the Week 4 schedule.');
  });

  it('replaces an unsafe freeform recommendation before display', () => {
    const evidenceResult = buildFreeformRecommendationEvidence({
      question: 'Should I start Example Player?',
      sources: [],
      toolResults: [],
    });
    const result = enforceFreeformRecommendation(
      'Start Example Player with high confidence.',
      evidenceResult,
    );

    expect(result.eligibility.outcome).toBe('blocked');
    expect(result.answer).toContain('Decision unavailable');
    expect(result.answer).not.toContain('Start Example Player with high confidence');
  });

  it('allows a player action with fresh identity, injury, news, and scoring evidence', () => {
    const analysis = exampleAnalysis();
    const sources = [directSource(), webSource()];
    const toolResults: RecommendationToolResult[] = [
      {
        toolName: 'findPlayers',
        output: [{
          playerId: 'player-1',
          name: 'Example Player',
          injuryStatus: null,
          practiceParticipation: 'Full',
        }],
      },
      { toolName: 'searchCurrentNews', output: { result: 'No reported injury.' } },
      {
        toolName: 'getLeagueOverview',
        output: { league: { scoring_settings: { rec: 1 } } },
      },
    ];

    const evidence = buildRecommendationEvidence({
      analysis,
      question: 'Should I start Example Player in my league?',
      sources,
      toolResults,
    });
    const result = enforceRecommendationEligibility(analysis, evidence);

    expect(evidence).toEqual({
      currentEvidence: 'fresh',
      identity: 'resolved',
      injury: 'present',
      leagueScoring: 'present',
      projection: 'not-required',
    });
    expect(result.eligibility).toEqual({ outcome: 'allowed', reasons: [] });
    expect(result.analysis).toEqual(analysis);
    expect(result.analysis).not.toBe(analysis);
  });

  it.each([
    ['missing current evidence', evidence({ currentEvidence: 'missing' }), 'No current source'],
    ['stale current evidence', evidence({ currentEvidence: 'stale' }), 'source data is stale'],
    ['an ambiguous player', evidence({ identity: 'ambiguous' }), 'identity is ambiguous'],
    ['a missing player identity', evidence({ identity: 'missing' }), 'identity is not resolved'],
    ['missing injury evidence', evidence({ injury: 'missing' }), 'injury evidence is missing'],
    ['missing league scoring', evidence({ leagueScoring: 'missing' }), 'scoring settings are missing'],
    ['an ineligible projection', evidence({ projection: 'ineligible' }), 'deterministic recommendation rules'],
  ])('blocks a recommendation with %s', (_label, recommendationEvidence, reason) => {
    const result = enforceRecommendationEligibility(
      exampleAnalysis(),
      recommendationEvidence,
    );

    expect(result.eligibility.outcome).toBe('blocked');
    expect(result.eligibility.reasons.join(' ')).toContain(reason);
    expect(result.analysis.recommendation).toBeNull();
    expect(result.analysis.confidence.level).toBe('low');
    expect(result.analysis.confidence.score).toBeLessThanOrEqual(0.39);
    expect(result.analysis.limitations.at(-1)).toContain(
      'Seb withheld the recommendation:',
    );
  });

  it('downgrades a recommendation when fresh evidence has stale supplements', () => {
    const result = enforceRecommendationEligibility(
      exampleAnalysis(),
      evidence({ currentEvidence: 'mixed' }),
    );

    expect(result.eligibility.outcome).toBe('downgraded');
    expect(result.analysis.recommendation).not.toBeNull();
    expect(result.analysis.confidence).toMatchObject({
      level: 'medium',
      score: 0.69,
    });
    expect(result.analysis.limitations.at(-1)).toContain('supporting data is stale');
  });

  it('reports no gate action when the model gives no recommendation', () => {
    const analysis = { ...exampleAnalysis(), recommendation: null };
    const result = enforceRecommendationEligibility(
      analysis,
      evidence({ currentEvidence: 'missing' }),
    );

    expect(result.eligibility).toEqual({ outcome: 'not-applicable', reasons: [] });
    expect(result.analysis.recommendation).toBeNull();
  });

  it('detects ambiguous player matches without reading the model response', () => {
    const evidenceResult = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'Should I start Alex Smith in my league?',
      sources: [directSource(), webSource()],
      toolResults: [
        {
          toolName: 'findPlayers',
          output: [
            { playerId: 'one', injuryStatus: null },
            { playerId: 'two', injuryStatus: null },
          ],
        },
        { toolName: 'searchCurrentNews', output: {} },
        {
          toolName: 'getLeagueOverview',
          output: { league: { scoring_settings: { rec: 1 } } },
        },
      ],
    });

    expect(evidenceResult.identity).toBe('ambiguous');
  });

  it('accepts an explicit resolution after a broad player search', () => {
    const evidenceResult = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'Should I start Alex Smith in my league?',
      sources: [directSource(), webSource()],
      toolResults: [
        {
          toolName: 'findPlayers',
          output: [
            { playerId: 'one', injuryStatus: null },
            { playerId: 'two', injuryStatus: null },
          ],
        },
        {
          toolName: 'resolvePlayerIdentity',
          output: { resolution: { status: 'resolved', identity: { canonicalId: 'one' } } },
        },
        { toolName: 'searchCurrentNews', output: {} },
        {
          toolName: 'getLeagueOverview',
          output: { league: { scoring_settings: { rec: 1 } } },
        },
      ],
    });

    expect(evidenceResult.identity).toBe('resolved');
  });

  it('uses a scoring-aware projection as identity, status, and scoring evidence', () => {
    const evidenceResult = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'Should I start Example Player in my league?',
      sources: [directSource(), webSource()],
      toolResults: [
        {
          toolName: 'projectPlayer',
          output: {
            player: { playerId: 'player-1', name: 'Example Player' },
            limitations: ['The Sleeper injury field is not an official injury report.'],
            recommendationEligible: true,
            scoring: { usedSettings: ['rec', 'rec_yd'], ignoredSettings: [] },
          },
        },
        { toolName: 'searchCurrentNews', output: {} },
      ],
    });

    expect(evidenceResult).toEqual({
      currentEvidence: 'fresh',
      identity: 'resolved',
      injury: 'present',
      leagueScoring: 'present',
      projection: 'eligible',
    });
  });

  it.each([
    [
      'waiver',
      'rankWaiverTargets',
      {
        methodology: { scoringKeysUsed: ['rec', 'rec_yd'] },
        targets: [{
          player: {
            injuryStatus: null,
            name: 'Waiver Player',
            playerId: 'waiver-1',
          },
        }],
      },
    ],
    [
      'trade',
      'analyzeTradeImpact',
      {
        give: {
          players: [{ injuryStatus: null, name: 'Give Player', playerId: 'give-1' }],
        },
        receive: {
          players: [{ injuryStatus: null, name: 'Receive Player', playerId: 'receive-1' }],
        },
        scoring: { ignoredSettings: [], usedSettings: ['rec', 'rec_yd'] },
      },
    ],
  ])('uses %s analysis as identity, status, and scoring evidence', (
    _label,
    toolName,
    output,
  ) => {
    const evidenceResult = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'What fantasy action should I take in this league?',
      sources: [directSource(), webSource()],
      toolResults: [
        { toolName, output },
        { toolName: 'searchCurrentNews', output: {} },
      ],
    });

    expect(evidenceResult).toEqual({
      currentEvidence: 'fresh',
      identity: 'resolved',
      injury: 'present',
      leagueScoring: 'present',
      projection: 'not-required',
    });
  });

  it('treats stale-if-error data as mixed only when fresh evidence also exists', () => {
    const mixed = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'Which roster should I favor in this fantasy matchup?',
      sources: [directSource(), { ...directSource(), id: 'stale', cacheOutcome: 'stale-if-error' }],
      toolResults: [{ toolName: 'predictMatchup', output: { favoredRosterId: 4 } }],
    });
    const stale = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'Which roster should I favor in this fantasy matchup?',
      sources: [{ ...directSource(), cacheOutcome: 'stale-if-error' }],
      toolResults: [{ toolName: 'predictMatchup', output: { favoredRosterId: 4 } }],
    });

    expect(mixed.currentEvidence).toBe('mixed');
    expect(stale.currentEvidence).toBe('stale');
  });

  it('does not accept automatic source refreshes without research tools', () => {
    const result = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'Which player should I start in my league?',
      sources: [directSource()],
      toolResults: [],
    });

    expect(result.currentEvidence).toBe('missing');
    expect(result.identity).toBe('missing');
    expect(result.injury).toBe('missing');
    expect(result.leagueScoring).toBe('missing');
    expect(result.projection).toBe('not-required');
  });
});

function evidence(
  overrides: Partial<RecommendationEvidence> = {},
): RecommendationEvidence {
  return {
    currentEvidence: 'fresh',
    identity: 'resolved',
    injury: 'present',
    leagueScoring: 'present',
    projection: 'not-required',
    ...overrides,
  };
}

function exampleAnalysis(): FantasyAnalysis {
  return {
    schemaVersion: 1,
    kind: 'player',
    subject: 'Example Player',
    summary: 'The player has the stronger recent role.',
    recommendation: {
      action: 'Start Example Player.',
      rationale: 'The player has more recent opportunities.',
    },
    confidence: {
      level: 'high',
      score: 0.85,
      rationale: 'Several data points support the recommendation.',
    },
    metrics: [],
    strengths: [],
    weaknesses: [],
    risks: [],
    assumptions: [],
    limitations: [],
  };
}

function directSource(): DataSourceRecord {
  return {
    accessedAt: '2026-08-21T12:00:00.000Z',
    cacheOutcome: 'source-updated',
    id: 'sleeper-player',
    label: 'Sleeper read-only API',
    retrievedAt: '2026-08-21T12:00:00.000Z',
    url: 'https://api.sleeper.app/v1/players/nfl',
  };
}

function webSource(): DataSourceRecord {
  return {
    accessedAt: '2026-08-21T12:00:00.000Z',
    id: 'web:news-1',
    label: 'Team injury report',
    url: 'https://example.com/injury-report',
  };
}
