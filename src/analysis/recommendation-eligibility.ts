import type { FantasyAnalysis } from './output.js';
import type { DataSourceRecord } from '../sources.js';

export type EvidenceState = 'fresh' | 'mixed' | 'missing' | 'stale';
export type IdentityEvidenceState =
  | 'ambiguous'
  | 'missing'
  | 'not-required'
  | 'resolved';
export type RequiredEvidenceState = 'missing' | 'not-required' | 'present';
export type ProjectionEligibilityState = 'eligible' | 'ineligible' | 'not-required';

export interface RecommendationEvidence {
  currentEvidence: EvidenceState;
  identity: IdentityEvidenceState;
  injury: RequiredEvidenceState;
  leagueScoring: RequiredEvidenceState;
  projection: ProjectionEligibilityState;
}

export interface RecommendationEligibility {
  outcome: 'allowed' | 'blocked' | 'downgraded' | 'not-applicable';
  reasons: string[];
}

export interface RecommendationToolResult {
  input?: unknown;
  output: unknown;
  toolName: string;
}

export interface BuildRecommendationEvidenceInput {
  analysis: FantasyAnalysis;
  question: string;
  sources: readonly DataSourceRecord[];
  toolResults: readonly RecommendationToolResult[];
}

export interface EnforcedFantasyAnalysis {
  analysis: FantasyAnalysis;
  eligibility: RecommendationEligibility;
}

export interface EnforcedFreeformRecommendation {
  answer: string;
  eligibility: RecommendationEligibility;
}

const LEAGUE_REQUEST =
  /\b(?:faab|fantasy|league|lineup|matchup|roster|scoring|sit|start|trade|waiver)\b/iu;
const PLAYER_DECISION =
  /\b(?:add|bench|claim|drop|faab|lineup|pick\s*up|player|rest of season|ros|sit|start|trade|waiver)\b/iu;
const EXPLICIT_DECISION_REQUEST =
  /\b(?:should\s+(?:i|we)|would\s+you|recommend(?:ation|ations)?|what\s+(?:do|would)\s+(?:i|we|you)|start\s+or\s+sit)\b/iu;
const DIRECT_DECISION_QUESTION =
  /\b(?:can|could|do|may)\s+(?:i|we)\s+(?:add|bench|claim|drop|pick\s*up|sit|start|trade)\b|\bis\b[^?\n]{0,100}\bworth\s+(?:adding|claiming|dropping|starting|trading)\b|\bwhich\b[^?\n]{0,100}\b(?:add|bench|claim|drop|sit|start)\b/iu;
const LEADING_FANTASY_ACTION =
  /^(?:please\s+)?(?:add|bench|claim|drop|sit|start)\b/iu;
const CONTEXTUAL_FANTASY_ACTION =
  /\b(?:accept|decline)\s+(?:a\s+|the\s+|this\s+)?trade\b|\btrade\b[^?\n]{0,120}\bfor\b|\b(?:rank|prioritize)\s+(?:my\s+)?(?:faab|waiver)\b|\b(?:faab|waiver)\s+(?:bid|claim|range|target|targets)\b|\b(?:build|fix|optimize|set)\s+(?:a\s+|my\s+|the\s+)?lineup\b/iu;
const TIMEBOXED_PLAYER_COMPARISON =
  /\b(?:or|versus|vs\.?)\b[^?\n]{0,120}\b(?:at\s+flex|in\s+(?:my|the)\s+lineup|rest\s+of\s+season|ros|this\s+week)\b/iu;
const START_SIT_REQUEST = /\b(?:bench|lineup|sit|start)\b/iu;
const DECISION_FOLLOW_UP =
  /^(?:and\b|or\b|what\s+about\b|how\s+about\b|which\s+one\b|compare\b|versus\b|vs\.?\b)|\binstead\??$/iu;

const PLAYER_IDENTITY_TOOLS = new Set([
  'findPlayers',
  'getRosterPlayers',
  'getTrendingPlayers',
  'projectPlayer',
  'rankWaiverTargets',
  'analyzeTradeImpact',
  'resolvePlayerIdentity',
]);
const PLAYER_STATUS_TOOLS = new Set([
  'findPlayers',
  'getRosterPlayers',
  'getTeamPlayers',
  'getTrendingPlayers',
  'projectPlayer',
  'rankWaiverTargets',
  'analyzeTradeImpact',
]);
const SCORING_TOOLS = new Set([
  'analyzeLeague',
  'getLeagueOverview',
  'predictMatchup',
  'projectPlayer',
  'rankWaiverTargets',
  'analyzeTradeImpact',
]);

