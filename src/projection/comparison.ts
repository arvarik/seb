import { eligibleForSlot } from '../analysis/lineup.js';
import { ResearchDataError } from '../data/research-error.js';
import type { ScoringAwarePlayerProjection } from './player-projection.js';
import { normalCdf } from './statistics.js';

export function compareProjections(projections: readonly ScoringAwarePlayerProjection[], requestedSlot?: string) {
  if (projections.length < 2 || projections.length > 6) throw new ResearchDataError('Compare from two through six player projections.');
  if (projections.some((projection) => ![projection.expectedPoints, projection.floor, projection.ceiling].every(Number.isFinite) ||
    projection.floor > projection.expectedPoints || projection.ceiling < projection.expectedPoints)) {
    throw new ResearchDataError('Comparison requires finite scores and a valid range for each player.');
  }
  const first = projections[0]!;
  if (new Set(projections.map((projection) => projection.player.playerId)).size !== projections.length ||
    projections.some((projection) => projection.league.leagueId !== first.league.leagueId || projection.week !== first.week || projection.season !== first.season)) {
    throw new ResearchDataError('Comparison players must be distinct and use the same league and week.');
  }
  const ordered = [...projections].sort((a, b) => b.expectedPoints - a.expectedPoints || a.player.playerId.localeCompare(b.player.playerId));
  const leader = ordered[0]!;
  const runnerUp = ordered[1]!;
  const sigma = (projection: ScoringAwarePlayerProjection) => Math.max(1, (projection.ceiling - projection.floor) / (2 * 1.282));
  const difference = leader.expectedPoints - runnerUp.expectedPoints;
  const standardError = Math.hypot(sigma(leader), sigma(runnerUp));
  const probability = normalCdf(difference / standardError);
  const positions = new Set(projections.map((projection) => projection.player.position));
  const slot = requestedSlot?.toUpperCase() ?? (positions.size === 1 ? first.player.position : null);
  const eligible = Boolean(slot) && projections.every((projection) => projection.recommendationEligible && eligibleForSlot([projection.player.position], slot!));
  return { slot, projections: ordered, recommendationEligible: eligible,
    preferredPlayerId: eligible ? leader.player.playerId : null,
    expectedPointAdvantage: Math.round(difference * 100) / 100,
    approximateHeadToHeadProbability: Math.round(probability * 1000) / 1000,
    closeDecision: probability < 0.6,
    assumptions: ['The comparison maximizes expected points.',
      ...(!slot ? ['Select a legal starter slot when comparing different positions.'] : []),
      ...(!eligible ? ['A player or starter slot failed an eligibility check. The comparison cannot select a starter.'] : []),
      'The probability assumes independent normal scoring errors. Shared-game correlation can change it.',
      'The probability is a model estimate, not a validated win rate.',
      'Current status, scoring, schedule, and news safeguards still apply.'] };
}
