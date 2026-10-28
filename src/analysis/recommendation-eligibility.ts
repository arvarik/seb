import { normalizePlayerName, normalizeTeamText } from '../identity/normalize.js';
import { eligibleForSlot } from './lineup.js';
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
  inactiveOrTeamlessPlayers?: string[];
  identity: IdentityEvidenceState;
  injury: RequiredEvidenceState;
  leagueScoring: RequiredEvidenceState;
  projection: ProjectionEligibilityState;
  requiresRefusalOnly?: boolean;
  unfoundPlayers?: string[];
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
const NON_DECISION_RETROSPECTIVE_OR_SYSTEM =
  /\b(?:should|would|could)\s+(?:i|we|you)\s+have\b|\bdid\s+(?:i|we)\s+(?:start|sit|bench|add|drop|claim|trade)\b|\b(?:learn|learning|calibrate|calibration)\b|\b(?:can|could|do|may|should|let'?s)\s+(?:i|we)\s+start\s+(?:a\s+|the\s+|this\s+|that\s+|our\s+)?(?:process|proicess|update|session|workflow|over)\b/iu;
const EXPLICIT_DECISION_REQUEST =
  /\b(?:should\s+(?:i|we)|would\s+you|recommend(?:ation|ations)?|what\s+(?:do|would)\s+(?:i|we|you)\s+(?:do|start|sit|bench|add|drop|claim|pick\s*up|trade|bid|offer|target|flex|play|stream|make|take)\b|start\s+or\s+sit)\b/iu;
const DIRECT_DECISION_QUESTION =
  /\b(?:can|could|do|may)\s+(?:i|we)\s+(?:add|bench|claim|drop|pick\s*up|sit|start|trade)\b|\bis\b[^?\n]{0,100}\bworth\s+(?:adding|claiming|dropping|starting|trading)\b|\bwhich\b[^?\n]{0,100}\b(?:add|bench|claim|drop|sit|start)\b/iu;
const LEADING_FANTASY_ACTION =
  /^(?:please\s+)?(?:add|bench(?!\s+(?:points|spots?|slots?|scoring)\b)|claim|drop(?!\s+(?:rate|rates|off)\b)|sit|start(?!\s+times?\b))\b/iu;
const CONTEXTUAL_FANTASY_ACTION =
  /\b(?:accept|decline)\s+(?:a\s+|the\s+|this\s+)?trade\b|\btrade\b[^?\n]{0,120}\bfor\b|\b(?:rank|prioritize)\s+(?:my\s+)?(?:faab|waiver)\b|\b(?:faab|waiver)\s+(?:bid|claim|range|target|targets)\b|\b(?:build|fix|optimize|set)\s+(?!their\b|his\b|her\b|(?:my|our)\s+opponent(?:'?s)?\b|opponent(?:'?s)?\b)[^?\n]{0,40}\b(?:lineup|starters?)\b/iu;
const THIRD_PARTY_LINEUP_CONTEXT =
  /\bopponent(?:'?s)?\b[^?\n]{0,40}\b(?:build|built|fix|fixed|optimize|optimized|set)\b[^?\n]{0,40}\b(?:lineup|starters?)\b/iu;
const TIMEBOXED_PLAYER_COMPARISON =
  /\b(?:or|versus|vs\.?)\b[^?\n]{0,120}\b(?:at\s+flex|in\s+(?:my|the)\s+lineup|rest\s+of\s+season|ros|this\s+week)\b/iu;
const START_SIT_REQUEST = /\b(?:bench|lineup|sit|start)\b/iu;
const DECISION_FOLLOW_UP =
  /^(?:and\b|or\b|what\s+about\b|how\s+about\b|which\s+one\b|compare\b|versus\b|vs\.?\b)|\binstead\??$/iu;
const FACTUAL_FOLLOW_UP =
  /^(?:and\s+|or\s+)?(?:when|where|why|how\s+(?:many|much|did|does|do)|what\s+(?:time|is|are|was|were))\b/iu;
const ANAPHORIC_DECISION_REFERENCE =
  /\b(?:him|her|them|both|either|neither|which\s+one|that\s+trade|this\s+trade|instead)\b/iu;
const HAS_RECOMMENDATION_VERDICT =
  /(?:^|\n)\s*(?:#+\s*decision\b|\*{0,2}recommendation\*{0,2}\s*:|(?:[-*•]\s+|\d+\.\s+)?\*{0,2}(?:start|sit|bench|add|drop|claim|pick\s*up|accept|decline)\*{0,2}\s+(?!(?:times?|spots?|slots?|points|scoring|rate|rates|off|a|an|the|your|my|our|their|his|her|this|that|over|process|lineup|week)\b)[A-Z])|(?:,\s*(?:so\s+)?|;\s*|[.!?]\s+|\s+[-–—]\s*|\b(?:i'?d|we'?d)\s+)\*{0,2}(?:start|sit|bench|add|drop|claim|pick\s*up|accept|decline)\*{0,2}\s+(?!(?:times?|spots?|slots?|points|scoring|rate|rates|off|a|an|the|your|my|our|their|his|her|this|that|over|process|lineup|week)\b)[A-Z]|\b(?:i|we)\s+(?:would\s+)?(?:recommend|suggest|advise)\s+(?:starting|sitting|benching|adding|dropping|claiming|trading|accepting|declining)\b|\byou\s+should\s+(?:start|sit|bench|add|drop|claim|pick\s*up|trade|accept|decline)\b/imu;
const EXPLICIT_UNAVAILABLE_STATEMENT =
  /\b(?:decision\s+is\s+unavailable|can(?:'t|not)\s+(?:make|give|provide|pick|choose|select|compare)\b[\s\S]{0,60}\b(?:recommendation|decision|winner|starter|slot)\b|cannot\s+verify\s+current\s+reporting|withholding\s+(?:a\s+|the\s+)?recommendation|(?:(?:does\s+not|doesn'?t)\s+have\s+a|(?:has|is)\s+no)\s+[a-z0-9_-]+\s+slot\b)\b/iu;
const MAX_EVIDENCE_TRAVERSAL_DEPTH = 24;
const MAX_EVIDENCE_TRAVERSAL_NODES = 10_000;

interface EvidenceTraversal {
  remaining: number;
  seen: WeakSet<object>;
}

const PLAYER_IDENTITY_TOOLS = new Set([
  'findPlayers',
  'getRosterPlayers',
  'getTrendingPlayers',
  'optimizeRosterLineup',
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
  'optimizeRosterLineup',
  'projectPlayer',
  'rankWaiverTargets',
  'analyzeTradeImpact',
]);
const SCORING_TOOLS = new Set([
  'analyzeLeague',
  'getLeagueOverview',
  'optimizeRosterLineup',
  'predictMatchup',
  'projectLeagueMatchup',
  'projectPlayer',
  'rankWaiverTargets',
  'analyzeTradeImpact',
  'simulatePlayoffOdds',
]);

export function questionRequestsRecommendation(question: string): boolean {
  if (NON_DECISION_RETROSPECTIVE_OR_SYSTEM.test(question)) return false;
  if (
    EXPLICIT_DECISION_REQUEST.test(question) ||
    DIRECT_DECISION_QUESTION.test(question) ||
    LEADING_FANTASY_ACTION.test(question.trim()) ||
    TIMEBOXED_PLAYER_COMPARISON.test(question)
  ) {
    return true;
  }
  return CONTEXTUAL_FANTASY_ACTION.test(question) &&
    !THIRD_PARTY_LINEUP_CONTEXT.test(question);
}

export function recommendationContextQuestion(
  question: string,
  previousQuestion?: string,
  sessionPlayer?: string | null,
): string {
  if (previousQuestion && isRetryPrompt(question)) return previousQuestion;
  if (questionRequestsRecommendation(question)) {
    if (ANAPHORIC_DECISION_REFERENCE.test(question)) {
      const additions = [previousQuestion, sessionPlayer].filter(
        (value): value is string => Boolean(value?.trim()),
      );
      return additions.length > 0 ? `${question}\n${additions.join('\n')}` : question;
    }
    if (sessionPlayer && mentionsSessionPlayerFirstNameOnly(question, sessionPlayer)) {
      return `${question}\n${sessionPlayer}`;
    }
    return question;
  }
  if (
    !previousQuestion ||
    !questionRequestsRecommendation(previousQuestion) ||
    !DECISION_FOLLOW_UP.test(question.trim()) ||
    FACTUAL_FOLLOW_UP.test(question.trim())
  ) {
    return question;
  }
  return `${previousQuestion}\n${question}`;
}

function mentionsSessionPlayerFirstNameOnly(
  question: string,
  sessionPlayer: string,
): boolean {
  const normalizedPlayer = normalizePlayerName(sessionPlayer);
  const normalizedQuestion = normalizeEvidenceText(question);
  if (!normalizedPlayer || !normalizedQuestion) return false;
  if (` ${normalizedQuestion} `.includes(` ${normalizedPlayer} `)) return false;
  const tokens = normalizedPlayer.split(' ').filter(Boolean);
  const firstName = tokens[0];
  if (!firstName || firstName.length < 4 || tokens.length < 2) return false;
  if (!` ${normalizedQuestion} `.includes(` ${firstName} `)) return false;
  const capitalizedSurnamePattern = new RegExp(
    `\\b${firstName.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s+[A-Z][a-z]{2,}`,
    'u',
  );
  return !capitalizedSurnamePattern.test(question);
}

export function isRetryPrompt(question: string): boolean {
  return /^(?:please\s+)?(?:try(?:\s+(?:it|that))?\s+again|retry(?:\s+(?:it|that))?)(?:\s+please)?[.!?]*$/iu.test(question.trim());
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

export function answerWithholdsOrClarifies(answer: string): boolean {
  const trimmed = answer.trim();
  if (!trimmed || HAS_RECOMMENDATION_VERDICT.test(trimmed)) return false;
  if (EXPLICIT_UNAVAILABLE_STATEMENT.test(trimmed)) return true;
  return trimmed.includes('?') && trimmed.length <= 1_200;
}

export function buildRecommendationRecoveryPrompt(input: {
  blockedAnswer: string;
  question: string;
  reasons: readonly string[];
}): string {
  const draft = input.blockedAnswer.trim().slice(0, 1_200);
  return [
    'Internal verification check: your draft recommendation could not be shown yet because required live tool evidence is incomplete:',
    ...input.reasons.map((reason) => `- ${reason}`),
    '',
    'Automatically gather the missing evidence now using the available tools (for example: Sleeper league/roster tools, scoring-aware projections via projectPlayer / compareStartSit / optimizeRosterLineup / rankWaiverTargets / analyzeTradeImpact, and current reporting via searchFirstClassNews) and then write the complete grounded answer.',
    'Do not mention this internal verification step to the user. If a required user choice genuinely cannot be resolved from session context or tools, ask one concise clarifying question without recommending a player yet.',
    ...(draft ? ['', `Original request: ${input.question.trim().slice(0, 500)}`, `Draft summary to verify:\n${draft}`] : []),
  ].join('\n');
}

export function enforceFreeformRecommendation(
  answer: string,
  evidence: RecommendationEvidence,
): EnforcedFreeformRecommendation {
  if (answerWithholdsOrClarifies(answer)) {
    return {
      answer,
      eligibility: { outcome: 'not-applicable', reasons: [] },
    };
  }
  const eligibility = enforceRecommendationEligibility(
    { ...eligibilityAnalysis(), recommendation: { action: answer, rationale: '' } },
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
  const initialInactiveOrTeamless = extractInactiveOrTeamlessPlayers(input.toolResults);
  const initialUnfound = extractUnfoundPlayers(input.toolResults);
  const verifiedUnprojectableSet = new Set([
    ...initialInactiveOrTeamless,
    ...initialUnfound,
  ]);
  const hasInactiveOrTeamlessQuestionMatch = initialInactiveOrTeamless.some((subject) =>
    textMentionsSubject(input.question, subject),
  );
  const hasActiveQuestionMatch = input.toolResults.some((item) =>
    PLAYER_IDENTITY_TOOLS.has(item.toolName) &&
    [...toolInputPlayerSubjects(item), ...playerSubjects([item.output])]
      .map(normalizePlayerName)
      .some((subject) =>
        Boolean(subject) &&
        !verifiedUnprojectableSet.has(subject) &&
        textMentionsSubject(input.question, subject),
      ),
  );
  const hasMatchedDirectProjectionTool = input.toolResults.some((item) =>
    (item.toolName === 'compareStartSit' ||
      item.toolName === 'projectPlayer' ||
      item.toolName === 'projectPlayers') &&
    [...toolInputPlayerSubjects(item), ...playerSubjects([item.output])]
      .some((subject) => textMentionsSubject(input.question, subject)),
  );
  const fullLineupOptimizationRequest =
    /\b(?:optimize|audit)\b|\b(?:full|entire|whole|complete|optimal)\s+(?:starting\s+)?(?:lineup|starters?|roster)\b|\b(?:set|fix|build)\s+(?:my|our|the)\s+(?:week\s+\d+\s+)?(?:starting\s+)?(?:lineup|starters?)\b/iu.test(input.question);
  const generalLineup = fullLineupOptimizationRequest ||
    /\b(?:lineup|starters?)\b|\b(?:who|which|what)\b[^?\n]{0,40}\b(?:start|sit|bench)\b/iu.test(input.question);
  input = { ...input, toolResults: input.toolResults.flatMap((result) => {
    if (result.toolName === 'projectPlayers') {
      const results = asRecord(result.output)?.results;
      const requested = asRecord(result.input)?.playerNames;
      const requestedNames = new Set(Array.isArray(requested)
        ? requested.map((name) => typeof name === 'string' ? name.trim().toLowerCase() : '') : []);
      const returnedNames = Array.isArray(results)
        ? results.map((item) => asRecord(item)?.playerName).filter((name): name is string => typeof name === 'string')
          .map((name) => name.trim().toLowerCase()) : [];
      if (!Array.isArray(results) || !results.length || !Array.isArray(requested) ||
        requestedNames.size !== results.length || new Set(returnedNames).size !== results.length ||
        returnedNames.some((name) => !requestedNames.has(name))) {
        return [{ toolName: 'projectPlayer', output: { recommendationEligible: false }, input: result.input }];
      }
      return results.flatMap((item) => {
        const record = asRecord(item);
        const normalized = typeof record?.playerName === 'string'
          ? normalizePlayerName(record.playerName)
          : '';
        if (record?.status !== 'projected' && normalized && verifiedUnprojectableSet.has(normalized)) {
          return [];
        }
        return [{ toolName: 'projectPlayer',
          input: { ...asRecord(result.input), playerName: record?.playerName },
          output: record?.status === 'projected' ? record.projection : { recommendationEligible: false } }];
      });
    }
    if (result.toolName === 'optimizeRosterLineup') {
      if (
        (hasMatchedDirectProjectionTool || (hasInactiveOrTeamlessQuestionMatch && !hasActiveQuestionMatch)) &&
        !fullLineupOptimizationRequest
      ) {
        return [];
      }
      const out = asRecord(result.output);
      const projections = out?.projections;
      if (!Array.isArray(projections) || !projections.length || out?.recommendationEligible !== true) {
        return [{ toolName: 'projectPlayer', output: { recommendationEligible: false }, input: result.input }];
      }
      const mapped = projections.map((item) => {
        const record = asRecord(item);
        const proj = record?.status === 'projected' ? asRecord(record.projection) : record?.player ? record : null;
        const playerName = (typeof record?.playerName === 'string' ? record.playerName : asRecord(proj?.player)?.name) as string | undefined;
        const limitations = Array.isArray(proj?.limitations)
          ? proj.limitations.filter((entry) => typeof entry !== 'string' || !entry.includes('has no current injury status'))
          : [];
        return {
          toolName: 'projectPlayer',
          input: { ...asRecord(result.input), playerName },
          output: proj
            ? { ...proj, limitations, recommendationEligible: proj.recommendationEligible !== false }
            : { recommendationEligible: false },
        };
      });
      const matching = mapped.filter((item) => individualPlayerResultMatchesQuestion(item, input.question));
      if (matching.length > 0) return matching;
      const swaps = Array.isArray(out?.recommendedSwaps) ? out.recommendedSwaps : [];
      const swapNames = new Set(swaps
        .map((swap) => asRecord(asRecord(swap)?.startPlayer)?.name)
        .filter((name): name is string => typeof name === 'string'));
      const optimalNames = new Set((Array.isArray(out?.optimalLineup) ? out.optimalLineup : [])
        .map((entry) => asRecord(entry)?.name)
        .filter((name): name is string => typeof name === 'string'));
      const targetNames = swapNames.size > 0 ? swapNames : optimalNames;
      const selected = targetNames.size > 0
        ? mapped.filter((item) => typeof item.input.playerName === 'string' && targetNames.has(item.input.playerName))
        : mapped;
      return (selected.length > 0 ? selected : mapped).map((item) => ({
        ...item,
        input: { ...item.input, ...(generalLineup ? { fromLineupOptimization: true } : {}) },
      }));
    }
    if (result.toolName !== 'compareStartSit') return [result];
    const out = asRecord(result.output);
    const projections = out?.projections;
    const requested = asRecord(result.input)?.playerNames;
    if (!Array.isArray(projections) || projections.length < 2 ||
      (Array.isArray(requested) && requested.length !== projections.length)) {
      return [{ toolName: 'projectPlayer', output: { recommendationEligible: false }, input: result.input }];
    }
    const slot = typeof out?.slot === 'string' && out.slot ? out.slot : null;
    const hasValidSlot = Boolean(slot) &&
      out?.slotSupportedByLeague !== false &&
      projections.every((projection) => projectionFitsSlot(projection, slot!));
    return projections.map((projection) => ({ toolName: 'projectPlayer', output: out?.recommendationEligible === true || hasValidSlot
      ? projection : { ...asRecord(projection), recommendationEligible: false },
      input: { ...asRecord(result.input), playerName: asRecord(asRecord(projection)?.player)?.name } }));
  }) };
  if (!input.analysis.recommendation) {
    return {
      currentEvidence: sourceEvidenceState(input.sources),
      identity: 'not-required',
      injury: 'not-required',
      leagueScoring: 'not-required',
      projection: 'not-required',
    };
  }

  const explicitNonSleeper = isExplicitNonSleeperQuestion(input.question, input.toolResults);
  const needsLeagueScoring = !explicitNonSleeper && (
    LEAGUE_REQUEST.test(input.question) ||
    input.analysis.kind === 'player' ||
    input.analysis.kind === 'fantasy-league' ||
    input.analysis.kind === 'fantasy-matchup'
  );
  const needsPlayerStatus = PLAYER_DECISION.test(input.question) ||
    input.analysis.kind === 'player' ||
    input.analysis.kind === 'fantasy-league' ||
    input.analysis.kind === 'fantasy-matchup';
  const needsPlayerIdentity = needsPlayerStatus;

  const unfoundPlayers = extractUnfoundPlayers(input.toolResults);
  const inactiveOrTeamlessPlayers = extractInactiveOrTeamlessPlayers(input.toolResults);
  const projection = projectionEligibilityState(input.toolResults, input.question);
  const requiresRefusalOnly =
    START_SIT_REQUEST.test(input.question) &&
    !explicitNonSleeper &&
    projection === 'not-required' &&
    inactiveOrTeamlessPlayers.length > 0 &&
    !input.toolResults.some((result) => result.toolName === 'projectPlayer');
  return {
    currentEvidence: input.toolResults.length > 0
      ? sourceEvidenceState(input.sources)
      : 'missing',
    ...(inactiveOrTeamlessPlayers.length > 0 ? { inactiveOrTeamlessPlayers } : {}),
    identity: needsPlayerIdentity
      ? identityEvidenceState(input.toolResults, input.question)
      : 'not-required',
    injury: needsPlayerStatus
      ? playerStatusEvidenceState(input.toolResults, input.sources, input.question)
      : 'not-required',
    leagueScoring: needsLeagueScoring
      ? leagueScoringEvidenceState(input.toolResults, input.question)
      : 'not-required',
    projection,
    ...(requiresRefusalOnly ? { requiresRefusalOnly: true } : {}),
    ...(unfoundPlayers.length > 0 ? { unfoundPlayers } : {}),
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

  const recommendationText = `${analysis.recommendation.action}\n${analysis.recommendation.rationale}`;
  const blockingReasons = eligibilityBlockingReasons(evidence, recommendationText);
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

function eligibilityBlockingReasons(
  evidence: RecommendationEvidence,
  recommendationText = '',
): string[] {
  const reasons: string[] = [];
  if (evidence.currentEvidence === 'missing') {
    reasons.push('No current source supports this action.');
  } else if (evidence.currentEvidence === 'stale') {
    reasons.push('The required source data is stale.');
  }
  if (evidence.identity === 'ambiguous') {
    reasons.push('The player identity is ambiguous.');
  } else if (
    evidence.identity === 'missing' ||
    recommendsUnfoundPlayer(recommendationText, evidence.unfoundPlayers)
  ) {
    reasons.push('The player identity is not resolved.');
  }
  if (evidence.injury === 'missing') {
    reasons.push('Current player status and injury evidence is missing.');
  }
  if (evidence.leagueScoring === 'missing') {
    reasons.push('The selected league scoring settings are missing.');
  }
  if (
    evidence.projection === 'ineligible' ||
    recommendsUnfoundPlayer(recommendationText, evidence.inactiveOrTeamlessPlayers) ||
    (evidence.requiresRefusalOnly === true && hasPositiveActionEndorsement(recommendationText))
  ) {
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
  const hasRealPlayer = hasAnyResolvedRealPlayer(toolResults, question);
  const identityResults = toolResults.filter((result) =>
    PLAYER_IDENTITY_TOOLS.has(result.toolName) &&
    !(hasRealPlayer && isVerifiedMissingPlayerLookup(result))
  );
  if (identityResults.length === 0) return 'missing';
  const rosterSubjects = rosterDiscoveredSubjects(toolResults, question);

  const explicitResolutions = deduplicateExplicitResolutions(
    identityResults.filter((result) => result.toolName === 'resolvePlayerIdentity'),
  );
  if (explicitResolutions.length > 0) {
    const statuses = explicitResolutions.map((result) =>
      findIdentityStatus(result.output)
    );
    if (statuses.some((status) => status === 'ambiguous' || status === 'not-found')) {
      return 'ambiguous';
    }
    const anyResolutionMatchesQuestion = explicitResolutions.some((result) =>
      individualPlayerResultMatchesQuestion(result, question, rosterSubjects)
    );
    return statuses.every((status) => status === 'resolved') && anyResolutionMatchesQuestion
      ? 'resolved'
      : 'missing';
  }

  const hasResolvedProjections = identityResults.some((result) => {
    if (result.toolName !== 'projectPlayer') return false;
    const player = asRecord(asRecord(result.output)?.player);
    return Boolean(
      player &&
      typeof player.playerId === 'string' &&
      player.playerId &&
      individualPlayerResultMatchesQuestion(result, question, rosterSubjects),
    );
  });
  const hasQuestionMatchedIndividual = identityResults.some((result) =>
    (result.toolName === 'findPlayers' || result.toolName === 'projectPlayer') &&
    individualPlayerResultMatchesQuestion(result, question, rosterSubjects)
  );

  let resolved = 0;
  for (const result of identityResults) {
    if (result.toolName === 'findPlayers') {
      if (!Array.isArray(result.output) || result.output.length === 0) return 'missing';
      if (result.output.length > 1) {
        if (hasResolvedProjections) {
          resolved += 1;
          continue;
        }
        return 'ambiguous';
      }
      if (!hasQuestionMatchedIndividual && !individualPlayerResultMatchesQuestion(result, question, rosterSubjects)) {
        return 'missing';
      }
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
      if (!hasQuestionMatchedIndividual && !individualPlayerResultMatchesQuestion(result, question, rosterSubjects)) {
        return 'missing';
      }
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

function deduplicateExplicitResolutions(
  resolutions: readonly RecommendationToolResult[],
): RecommendationToolResult[] {
  if (resolutions.length <= 1) return [...resolutions];
  const latestByName = new Map<string, RecommendationToolResult>();
  const unnamed: RecommendationToolResult[] = [];
  for (const result of resolutions) {
    const rawName = asRecord(result.input)?.name;
    const key = typeof rawName === 'string' ? normalizePlayerName(rawName) : '';
    if (!key) unnamed.push(result);
    else latestByName.set(key, result);
  }
  return [...unnamed, ...latestByName.values()];
}

function playerStatusEvidenceState(
  toolResults: readonly RecommendationToolResult[],
  sources: readonly DataSourceRecord[],
  question: string,
): RequiredEvidenceState {
  const subjects = relevantPlayerSubjects(toolResults, question);
  if (subjects.length === 0) return 'missing';
  const hasFreshNewsArticleSource = sources.some((source) =>
    source.id.startsWith('news-article:') && source.cacheOutcome !== 'stale-if-error'
  );
  const hasFreshNewsSource = hasFreshNewsArticleSource || sources.some((source) =>
    source.id.startsWith('news-source:') && source.cacheOutcome !== 'stale-if-error'
  );
  const inactiveOrTeamlessSet = new Set(extractInactiveOrTeamlessPlayers(toolResults));
  const supported = subjects.every((subject) => {
    const hasPlayerStatus = toolResults.some((result) =>
      PLAYER_STATUS_TOOLS.has(result.toolName) &&
      evidenceMatchesSubjects([result.output], [subject]) &&
      (result.toolName === 'projectPlayer' ? hasProjectionPlayerStatus(result.output) : hasPlayerStatusFields(result.output)));
    if (inactiveOrTeamlessSet.has(normalizePlayerName(subject))) {
      const hasResolvedIdentity = toolResults.some((result) =>
        result.toolName === 'resolvePlayerIdentity' &&
        findIdentityStatus(result.output) === 'resolved' &&
        evidenceMatchesSubjects([result.input, result.output], [subject]),
      );
      return hasPlayerStatus || hasResolvedIdentity;
    }
    const hasGroundedWebNews = toolResults.some((result) => result.toolName === 'searchCurrentNews' &&
      evidenceMatchesSubjects([result.output], [subject])) && sources.some((source) => source.id.startsWith('web:'));
    const hasFirstClassNews = (hasFreshNewsArticleSource && toolResults.some((result) =>
      result.toolName === 'searchFirstClassNews' && hasUsableFirstClassNews(result.output, [subject])
    )) || (hasFreshNewsSource && toolResults.some((result) =>
      result.toolName === 'searchFirstClassNews' && hasCleanZeroHeadlineNewsCheck(result, subject)
    ));
    return hasPlayerStatus && (hasGroundedWebNews || hasFirstClassNews);
  });
  return supported ? 'present' : 'missing';
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

function hasCleanZeroHeadlineNewsCheck(
  result: RecommendationToolResult,
  subject: string,
): boolean {
  const output = asRecord(result.output);
  const coverage = asRecord(output?.coverage);
  const succeeded = Number(coverage?.successfulSourceCount ?? 0);
  const failed = Array.isArray(coverage?.failedSources)
    ? coverage.failedSources.length
    : Array.isArray(coverage?.failedSourceIds)
      ? coverage.failedSourceIds.length
      : 0;
  const selected = typeof coverage?.selectedSourceCount === 'number'
    ? coverage.selectedSourceCount
    : succeeded;
  if (succeeded <= 0 || Math.min(succeeded, selected - failed) <= 0) return false;
  if (hasUsableFirstClassNews(output, [subject])) return false;
  const inputQuery = asRecord(result.input)?.query;
  const outputQuery = output?.query;
  return evidenceMatchesSubjects(
    [typeof inputQuery === 'string' ? inputQuery : '', typeof outputQuery === 'string' ? outputQuery : ''],
    [subject],
  );
}

function leagueScoringEvidenceState(
  toolResults: readonly RecommendationToolResult[],
  question: string,
): RequiredEvidenceState {
  const scoringResults = toolResults.filter((result) =>
    SCORING_TOOLS.has(result.toolName) &&
    (result.toolName === 'predictMatchup' ||
      (result.toolName === 'projectLeagueMatchup' && hasMatchupScoring(result.output)) ||
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
    if (isExplicitNonSleeperQuestion(question, toolResults)) {
      const subjects = relevantPlayerSubjects(toolResults, question);
      const statEntries = toolResults.flatMap((result) => {
        const out = asRecord(result.output);
        if (result.toolName === 'getPlayerWeeklyStats' && Array.isArray(out?.stats)) return out.stats;
        if (result.toolName === 'comparePlayerTrends' && Array.isArray(out?.players)) return out.players;
        return [];
      });
      const hasWeeklyStats = statEntries.length > 0 &&
        subjects.length > 0 &&
        subjects.every((subject) => evidenceMatchesSubjects(statEntries, [subject]));
      const hasSchedule = toolResults.some((result) => {
        const games = asRecord(result.output)?.games;
        return result.toolName === 'getNflSchedule' && Array.isArray(games) && games.length > 0;
      });
      return hasWeeklyStats && hasSchedule ? 'eligible' : 'ineligible';
    }
    const inactiveOrTeamlessSet = new Set(extractInactiveOrTeamlessPlayers(toolResults));
    const subjects = relevantPlayerSubjects(toolResults, question);
    if (subjects.length > 0 && subjects.every((subject) => inactiveOrTeamlessSet.has(subject))) {
      return 'not-required';
    }
    return START_SIT_REQUEST.test(question) ? 'ineligible' : 'not-required';
  }
  const comparesPlayers = /\b(?:versus|vs\.?)\b|\bor\s+(?!sit\b|start\b|bench\b|not\b|leave\b|keep\b|him\b|them\b|stream\b|drop\b|hold\b|cut\b|add\b|claim\b|pick\b)\p{L}+/iu.test(question);
  const rosterSubjects = rosterDiscoveredSubjects(toolResults, question);
  const matchedProjections = projections.filter((result) =>
    individualPlayerResultMatchesQuestion(result, question, rosterSubjects)
  );
  if (matchedProjections.length === 0) return 'ineligible';
  const matchedProjectionNames = new Set(
    matchedProjections
      .flatMap((result) => [...toolInputPlayerSubjects(result), ...playerSubjects([result.output])])
      .map(normalizePlayerName)
      .filter(Boolean),
  );
  const matchedUnprojectableCount = new Set(
    [...extractInactiveOrTeamlessPlayers(toolResults), ...extractUnfoundPlayers(toolResults)]
      .filter((subject) => !matchedProjectionNames.has(subject) && textMentionsSubject(question, subject)),
  ).size;
  if (
    START_SIT_REQUEST.test(question) &&
    comparesPlayers &&
    matchedProjections.length + matchedUnprojectableCount < 2
  ) {
    return 'ineligible';
  }
  if (projections.every((result) => asRecord(result.output)?.recommendationEligible === true)) {
    return 'eligible';
  }
  if (
    projections.length >= 2 &&
    projections.some((result) => asRecord(result.output)?.recommendationEligible === true) &&
    projections.every((result) => {
      const out = asRecord(result.output);
      const player = asRecord(out?.player);
      const limitations = Array.isArray(out?.limitations) ? out.limitations : [];
      const kickoffBlocked = limitations.some(
        (item) => typeof item === 'string' &&
          (item.includes('game has started') || item.includes('no verified kickoff time')),
      );
      return Boolean(player && typeof player.playerId === 'string' && player.playerId) &&
        hasProjectionScoring(out) &&
        !kickoffBlocked &&
        (out?.recommendationEligible === true ||
          out?.scoreScope === 'historical-baseline' ||
          out?.opponent === null ||
          (typeof out?.games === 'number' && out.games < 3) ||
          (out?.expectedPoints === 0 && out?.ceiling === 0));
    })
  ) {
    return 'eligible';
  }
  return 'ineligible';
}

function findIdentityStatus(
  value: unknown,
  traversal = createEvidenceTraversal(),
  depth = 0,
): string | null {
  if (!enterEvidenceNode(value, traversal, depth)) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = findIdentityStatus(item, traversal, depth + 1);
      if (status) return status;
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.status === 'string') return record.status;
  if (record.resolution) {
    return findIdentityStatus(record.resolution, traversal, depth + 1);
  }
  return null;
}

function hasPlayerStatusFields(
  value: unknown,
  traversal = createEvidenceTraversal(),
  depth = 0,
): boolean {
  if (!enterEvidenceNode(value, traversal, depth)) return false;
  if (Array.isArray(value)) {
    return value.some((item) =>
      hasPlayerStatusFields(item, traversal, depth + 1)
    );
  }
  const record = value as Record<string, unknown>;
  if (
    'injuryStatus' in record ||
    'practiceParticipation' in record
  ) {
    return true;
  }
  return Object.values(record).some((item) =>
    hasPlayerStatusFields(item, traversal, depth + 1)
  );
}

function hasScoringSettings(
  value: unknown,
  traversal = createEvidenceTraversal(),
  depth = 0,
): boolean {
  if (!enterEvidenceNode(value, traversal, depth)) return false;
  if (Array.isArray(value)) {
    return value.some((item) => hasScoringSettings(item, traversal, depth + 1));
  }
  const record = value as Record<string, unknown>;
  if (
    ('scoringSettings' in record && isNonEmptyRecord(record.scoringSettings)) ||
    ('scoring_settings' in record && isNonEmptyRecord(record.scoring_settings))
  ) {
    return true;
  }
  return Object.values(record).some((item) =>
    hasScoringSettings(item, traversal, depth + 1)
  );
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

function hasMatchupScoring(value: unknown): boolean {
  const rosters = asRecord(value)?.rosters;
  return Array.isArray(rosters) && rosters.length > 0 &&
    rosters.every((roster) => isEmptyArray(asRecord(roster)?.ignoredSettings ?? []));
}

const evidenceTextCache = new WeakMap<object, string>();

function isIndividualPlayerTool(toolName: string, hasQuestionMatch = false): boolean {
  return toolName === 'findPlayers' ||
    toolName === 'projectPlayer' ||
    toolName === 'resolvePlayerIdentity' ||
    (hasQuestionMatch && (
      toolName === 'getRosterPlayers' ||
      toolName === 'rankWaiverTargets' ||
      toolName === 'getTrendingPlayers'
    ));
}

function rosterDiscoveredSubjects(
  toolResults: readonly RecommendationToolResult[],
  question: string,
): ReadonlySet<string> {
  const hasExplicitMatch = toolResults.some((result) =>
    PLAYER_IDENTITY_TOOLS.has(result.toolName) &&
    [...toolInputPlayerSubjects(result), ...playerSubjects([result.output])]
      .some((subject) => textMentionsSubject(question, subject)),
  );
  if (hasExplicitMatch) return new Set();
  const names = toolResults
    .filter((result) =>
      result.toolName === 'getRosterPlayers' ||
      result.toolName === 'rankWaiverTargets' ||
      result.toolName === 'getTrendingPlayers',
    )
    .flatMap((result) => playerSubjects([result.output]))
    .map(normalizePlayerName)
    .filter(Boolean);
  return new Set(names);
}

function individualPlayerResultMatchesQuestion(
  result: RecommendationToolResult,
  question: string,
  rosterSubjects: ReadonlySet<string> = new Set(),
): boolean {
  if (asRecord(result.input)?.fromLineupOptimization === true) return true;
  const subjects = [
    ...toolInputPlayerSubjects(result),
    ...playerSubjects([result.output]),
  ];
  return subjects.some((subject) =>
    textMentionsSubject(question, subject) ||
    (rosterSubjects.size > 0 && rosterSubjects.has(normalizePlayerName(subject)))
  );
}

function relevantPlayerSubjects(
  toolResults: readonly RecommendationToolResult[],
  question: string,
): string[] {
  const hasRealPlayer = hasAnyResolvedRealPlayer(toolResults, question);
  const filteredResults = toolResults.filter((result) =>
    !(hasRealPlayer && isVerifiedMissingPlayerLookup(result))
  );
  const hasQuestionMatch = filteredResults.some((result) =>
    PLAYER_IDENTITY_TOOLS.has(result.toolName) &&
    [...toolInputPlayerSubjects(result), ...playerSubjects([result.output])]
      .some((subject) => textMentionsSubject(question, subject)),
  );
  const hasLineupOptimization = filteredResults.some(
    (result) => asRecord(result.input)?.fromLineupOptimization === true,
  );
  const hasWaiverRanking = filteredResults.some((result) => result.toolName === 'rankWaiverTargets');
  const rosterSubjects = rosterDiscoveredSubjects(filteredResults, question);
  const rosterOnlyNames = new Set(
    filteredResults
      .filter((result) => result.toolName === 'getRosterPlayers')
      .flatMap((result) => playerSubjects([result.output]))
      .map(normalizePlayerName)
      .filter(Boolean),
  );
  const matchedProjections = filteredResults.filter((result) =>
    result.toolName === 'projectPlayer' &&
    individualPlayerResultMatchesQuestion(result, question, rosterSubjects),
  );
  const includeStreamerProjections = hasQuestionMatch &&
    matchedProjections.length > 0 &&
    matchedProjections.every((result) => asRecord(result.output)?.recommendationEligible !== true);
  const hasProjectedRosterSubset = !hasQuestionMatch &&
    rosterOnlyNames.size > 0 &&
    matchedProjections.some((result) =>
      individualPlayerResultMatchesQuestion(result, question, rosterOnlyNames),
    );
  const subjects = filteredResults.flatMap((result) => {
    if (!PLAYER_IDENTITY_TOOLS.has(result.toolName)) return [];
    if (
      result.toolName === 'getRosterPlayers' &&
      (hasProjectedRosterSubset || (!hasQuestionMatch && hasWaiverRanking))
    ) {
      return [];
    }
    if (!hasQuestionMatch && result.toolName === 'getTrendingPlayers' && hasWaiverRanking) {
      return [];
    }
    if (!hasQuestionMatch && (result.toolName === 'rankWaiverTargets' || result.toolName === 'getTrendingPlayers')) {
      return openEndedCandidateSubjects(result, question);
    }
    const candidates = [
      ...toolInputPlayerSubjects(result),
      ...playerSubjects([result.output]),
    ];
    if (
      includeStreamerProjections &&
      result.toolName === 'projectPlayer' &&
      asRecord(result.output)?.recommendationEligible === true
    ) {
      return candidates;
    }
    return isIndividualPlayerTool(result.toolName, hasQuestionMatch || hasLineupOptimization) &&
        asRecord(result.input)?.fromLineupOptimization !== true
      ? candidates.filter((subject) =>
          textMentionsSubject(question, subject) ||
          (rosterSubjects.size > 0 && rosterSubjects.has(normalizePlayerName(subject))))
      : candidates;
  });
  return [...new Set(subjects.map(normalizePlayerName).filter(Boolean))];
}

function projectionFitsSlot(projection: unknown, slot: string): boolean {
  const player = asRecord(asRecord(projection)?.player);
  const fantasyPositions = Array.isArray(player?.fantasy_positions)
    ? player.fantasy_positions.filter((pos): pos is string => typeof pos === 'string' && Boolean(pos))
    : [];
  const positions = fantasyPositions.length > 0
    ? fantasyPositions
    : typeof player?.position === 'string' && player.position
      ? [player.position]
      : [];
  return positions.length > 0 && eligibleForSlot(positions, slot);
}

function extractInactiveOrTeamlessPlayers(toolResults: readonly RecommendationToolResult[]): string[] {
  const verifiedActive = new Set<string>();
  const candidates: string[] = [];
  for (const result of toolResults) {
    if (result.toolName === 'findPlayers' && Array.isArray(result.output) && result.output.length === 1) {
      const record = asRecord(result.output[0]);
      const name = typeof record?.name === 'string'
        ? record.name
        : typeof record?.full_name === 'string'
          ? record.full_name
          : null;
      if (!name) continue;
      if (
        ('team' in (record ?? {}) && record?.team === null) ||
        record?.active === false ||
        record?.status === 'Inactive' ||
        record?.status === 'Retired'
      ) {
        candidates.push(name);
      } else if (typeof record?.team === 'string' && record.team.trim().length > 0 && record.active !== false) {
        verifiedActive.add(normalizePlayerName(name));
      }
    } else if (result.toolName === 'resolvePlayerIdentity' && findIdentityStatus(result.output) === 'resolved') {
      const root = asRecord(result.output);
      const identity = asRecord(asRecord(root?.resolution)?.identity ?? root?.identity);
      const name = typeof identity?.displayName === 'string'
        ? identity.displayName
        : typeof identity?.name === 'string'
          ? identity.name
          : typeof identity?.fullName === 'string'
            ? identity.fullName
            : null;
      if (!name) continue;
      if (
        ('teamId' in (identity ?? {}) && identity?.teamId === null) ||
        ('team' in (identity ?? {}) && identity?.team === null) ||
        identity?.active === false
      ) {
        candidates.push(name);
      } else if (
        ((typeof identity?.teamId === 'string' && identity.teamId.trim().length > 0) ||
          (typeof identity?.team === 'string' && identity.team.trim().length > 0)) &&
        identity?.active !== false
      ) {
        verifiedActive.add(normalizePlayerName(name));
      }
    } else if (result.toolName === 'projectPlayer') {
      const out = asRecord(result.output);
      const player = asRecord(out?.player);
      const name = typeof player?.name === 'string' ? player.name : null;
      if (!name) continue;
      const limitations = Array.isArray(out?.limitations) ? out.limitations : [];
      const lacksActiveTeam = limitations.some(
        (item) => typeof item === 'string' && item.includes('no verified active team'),
      );
      if (out?.recommendationEligible === false && lacksActiveTeam) {
        candidates.push(name);
      } else if (out?.recommendationEligible === true) {
        verifiedActive.add(normalizePlayerName(name));
      }
    }
  }
  return [...new Set(
    candidates
      .map(normalizePlayerName)
      .filter((name) => Boolean(name) && !verifiedActive.has(name)),
  )];
}

function extractUnfoundPlayers(toolResults: readonly RecommendationToolResult[]): string[] {
  const resolved = new Set(
    toolResults
      .filter((result) => !isVerifiedMissingPlayerLookup(result))
      .flatMap((result) => [...toolInputPlayerSubjects(result), ...playerSubjects([result.output])])
      .map(normalizePlayerName)
      .filter(Boolean),
  );
  return [...new Set(
    toolResults
      .filter(isVerifiedMissingPlayerLookup)
      .flatMap(toolInputPlayerSubjects)
      .map(normalizePlayerName)
      .filter((name) => Boolean(name) && !resolved.has(name)),
  )];
}

const COORDINATED_ACTION_VERB =
  '(?:add(?:ing)?|claim(?:ing)?|pick(?:ing)?\\s+up|acquir(?:e|ing)|target(?:ing)?|bid(?:ding)?\\s+on|stream(?:ing)?|drop(?:ping)?|bench(?:ing)?|sit(?:ting)?|start(?:ing)?|play(?:ing)?|roster(?:ing)?|us(?:e|ing)|consider(?:ing)?|touch(?:ing)?)';
const DIRECT_NEGATION_PREFIX = new RegExp(
  `\\b(?:do\\s+not|don['’]?t|can(?:not|['’]?t)|should(?:n['’]?t|\\s+not)|would(?:n['’]?t|\\s+not)|won['’]?t|never|avoid|against|not)` +
    `(?:\\s+(?:ever|even|just|simply|recommend|suggest|advise|try|plan|bother|worth))*(?:\\s+to)?` +
    `(?:\\s+${COORDINATED_ACTION_VERB}\\s*(?:,\\s*(?:(?:or|and|nor)\\b)?|\\b(?:or|and|nor)\\b)(?:\\s+to)?)*\\s*$`,
  'iu',
);
const NON_FIRST_NAME_WORDS = new Set([
  'start', 'starting', 'add', 'adding', 'claim', 'claiming', 'up', 'acquire', 'acquiring',
  'target', 'targeting', 'on', 'stream', 'streaming', 'recommend', 'recommendation',
  'suggest', 'advise', 'sit', 'sitting', 'bench', 'benching', 'drop', 'dropping', 'keep', 'hold',
]);
const REFUSAL_OR_HOLD_WORDS = new Set([
  'do', "don't", 'dont', 'don’t', 'never', 'avoid', 'no', 'none', 'neither', 'not',
  'pass', 'hold', 'keep', 'leave', 'stay', 'withhold', 'withheld', 'unavailable',
  'cannot', "can't", 'cant', 'can’t', 'bench', 'sit', 'drop',
]);

function recommendsUnfoundPlayer(
  text: string,
  unfoundPlayers: readonly string[] | undefined,
): boolean {
  if (!text || !unfoundPlayers?.length) return false;
  const stripped = text.replace(/[*_`~]+/gu, '');
  const clauses = stripped.split(/[\n.!?;]+/u);
  return unfoundPlayers.some((name) => {
    const tokens = name.split(' ').filter(Boolean);
    if (tokens.length === 0) return false;
    const fullPattern = tokens
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
      .join('[\\s.\'’-]+');
    const surname = tokens.length >= 2 ? tokens.at(-1) : undefined;
    const escapedSurname = surname?.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const hasOtherSameSurnamePlayer = Boolean(escapedSurname) && Array.from(
      stripped.matchAll(new RegExp(`\\b([A-Za-z][A-Za-z'’-]{1,20})\\.?\\s+${escapedSurname}\\b`, 'giu')),
    ).some((match) => {
      const rawFirst = match[1]!;
      const candidateFirst = rawFirst.toLowerCase();
      return /^[A-Z]/u.test(rawFirst) &&
        candidateFirst !== tokens[0]!.toLowerCase() &&
        !NON_FIRST_NAME_WORDS.has(candidateFirst);
    });
    const subjectPattern = surname && surname.length >= 4 && !hasOtherSameSurnamePlayer
      ? `(?:${fullPattern}|${escapedSurname})`
      : fullPattern;
    if (new RegExp(`\\brecommendation\\s*(?::|[-–—]|\\bis\\b)\\s*${subjectPattern}\\b`, 'iu').test(stripped)) {
      return true;
    }
    const actionBeforeSubject = new RegExp(
      `\\b(?:start(?:ing)?|add(?:ing)?|claim(?:ing)?|pick(?:ing)?\\s+up|acquir(?:e|ing)|target(?:ing)?|bid(?:ding)?\\s+on|stream(?:ing)?|recommend|suggest|advise)\\s+${subjectPattern}\\b`,
      'giu',
    );
    return clauses.some((clause) =>
      Array.from(clause.matchAll(actionBeforeSubject)).some(
        (match) => !DIRECT_NEGATION_PREFIX.test(clause.slice(0, match.index ?? 0)),
      ),
    );
  });
}

function hasPositiveActionEndorsement(text: string): boolean {
  if (!text) return false;
  const stripped = text.replace(/[*_`~]+/gu, '');
  for (const match of stripped.matchAll(/(?:\b[Rr]ecommendation|\bRECOMMENDATION)\s*:\s*([A-Z][A-Za-z.'’-]+)\s+([A-Z][A-Za-z.'’-]+)/gu)) {
    if (!REFUSAL_OR_HOLD_WORDS.has(match[1]!.toLowerCase())) {
      return true;
    }
  }
  const positiveActionPattern =
    /\b(?:[Ss]tart(?:ing)?|[Aa]dd(?:ing)?|[Cc]laim(?:ing)?|[Pp]ick(?:ing)?\s+[Uu]p|[Aa]cquir(?:e|ing)|[Ss]tream(?:ing)?|START|ADD|CLAIM|PICK\s+UP|ACQUIRE|STREAM)\s+(?!(?:Week|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|NFL|Sleeper|Superflex)\b)[A-Z][A-Za-z.'’-]+/gu;
  return stripped.split(/[\n.!?;]+/u).some((clause) =>
    Array.from(clause.matchAll(positiveActionPattern)).some(
      (match) => !DIRECT_NEGATION_PREFIX.test(clause.slice(0, match.index ?? 0)),
    ),
  );
}

function isExplicitNonSleeperQuestion(
  question: string,
  toolResults: readonly RecommendationToolResult[],
): boolean {
  return /\bnon[-\s]?sleeper\b|\boutside\s+(?:of\s+)?sleeper\b|\bno\s+sleeper\s+league\b/iu.test(question) &&
    leagueIds(toolResults.flatMap((result) => [result.input, result.output])).length === 0;
}

function isVerifiedMissingPlayerLookup(result: RecommendationToolResult): boolean {
  return (result.toolName === 'resolvePlayerIdentity' && findIdentityStatus(result.output) === 'not-found') ||
    (result.toolName === 'findPlayers' && Array.isArray(result.output) && result.output.length === 0);
}

function hasAnyResolvedRealPlayer(
  toolResults: readonly RecommendationToolResult[],
  question: string,
): boolean {
  const rosterSubjects = rosterDiscoveredSubjects(toolResults, question);
  return toolResults.some((result) =>
    individualPlayerResultMatchesQuestion(result, question, rosterSubjects) && (
      (result.toolName === 'resolvePlayerIdentity' && findIdentityStatus(result.output) === 'resolved') ||
      (result.toolName === 'projectPlayer' && Boolean(asRecord(asRecord(result.output)?.player)?.playerId)) ||
      (result.toolName === 'findPlayers' && Array.isArray(result.output) && result.output.length === 1)
    ),
  );
}

function openEndedCandidateSubjects(
  result: RecommendationToolResult,
  question: string,
): string[] {
  const out = asRecord(result.output);
  const rawList = Array.isArray(out?.targets)
    ? out.targets
    : Array.isArray(out?.players)
      ? out.players
      : null;
  if (!rawList) return playerSubjects([result.output]).slice(0, 3);
  const positions = requestedWaiverPositions(question);
  const filtered = positions.size > 0
    ? rawList.filter((entry) => {
        const player = asRecord(asRecord(entry)?.player) ?? asRecord(entry);
        return typeof player?.position === 'string' && positions.has(player.position.toUpperCase());
      })
    : [];
  const topSlice = (filtered.length > 0 ? filtered : rawList).slice(0, 3);
  return playerSubjects(topSlice);
}

function requestedWaiverPositions(question: string): ReadonlySet<string> {
  const positions = new Set<string>();
  if (/\b(?:qbs?|quarterbacks?)\b/iu.test(question)) positions.add('QB');
  if (/\b(?:rbs?|running\s+backs?)\b/iu.test(question)) positions.add('RB');
  if (/\b(?:wrs?|wide\s+receivers?|wideouts?)\b/iu.test(question)) positions.add('WR');
  if (/\b(?:tes?|tight[-\s]+ends?)\b/iu.test(question)) positions.add('TE');
  if (/\b(?:kickers?|placekickers?)\b/iu.test(question)) positions.add('K');
  if (/\b(?:d\/sts?|dsts?|defenses?)\b/iu.test(question)) positions.add('DEF');
  return positions;
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
        : ['playerNames', 'givePlayerNames', 'receivePlayerNames'];
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
  const traversal = createEvidenceTraversal();
  for (const value of values) {
    collectPlayerSubjects(value, output, traversal);
  }
  return [...new Set(output.map((item) => item.trim()).filter((item) => item.length >= 2))];
}

function collectPlayerSubjects(
  value: unknown,
  output: string[],
  traversal: EvidenceTraversal,
  depth = 0,
): void {
  if (!enterEvidenceNode(value, traversal, depth)) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectPlayerSubjects(item, output, traversal, depth + 1);
    }
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
      collectPlayerSubjects(item, output, traversal, depth + 1);
    }
  }
}

function subjectMatchForms(subject: string): string[] {
  const normalized = normalizeEvidenceText(subject);
  if (!normalized) return [];
  const strippedDst = normalized.replace(/\s+(?:d\s*st|dst|def|defense)$/iu, '').trim();
  return strippedDst && strippedDst !== normalized
    ? [normalized, strippedDst]
    : [normalized];
}

function evidenceMatchesSubjects(
  values: readonly unknown[],
  subjects: readonly string[],
): boolean {
  if (subjects.length === 0) return false;
  const evidence = values.map(normalizedEvidenceForValue).join(' ');
  return subjects.some((subject) =>
    subjectMatchForms(subject).some((form) => ` ${evidence} `.includes(` ${form} `)),
  );
}

function normalizedEvidenceForValue(value: unknown): string {
  if (value && typeof value === 'object') {
    const cached = evidenceTextCache.get(value);
    if (cached !== undefined) return cached;
    const computed = normalizeEvidenceText(stringifyEvidence(value));
    evidenceTextCache.set(value, computed);
    return computed;
  }
  return normalizeEvidenceText(stringifyEvidence(value));
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
  const forms = subjectMatchForms(normalizePlayerName(subject));
  if (!normalizedText || forms.length === 0) return false;
  for (const form of forms) {
    if (` ${normalizedText} `.includes(` ${form} `)) return true;
    const tokens = form.split(' ').filter((token) => token.length >= 3);
    const lastName = tokens.length >= 2 ? tokens.at(-1) : null;
    if (lastName && ` ${normalizedText} `.includes(` ${lastName} `)) return true;
  }
  return false;
}

function normalizeEvidenceText(value: string): string {
  return normalizeTeamText(value);
}

function leagueIdsAreConsistent(
  results: readonly RecommendationToolResult[],
  question: string,
): boolean {
  const ids = new Set(results.flatMap((result) => leagueIds([result.input, result.output])));
  const questionIds: string[] = question.match(/\b\d{6,}\b/gu) ?? [];
  return questionIds.length === 0 ||
    (ids.size > 0 && [...ids].every((id) => questionIds.includes(id)));
}

function leagueIds(values: readonly unknown[]): string[] {
  const output: string[] = [];
  const traversal = createEvidenceTraversal();
  for (const value of values) collectLeagueIds(value, output, traversal);
  return output;
}

function collectLeagueIds(
  value: unknown,
  output: string[],
  traversal: EvidenceTraversal,
  depth = 0,
): void {
  if (!enterEvidenceNode(value, traversal, depth)) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      collectLeagueIds(item, output, traversal, depth + 1);
    }
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const [key, item] of Object.entries(record)) {
    if ((key === 'leagueId' || key === 'league_id') && typeof item === 'string') {
      output.push(item);
    } else if (key === 'league' && typeof asRecord(item)?.id === 'string') {
      output.push(asRecord(item)!.id as string);
      collectLeagueIds(item, output, traversal, depth + 1);
    } else if (typeof item === 'object' && item !== null) {
      collectLeagueIds(item, output, traversal, depth + 1);
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

function createEvidenceTraversal(): EvidenceTraversal {
  return {
    remaining: MAX_EVIDENCE_TRAVERSAL_NODES,
    seen: new WeakSet(),
  };
}

function enterEvidenceNode(
  value: unknown,
  traversal: EvidenceTraversal,
  depth: number,
): value is object {
  if (
    !value ||
    typeof value !== 'object' ||
    depth > MAX_EVIDENCE_TRAVERSAL_DEPTH ||
    traversal.remaining <= 0 ||
    traversal.seen.has(value)
  ) {
    return false;
  }
  traversal.seen.add(value);
  traversal.remaining -= 1;
  return true;
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