export function questionRequestsRecommendation(question: string): boolean {
  return EXPLICIT_DECISION_REQUEST.test(question) ||
    DIRECT_DECISION_QUESTION.test(question) ||
    LEADING_FANTASY_ACTION.test(question.trim()) ||
    CONTEXTUAL_FANTASY_ACTION.test(question) ||
    TIMEBOXED_PLAYER_COMPARISON.test(question);
}

export function recommendationContextQuestion(
  question: string,
  previousQuestion?: string,
): string {
  if (
    questionRequestsRecommendation(question) ||
    !previousQuestion ||
    !questionRequestsRecommendation(previousQuestion) ||
    !DECISION_FOLLOW_UP.test(question.trim())
  ) {
    return question;
  }
  return `${previousQuestion}\n${question}`;
}

export function buildFreeformRecommendationEvidence(input: {
  question: string;
  sources: readonly DataSourceRecord[];
  toolResults: readonly RecommendationToolResult[];
}): RecommendationEvidence {
  return buildRecommendationEvidence({
    analysis: eligibilityAnalysis(),
    question: input.question,
    sources: input.sources,
    toolResults: input.toolResults,
  });
}

export function enforceFreeformRecommendation(
  answer: string,
  evidence: RecommendationEvidence,
): EnforcedFreeformRecommendation {
  const eligibility = enforceRecommendationEligibility(
    eligibilityAnalysis(),
    evidence,
  ).eligibility;
  if (eligibility.outcome === 'blocked') {
    return {
      answer: [
        '## Decision unavailable',
        '',
        'Seb withheld the recommendation because the required evidence is incomplete.',
        '',
        ...eligibility.reasons.map((reason) => `- ${reason}`),
        '',
        'Refresh or resolve the missing context, then run the decision again.',
      ].join('\n'),
      eligibility,
    };
  }
  if (eligibility.outcome === 'downgraded') {
    return {
      answer: `${answer.trimEnd()}\n\n> Confidence limit: Some supporting data is stale. Treat this recommendation as medium confidence or lower.`,
      eligibility,
    };
  }
  return { answer, eligibility };
}

/**
 * Build deterministic evidence states from executed tools and recorded sources.
 * This function does not read the model's claims or confidence value.
 */
export function buildRecommendationEvidence(
  input: BuildRecommendationEvidenceInput,
): RecommendationEvidence {
  if (!input.analysis.recommendation) {
    return {
      currentEvidence: sourceEvidenceState(input.sources),
      identity: 'not-required',
      injury: 'not-required',
      leagueScoring: 'not-required',
      projection: 'not-required',
    };
  }

  const needsLeagueScoring = LEAGUE_REQUEST.test(input.question) ||
    input.analysis.kind === 'player' ||
    input.analysis.kind === 'fantasy-league' ||
    input.analysis.kind === 'fantasy-matchup';
  const needsPlayerStatus = PLAYER_DECISION.test(input.question) ||
    input.analysis.kind === 'player' ||
    input.analysis.kind === 'fantasy-league' ||
    input.analysis.kind === 'fantasy-matchup';
  const needsPlayerIdentity = needsPlayerStatus;

  return {
    currentEvidence: input.toolResults.length > 0
      ? sourceEvidenceState(input.sources)
      : 'missing',
    identity: needsPlayerIdentity
      ? identityEvidenceState(input.toolResults, input.question)
      : 'not-required',
    injury: needsPlayerStatus
      ? playerStatusEvidenceState(input.toolResults, input.sources, input.question)
      : 'not-required',
    leagueScoring: needsLeagueScoring
      ? leagueScoringEvidenceState(input.toolResults, input.question)
      : 'not-required',
    projection: projectionEligibilityState(input.toolResults, input.question),
  };
}

/**
 * Remove an unsupported recommendation or reduce its confidence.
 * The returned analysis is a copy. This function never changes the input.
 */
