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
  it.each(['please try again', 'Retry.', 'try that again please'])('keeps recommendation checks for %s', (retry) => {
    expect(recommendationContextQuestion(retry, 'Should I start Aaron Smith?')).toBe('Should I start Aaron Smith?');
    expect(recommendationContextQuestion(retry, 'What is the weather?')).toBe('What is the weather?');
    expect(recommendationContextQuestion(retry)).toBe(retry);
  });
  it('detects action requests without classifying a factual lookup', () => {
    expect(questionRequestsRecommendation('Should I start Example Player?')).toBe(true);
    expect(questionRequestsRecommendation('Rank my waiver targets.')).toBe(true);
    expect(questionRequestsRecommendation('Would you trade Player A for Player B?')).toBe(true);
    expect(questionRequestsRecommendation('Show Example Player statistics.')).toBe(false);
    expect(questionRequestsRecommendation('When is my trade deadline?')).toBe(false);
    expect(questionRequestsRecommendation('When does the NFL season start?')).toBe(false);
    expect(questionRequestsRecommendation('Show my waiver rules.')).toBe(false);
  });

  it.each([
    'Do I start Player A?',
    'Is Player A worth adding?',
    'Which player should start?',
    'Can I drop Player A?',
    'Player A or Player B this week?',
  ])('detects the common decision wording: %s', (question) => {
    expect(questionRequestsRecommendation(question)).toBe(true);
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
      {
        input: { query: 'Example Player injury' },
        toolName: 'searchCurrentNews',
        output: { result: 'Example Player has no reported injury.' },
      },
      {
        toolName: 'getLeagueOverview',
        output: { league: { scoring_settings: { rec: 1 } } },
      },
    ];

    const evidence = buildRecommendationEvidence({
      analysis,
      question: 'Should I add Example Player in my league?',
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

  it('accepts current first-class news without a Google result', () => {
    const analysis = exampleAnalysis();
    const evidence = buildRecommendationEvidence({
      analysis,
      question: 'Should I add Example Player in my league?',
      sources: [directSource(), firstClassNewsSource()],
      toolResults: [
        {
          toolName: 'findPlayers',
          output: [{
            injuryStatus: null,
            name: 'Example Player',
            playerId: 'player-1',
            practiceParticipation: 'Full',
          }],
        },
        {
          toolName: 'searchFirstClassNews',
          output: {
            articles: [{
              publishedAt: '2026-08-21T12:00:00.000Z',
              stale: false,
              title: 'Example Player returns to practice',
            }],
          },
        },
        {
          toolName: 'getLeagueOverview',
          output: { league: { scoring_settings: { rec: 1 } } },
        },
      ],
    });

    expect(evidence.injury).toBe('present');
    expect(enforceRecommendationEligibility(analysis, evidence).eligibility.outcome)
      .toBe('allowed');
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
          input: { name: 'Alex Smith' },
          toolName: 'resolvePlayerIdentity',
          output: { resolution: { status: 'resolved', identity: { canonicalId: 'one' } } },
        },
        {
          input: { query: 'Alex Smith injury' },
          toolName: 'searchCurrentNews',
          output: { result: 'Alex Smith is active.' },
        },
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
        {
          input: { query: 'Example Player injury' },
          toolName: 'searchCurrentNews',
          output: { result: 'Example Player is active.' },
        },
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
        methodology: { scoringKeysIgnored: [], scoringKeysUsed: ['rec', 'rec_yd'] },
        targets: [{
          player: {
            injuryStatus: null,
            name: 'Waiver Player',
            playerId: 'waiver-1',
          },
        }],
      },
      'Waiver Player',
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
      'Give Player Receive Player',
    ],
  ])('uses %s analysis as identity, status, and scoring evidence', (
    _label,
    toolName,
    output,
    newsSubject,
  ) => {
    const evidenceResult = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'What fantasy action should I take in this league?',
      sources: [directSource(), webSource()],
      toolResults: [
        { toolName, output },
        {
          input: { query: `${newsSubject} injury news` },
          toolName: 'searchCurrentNews',
          output: { result: `${newsSubject} status report` },
        },
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

  it('rejects evidence for an unrelated player and league', () => {
    const evidenceResult = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'Should I start Patrick Mahomes in league 123456?',
      sources: [directSource(), firstClassNewsSource()],
      toolResults: [
        {
          input: { query: 'Aaron Rodgers' },
          output: [{
            injuryStatus: null,
            name: 'Aaron Rodgers',
            playerId: 'rodgers',
          }],
          toolName: 'findPlayers',
        },
        {
          input: { query: 'Aaron Rodgers injury' },
          output: {
            articles: [{
              publishedAt: '2026-08-21T12:00:00.000Z',
              stale: false,
              title: 'Aaron Rodgers practice report',
            }],
          },
          toolName: 'searchFirstClassNews',
        },
        {
          input: { leagueId: '999999' },
          output: {
            league: { league_id: '999999', scoring_settings: { rec: 1 } },
          },
          toolName: 'getLeagueOverview',
        },
      ],
    });

    expect(evidenceResult).toMatchObject({
      identity: 'missing',
      injury: 'missing',
      leagueScoring: 'missing',
      projection: 'ineligible',
    });
    expect(enforceRecommendationEligibility(exampleAnalysis(), evidenceResult).eligibility.outcome)
      .toBe('blocked');
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
    expect(result.projection).toBe('ineligible');
  });

  it('rejects cyclic and deeply nested tool output without recursion failure', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    for (let depth = 0; depth < 200; depth += 1) deep = { next: deep };
    cyclic.deep = deep;

    const result = buildRecommendationEvidence({
      analysis: exampleAnalysis(),
      question: 'Should I start Example Player in league 123456?',
      sources: [directSource()],
      toolResults: [
        { toolName: 'findPlayers', output: cyclic },
        { toolName: 'getLeagueOverview', output: cyclic },
        { toolName: 'resolvePlayerIdentity', output: cyclic },
      ],
    });

    expect(result).toMatchObject({
      identity: 'missing',
      injury: 'missing',
      leagueScoring: 'missing',
    });
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

function firstClassNewsSource(): DataSourceRecord {
  return {
    accessedAt: '2026-08-21T12:00:00.000Z',
    cacheOutcome: 'source-updated',
    id: 'news-article:team-ne:https://example.com/news/report',
    label: 'New England Patriots News: Practice report',
    retrievedAt: '2026-08-21T12:00:00.000Z',
    url: 'https://example.com/news/report',
  };
}

describe('comparison evidence for every player', () => {
  const projections = ['Aaron Smith', 'Brian Smith'].map((name, index) => ({ player: { name, playerId: `p${index}` },
    league: { leagueId: '123456' }, limitations: [], scoring: { usedSettings: ['rec'], ignoredSettings: [] }, recommendationEligible: true }));
  const comparison = { toolName: 'compareStartSit', input: { leagueId: '123456', playerNames: ['Aaron Smith', 'Brian Smith'] },
    output: { projections, recommendationEligible: true } };
  const build = (news: string, result = comparison) => buildRecommendationEvidence({ analysis: exampleAnalysis(),
    question: 'Should I start Aaron Smith or Brian Smith in league 123456?', sources: [directSource(), webSource()],
    toolResults: [result, { toolName: 'searchCurrentNews', output: { result: news } }] });
  it('requires current reporting for both players even when they share a last name', () => {
    expect(build('Aaron Smith is healthy.').injury).toBe('missing');
    expect(build('Aaron Smith and Brian Smith are healthy.').injury).toBe('present');
  });
  it('blocks an incomplete comparison result', () => {
    expect(build('Aaron Smith and Brian Smith are healthy.', { ...comparison, output: { ...comparison.output, projections: [projections[0]!] } }).projection).toBe('ineligible');
  });
  it('preserves a failed comparison slot check', () => {
    expect(build('Aaron Smith and Brian Smith are healthy.', { ...comparison, output: { ...comparison.output, recommendationEligible: false } }).projection).toBe('ineligible');
  });
  it.each(['complete', 'missing', 'duplicate', 'unavailable'] as const)('validates %s batch projection evidence', (state) => {
    const results = projections.map((projection) => ({ playerName: projection.player.name, status: 'projected', projection }));
    if (state === 'missing') results.pop();
    if (state === 'duplicate') results[1] = results[0]!;
    if (state === 'unavailable') results[1]!.status = 'unavailable';
    const evidence = buildRecommendationEvidence({ analysis: exampleAnalysis(),
      question: 'Should I start Aaron Smith or Brian Smith in league 123456?', sources: [directSource(), webSource()],
      toolResults: [{ toolName: 'projectPlayers', input: comparison.input, output: { results } },
        { toolName: 'searchCurrentNews', output: { result: 'Aaron Smith and Brian Smith are healthy.' } }] });
    expect(evidence.projection).toBe(state === 'complete' ? 'eligible' : 'ineligible');
    if (state === 'complete') expect(evidence.leagueScoring).toBe('present');
  });
});

it('requires evidence for a second player in an explicit starter comparison', () => {
  const result = buildRecommendationEvidence({ analysis: exampleAnalysis(), question: 'Should I start Aaron Smith or Brian Smith?', sources: [directSource(), webSource()],
    toolResults: [{ toolName: 'projectPlayer', input: { playerName: 'Aaron Smith' }, output: {
      player: { name: 'Aaron Smith', playerId: 'p1' }, recommendationEligible: true, limitations: [],
      scoring: { usedSettings: ['rec'], ignoredSettings: [] },
    } }, { toolName: 'searchCurrentNews', output: { result: 'Aaron Smith is healthy.' } }] });
  expect(result.projection).toBe('ineligible');
});

it('matches player initials across punctuation differences in current news', () => {
  const result = buildRecommendationEvidence({ analysis: exampleAnalysis(), question: 'Should I start A.J. Brown?', sources: [directSource(), webSource()],
    toolResults: [{ toolName: 'projectPlayer', input: { playerName: 'A.J. Brown' }, output: {
      player: { name: 'A.J. Brown', playerId: 'p1' }, recommendationEligible: true, limitations: [],
      scoring: { usedSettings: ['rec'], ignoredSettings: [] },
    } }, { toolName: 'searchCurrentNews', output: { result: 'AJ Brown is healthy.' } }] });
  expect(result.injury).toBe('present');
});
