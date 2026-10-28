import { eligibleForSlot } from '../analysis/lineup.js';
import { ResearchDataError } from '../data/research-error.js';
import type { ScoringAwarePlayerProjection } from './player-projection.js';
import { normalCdf } from './statistics.js';

const SKILL = new Set(['RB', 'WR', 'TE']);
const OFFENSE = new Set(['QB', 'RB', 'WR', 'TE']);
const SCORING_OFFENSE = new Set(['QB', 'RB', 'WR', 'TE', 'K']);
const PASS_GAME = new Set(['QB', 'WR', 'TE']);
const INFERRED_SLOT_PRIORITY = [
  'QB',
  'RB',
  'WR',
  'TE',
  'K',
  'DEF',
  'WRRB_FLEX',
  'REC_FLEX',
  'WRTE_FLEX',
  'FLEX',
  'WRRBTE_FLEX',
  'SUPER_FLEX',
] as const;

export function sameGameCorrelation(
  a: { position: string | null; team: string | null; opponent?: string | null },
  b: { position: string | null; team: string | null; opponent?: string | null },
): number {
  if (!a.team || !b.team || !a.position || !b.position) return 0;
  const posA = a.position.toUpperCase();
  const posB = b.position.toUpperCase();
  const teamA = a.team.toUpperCase();
  const teamB = b.team.toUpperCase();
  const oppA = a.opponent?.toUpperCase() ?? null;
  const oppB = b.opponent?.toUpperCase() ?? null;
  if (teamA === teamB) {
    if (oppA && oppB && oppA !== oppB) return 0;
    if ((posA === 'QB' && SKILL.has(posB)) || (posB === 'QB' && SKILL.has(posA))) return 0.3;
    if (SKILL.has(posA) && SKILL.has(posB)) return -0.1;
    if ((posA === 'K' && OFFENSE.has(posB)) || (posB === 'K' && OFFENSE.has(posA))) return 0.1;
    return 0;
  }
  if (((oppA && oppA === teamB) || (oppB && oppB === teamA)) && (!oppA || oppA === teamB) && (!oppB || oppB === teamA)) {
    if ((posA === 'DEF' && SCORING_OFFENSE.has(posB)) || (posB === 'DEF' && SCORING_OFFENSE.has(posA))) return -0.25;
    if (PASS_GAME.has(posA) && PASS_GAME.has(posB)) return 0.12;
  }
  return 0;
}

export function compareProjections(
  projections: readonly ScoringAwarePlayerProjection[],
  requestedSlot?: string,
  rosterPositions?: readonly string[],
) {
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
  const rho = sameGameCorrelation(
    { position: leader.player.position, team: leader.player.team, opponent: leader.opponent },
    { position: runnerUp.player.position, team: runnerUp.player.team, opponent: runnerUp.opponent },
  );
  const sA = sigma(leader);
  const sB = sigma(runnerUp);
  const standardError = Math.sqrt(Math.max(1, sA * sA + sB * sB - 2 * rho * sA * sB));
  const probability = normalCdf(difference / standardError);
  const positions = new Set(projections.map((projection) => projection.player.position));
  const leagueSlots = rosterPositions?.length
    ? new Set(rosterPositions.map((candidate) => candidate.toUpperCase()))
    : null;
  const inferredLeagueSlot = leagueSlots
    ? INFERRED_SLOT_PRIORITY.find(
        (candidate) =>
          leagueSlots.has(candidate) &&
          projections.every((projection) =>
            eligibleForSlot(
              projection.player.fantasy_positions?.length
                ? projection.player.fantasy_positions
                : [projection.player.position],
              candidate,
            ),
          ),
      ) ?? null
    : null;
  const slot =
    requestedSlot?.toUpperCase() ??
    (positions.size === 1 ? first.player.position : inferredLeagueSlot);
  const starterLeagueSlots = leagueSlots
    ? [...leagueSlots].filter((candidate) => !['BN', 'BENCH', 'IR', 'RESERVE', 'TAXI'].includes(candidate))
    : null;
  const slotPositions = slot
    ? ['QB', 'RB', 'WR', 'TE', 'K', 'DEF', 'DL', 'LB', 'DB'].filter((pos) => eligibleForSlot([pos], slot))
    : [];
  const slotSupportedByLeague = !starterLeagueSlots?.length || (slotPositions.length > 0 &&
    starterLeagueSlots.some((leagueSlot) => slotPositions.every((pos) => eligibleForSlot([pos], leagueSlot))));
  const eligible = Boolean(slot) && slotSupportedByLeague && projections.every((projection) => projection.recommendationEligible && eligibleForSlot(projection.player.fantasy_positions?.length ? projection.player.fantasy_positions : [projection.player.position], slot!));
  return { slot, slotSupportedByLeague, projections: ordered, recommendationEligible: eligible,
    preferredPlayerId: eligible ? leader.player.playerId : null,
    expectedPointAdvantage: Math.round(difference * 100) / 100,
    approximateHeadToHeadProbability: Math.round(probability * 1000) / 1000,
    correlation: rho,
    closeDecision: probability < 0.6,
    assumptions: ['The comparison maximizes expected points.',
      ...(!slot ? ['Select a legal starter slot when comparing different positions.'] : []),
      ...(slot && !slotSupportedByLeague ? [`Starter slot ${slot} is not configured in this league.`] : []),
      ...(!eligible ? ['A player or starter slot failed an eligibility check. The comparison cannot select a starter.'] : []),
      rho !== 0
        ? 'The probability assumes normal scoring errors with empirical same-game stack/touch correlation adjustments.'
        : 'The probability assumes independent normal scoring errors. Shared-game correlation can change it.',
      'The probability is a model estimate, not a validated win rate.',
      'Current status, scoring, schedule, and news safeguards still apply.'] };
}