export function enforceRecommendationEligibility(
  analysis: FantasyAnalysis,
  evidence: RecommendationEvidence,
): EnforcedFantasyAnalysis {
  if (!analysis.recommendation) {
    return {
      analysis: cloneAnalysis(analysis),
      eligibility: { outcome: 'not-applicable', reasons: [] },
    };
  }

  const blockingReasons = eligibilityBlockingReasons(evidence);
  if (blockingReasons.length > 0) {
    const limitation = `Seb withheld the recommendation: ${blockingReasons.join(' ')}`;
    return {
      analysis: {
        ...cloneAnalysis(analysis),
        recommendation: null,
        confidence: {
          level: 'low',
          score: Math.min(analysis.confidence.score, 0.39),
          rationale: limitation,
        },
        limitations: appendUnique(analysis.limitations, limitation),
      },
      eligibility: { outcome: 'blocked', reasons: blockingReasons },
    };
  }

  if (evidence.currentEvidence === 'mixed') {
    const reason =
      'Some supporting data is stale, but fresh required evidence is available.';
    return {
      analysis: {
        ...cloneAnalysis(analysis),
        confidence: {
          level: analysis.confidence.level === 'high' ? 'medium' : analysis.confidence.level,
          score: Math.min(analysis.confidence.score, 0.69),
          rationale: `${analysis.confidence.rationale} ${reason}`.slice(0, 1_000),
        },
        limitations: appendUnique(analysis.limitations, reason),
      },
      eligibility: { outcome: 'downgraded', reasons: [reason] },
    };
  }

  return {
    analysis: cloneAnalysis(analysis),
    eligibility: { outcome: 'allowed', reasons: [] },
  };
}

function eligibilityBlockingReasons(evidence: RecommendationEvidence): string[] {
  const reasons: string[] = [];
  if (evidence.currentEvidence === 'missing') {
    reasons.push('No current source supports this action.');
  } else if (evidence.currentEvidence === 'stale') {
    reasons.push('The required source data is stale.');
  }
  if (evidence.identity === 'ambiguous') {
    reasons.push('The player identity is ambiguous.');
  } else if (evidence.identity === 'missing') {
    reasons.push('The player identity is not resolved.');
  }
  if (evidence.injury === 'missing') {
    reasons.push('Current player status and injury evidence is missing.');
  }
  if (evidence.leagueScoring === 'missing') {
    reasons.push('The selected league scoring settings are missing.');
  }
  if (evidence.projection === 'ineligible') {
    reasons.push('The projection does not meet its deterministic recommendation rules.');
  }
  return reasons;
}

function sourceEvidenceState(sources: readonly DataSourceRecord[]): EvidenceState {
  if (sources.length === 0) return 'missing';
  let fresh = 0;
  let stale = 0;
  for (const source of sources) {
    if (source.cacheOutcome === 'stale-if-error') {
      stale += 1;
      continue;
    }
    if (
      source.id.startsWith('web:') ||
      source.cacheOutcome === 'cache-fresh' ||
      source.cacheOutcome === 'source-not-modified' ||
      source.cacheOutcome === 'source-updated'
    ) {
      fresh += 1;
    }
  }
  if (fresh > 0 && stale > 0) return 'mixed';
  if (fresh > 0) return 'fresh';
  if (stale > 0) return 'stale';
  return 'missing';
}

function identityEvidenceState(
  toolResults: readonly RecommendationToolResult[],
  question: string,
): IdentityEvidenceState {
  const identityResults = toolResults.filter((result) =>
    PLAYER_IDENTITY_TOOLS.has(result.toolName)
  );
  if (identityResults.length === 0) return 'missing';

  const explicitResolutions = identityResults.filter(
    (result) => result.toolName === 'resolvePlayerIdentity',
  );
  if (explicitResolutions.length > 0) {
    const statuses = explicitResolutions.map((result) =>
      findIdentityStatus(result.output)
    );
    if (statuses.some((status) => status === 'ambiguous' || status === 'not-found')) {
      return 'ambiguous';
    }
    return statuses.every((status) => status === 'resolved') &&
        explicitResolutions.every((result) => individualPlayerResultMatchesQuestion(result, question))
      ? 'resolved'
      : 'missing';
  }

  let resolved = 0;
  for (const result of identityResults) {
    if (result.toolName === 'findPlayers') {
      if (!Array.isArray(result.output) || result.output.length === 0) return 'missing';
      if (result.output.length > 1) return 'ambiguous';
      if (!individualPlayerResultMatchesQuestion(result, question)) return 'missing';
      resolved += 1;
      continue;
    }
    if (result.toolName === 'getRosterPlayers') {
      const record = asRecord(result.output);
      const players = record?.players;
      const missing = record?.missingPlayerIds;
      if (!Array.isArray(players) || players.length === 0) return 'missing';
      if (!Array.isArray(missing) || missing.length > 0) return 'ambiguous';
      resolved += 1;
      continue;
    }
    if (result.toolName === 'getTrendingPlayers') {
      const record = asRecord(result.output);
      const players = record?.players;
      if (!Array.isArray(players) || players.length === 0) return 'missing';
      if (players.some((player) => !asRecord(player)?.player)) return 'ambiguous';
      resolved += 1;
      continue;
    }
    if (result.toolName === 'projectPlayer') {
      const player = asRecord(asRecord(result.output)?.player);
      if (!player || typeof player.playerId !== 'string' || !player.playerId) {
        return 'missing';
      }
      if (!individualPlayerResultMatchesQuestion(result, question)) return 'missing';
      resolved += 1;
      continue;
    }
    if (
      result.toolName === 'rankWaiverTargets' ||
      result.toolName === 'analyzeTradeImpact'
    ) {
      if (!hasResolvedDecisionPlayers(result.output)) return 'missing';
      resolved += 1;
      continue;
    }
  }
  return resolved === identityResults.length ? 'resolved' : 'missing';
}

function playerStatusEvidenceState(
  toolResults: readonly RecommendationToolResult[],
  sources: readonly DataSourceRecord[],
  question: string,
): RequiredEvidenceState {
  const subjects = relevantPlayerSubjects(toolResults, question);
  const hasPlayerStatus = toolResults.some((result) =>
    PLAYER_STATUS_TOOLS.has(result.toolName) &&
    (!isIndividualPlayerTool(result.toolName) ||
      individualPlayerResultMatchesQuestion(result, question)) &&
    (result.toolName === 'projectPlayer'
      ? hasProjectionPlayerStatus(result.output)
      : hasPlayerStatusFields(result.output))
  );
  const hasGroundedWebNews = toolResults.some(
    (result) => result.toolName === 'searchCurrentNews' &&
      evidenceMatchesSubjects([result.input, result.output], subjects),
  ) && sources.some((source) => source.id.startsWith('web:'));
  const hasFirstClassNews = toolResults.some((result) =>
    result.toolName === 'searchFirstClassNews' &&
    hasUsableFirstClassNews(result.output, subjects)
  ) && sources.some((source) =>
    source.id.startsWith('news-article:') &&
    source.cacheOutcome !== 'stale-if-error'
  );
  const hasCurrentNews = hasGroundedWebNews || hasFirstClassNews;
  return hasPlayerStatus && hasCurrentNews ? 'present' : 'missing';
}

function hasUsableFirstClassNews(
  value: unknown,
  subjects: readonly string[],
): boolean {
  const articles = asRecord(value)?.articles;
  return Array.isArray(articles) && articles.some((article) => {
    const record = asRecord(article);
    return record?.stale === false &&
      typeof record.publishedAt === 'string' &&
      evidenceMatchesSubjects([record], subjects);
  });
}

function leagueScoringEvidenceState(
  toolResults: readonly RecommendationToolResult[],
  question: string,
): RequiredEvidenceState {
  const scoringResults = toolResults.filter((result) =>
    SCORING_TOOLS.has(result.toolName) &&
    (result.toolName === 'predictMatchup' ||
      (result.toolName === 'projectPlayer' && hasProjectionScoring(result.output)) ||
      (result.toolName === 'rankWaiverTargets' && hasWaiverScoring(result.output)) ||
      (result.toolName === 'analyzeTradeImpact' && hasTradeScoring(result.output)) ||
      hasScoringSettings(result.output))
  );
  return scoringResults.length > 0 && leagueIdsAreConsistent(scoringResults, question)
    ? 'present'
    : 'missing';
}

function projectionEligibilityState(
  toolResults: readonly RecommendationToolResult[],
  question: string,
): ProjectionEligibilityState {
  const projections = toolResults.filter((result) => result.toolName === 'projectPlayer');
  if (projections.length === 0) {
    return START_SIT_REQUEST.test(question) ? 'ineligible' : 'not-required';
  }
  return projections.every(
      (result) => asRecord(result.output)?.recommendationEligible === true &&
        individualPlayerResultMatchesQuestion(result, question),
    )
    ? 'eligible'
    : 'ineligible';
}

function findIdentityStatus(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = findIdentityStatus(item);
      if (status) return status;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.status === 'string') return record.status;
  if (record.resolution) return findIdentityStatus(record.resolution);
  return null;
}

function hasPlayerStatusFields(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasPlayerStatusFields);
  const record = value as Record<string, unknown>;
  if (
    'injuryStatus' in record ||
    'practiceParticipation' in record
  ) {
    return true;
  }
  return Object.values(record).some(hasPlayerStatusFields);
}

function hasScoringSettings(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasScoringSettings);
  const record = value as Record<string, unknown>;
  if (
    ('scoringSettings' in record && isNonEmptyRecord(record.scoringSettings)) ||
    ('scoring_settings' in record && isNonEmptyRecord(record.scoring_settings))
  ) {
    return true;
  }
  return Object.values(record).some(hasScoringSettings);
}

function hasProjectionPlayerStatus(value: unknown): boolean {
  const limitations = asRecord(value)?.limitations;
  return Array.isArray(limitations) && !limitations.some(
    (limitation) => typeof limitation === 'string' &&
      limitation.includes('has no current injury status'),
  );
}

function hasProjectionScoring(value: unknown): boolean {
  const scoring = asRecord(asRecord(value)?.scoring);
  return isNonEmptyStringArray(scoring?.usedSettings) &&
    isEmptyArray(scoring?.ignoredSettings);
}

function hasWaiverScoring(value: unknown): boolean {
  const methodology = asRecord(asRecord(value)?.methodology);
  return isNonEmptyStringArray(methodology?.scoringKeysUsed) &&
    isEmptyArray(methodology?.scoringKeysIgnored);
}

function hasTradeScoring(value: unknown): boolean {
  const scoring = asRecord(asRecord(value)?.scoring);
  return isNonEmptyStringArray(scoring?.usedSettings) &&
    isEmptyArray(scoring?.ignoredSettings);
}

function isIndividualPlayerTool(toolName: string): boolean {
  return toolName === 'findPlayers' ||
    toolName === 'projectPlayer' ||
    toolName === 'resolvePlayerIdentity';
}

function individualPlayerResultMatchesQuestion(
  result: RecommendationToolResult,
  question: string,
): boolean {
  const subjects = [
    ...toolInputPlayerSubjects(result),
    ...playerSubjects([result.output]),
  ];
  return subjects.some((subject) => textMentionsSubject(question, subject));
}

function relevantPlayerSubjects(
  toolResults: readonly RecommendationToolResult[],
  question: string,
): string[] {
  const subjects = toolResults.flatMap((result) => {
    if (!PLAYER_IDENTITY_TOOLS.has(result.toolName)) return [];
    const candidates = [
      ...toolInputPlayerSubjects(result),
      ...playerSubjects([result.output]),
    ];
    return isIndividualPlayerTool(result.toolName)
      ? candidates.filter((subject) => textMentionsSubject(question, subject))
      : candidates;
  });
  return [...new Set(subjects.map(normalizeEvidenceText).filter(Boolean))];
}

function toolInputPlayerSubjects(result: RecommendationToolResult): string[] {
  const input = asRecord(result.input);
  if (!input) return [];
  const keys = result.toolName === 'resolvePlayerIdentity'
    ? ['name']
    : result.toolName === 'projectPlayer'
      ? ['playerName']
      : result.toolName === 'findPlayers'
        ? ['query']
        : ['givePlayerNames', 'receivePlayerNames'];
  return keys.flatMap((key) => {
    const value = input[key];
    if (typeof value === 'string') return [value];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
  });
}

function playerSubjects(values: readonly unknown[]): string[] {
  const output: string[] = [];
  for (const value of values) collectPlayerSubjects(value, output);
  return [...new Set(output.map((item) => item.trim()).filter((item) => item.length >= 2))];
}

function collectPlayerSubjects(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectPlayerSubjects(item, output);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  const isPlayerRecord = typeof record.playerId === 'string' ||
    typeof record.player_id === 'string';
  for (const [key, item] of Object.entries(record)) {
    if (
      typeof item === 'string' &&
      (
        ['displayName', 'fullName', 'full_name', 'playerDisplayName', 'playerName', 'query']
          .includes(key) ||
        (key === 'name' && isPlayerRecord)
      )
    ) {
      output.push(item);
    } else if (
      Array.isArray(item) &&
      ['givePlayerNames', 'receivePlayerNames'].includes(key)
    ) {
      output.push(...item.filter((candidate): candidate is string => typeof candidate === 'string'));
    } else if (typeof item === 'object' && item !== null) {
      collectPlayerSubjects(item, output);
    }
  }
}

function evidenceMatchesSubjects(
  values: readonly unknown[],
  subjects: readonly string[],
): boolean {
  if (subjects.length === 0) return false;
  const evidence = normalizeEvidenceText(values.map(stringifyEvidence).join(' '));
  return subjects.some((subject) => textMentionsSubject(evidence, subject));
}

function stringifyEvidence(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function textMentionsSubject(text: string, subject: string): boolean {
  const normalizedText = normalizeEvidenceText(text);
  const normalizedSubject = normalizeEvidenceText(subject);
  if (!normalizedText || !normalizedSubject) return false;
  if (` ${normalizedText} `.includes(` ${normalizedSubject} `)) return true;
  const tokens = normalizedSubject.split(' ').filter((token) => token.length >= 3);
  const lastName = tokens.length >= 2 ? tokens.at(-1) : null;
  return Boolean(lastName && ` ${normalizedText} `.includes(` ${lastName} `));
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

function leagueIdsAreConsistent(
  results: readonly RecommendationToolResult[],
  question: string,
): boolean {
  const ids = new Set(results.flatMap((result) => leagueIds([result.input, result.output])));
  const questionIds: string[] = question.match(/\b\d{6,}\b/gu) ?? [];
  if (ids.size > 1) return false;
  return questionIds.length === 0 ||
    (ids.size === 1 && [...ids].every((id) => questionIds.includes(id)));
}

function leagueIds(values: readonly unknown[]): string[] {
  const output: string[] = [];
  for (const value of values) collectLeagueIds(value, output);
  return output;
}

function collectLeagueIds(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectLeagueIds(item, output);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    if ((key === 'leagueId' || key === 'league_id') && typeof item === 'string') {
      output.push(item);
    } else if (typeof item === 'object' && item !== null) {
      collectLeagueIds(item, output);
    }
  }
}

function isNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) => typeof item === 'string');
}

function isEmptyArray(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0;
}

function hasResolvedDecisionPlayers(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const candidates = Array.isArray(record.targets)
    ? record.targets
    : [
        ...decisionSidePlayers(record.give),
        ...decisionSidePlayers(record.receive),
      ];
  if (candidates.length === 0) return false;
  return candidates.every((candidate) => {
    const player = asRecord(asRecord(candidate)?.player) ?? asRecord(candidate);
    return typeof player?.playerId === 'string' && player.playerId.length > 0;
  });
}

function decisionSidePlayers(value: unknown): unknown[] {
  const players = asRecord(value)?.players;
  return Array.isArray(players) ? players : [];
}

function isNonEmptyRecord(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0,
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function appendUnique(values: readonly string[], value: string): string[] {
  if (values.includes(value)) return [...values];
  return [...values.slice(0, 9), value];
}

function cloneAnalysis(analysis: FantasyAnalysis): FantasyAnalysis {
  return {
    ...analysis,
    recommendation: analysis.recommendation ? { ...analysis.recommendation } : null,
    confidence: { ...analysis.confidence },
    metrics: analysis.metrics.map((metric) => ({ ...metric })),
    strengths: [...analysis.strengths],
    weaknesses: [...analysis.weaknesses],
    risks: [...analysis.risks],
    assumptions: [...analysis.assumptions],
    limitations: [...analysis.limitations],
  };
}

function eligibilityAnalysis(): FantasyAnalysis {
  return {
    schemaVersion: 1,
    kind: 'general',
    subject: 'Requested decision',
    summary: 'The user requested an action.',
    recommendation: {
      action: 'Requested action.',
      rationale: 'The eligibility gate evaluates the supporting evidence.',
    },
    confidence: {
      level: 'high',
      score: 1,
      rationale: 'The eligibility gate calculates support outside the model response.',
    },
    metrics: [],
    strengths: [],
    weaknesses: [],
    risks: [],
    assumptions: [],
    limitations: [],
  };
}
