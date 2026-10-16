import { throwIfRequestAborted } from '../ai/request-signal.js';
import { eligibleForSlot, optimizeLineup, type LineupPlayer } from '../analysis/lineup.js';
import { ResearchDataError } from '../data/research-error.js';
import type { NflverseClient } from '../nflverse/client.js';
import type { SleeperClient } from '../sleeper/client.js';
import { easternKickoff } from '../time.js';
import { projectPlayers } from './batch.js';
import { sameGameCorrelation } from './comparison.js';
import type { PlayerProjectionService } from './service.js';
import { normalCdf } from './statistics.js';

interface MatchupPlayerEstimate {
  playerId: string;
  name: string;
  position: string | null;
  points: number | null;
  status: 'completed' | 'projected' | 'unavailable';
  reason: string | null;
  ignoredSettings: string[];
}

export interface StackCorrelationEntry {
  players: [string, string];
  relationship: 'same-roster' | 'opposing-roster';
  correlation: number;
}

const BENCH_SLOTS = new Set(['BN', 'BENCH', 'IR', 'RESERVE', 'TAXI']);
const UNAVAILABLE_INJURY = /^(?:out|ir|injured reserve|doubtful|suspended|pup|nfi|cov)/iu;

/** Resolve starters from the selected week and add their verified scores exactly once. */
export async function projectLeagueMatchup(
  sleeper: Pick<SleeperClient, 'getLeague' | 'getLeagueMatchups' | 'getPlayers'>,
  nflverse: Pick<NflverseClient, 'getSchedule'>,
  service: Pick<PlayerProjectionService, 'project'>,
  request: { leagueId: string; rosterId: number; season: number; week: number },
  now = new Date(),
) {
  throwIfRequestAborted();
  const [league, matchups, profiles, schedule] = await Promise.all([
    sleeper.getLeague(request.leagueId),
    sleeper.getLeagueMatchups(request.leagueId, request.week),
    sleeper.getPlayers(),
    nflverse.getSchedule({ season: request.season, week: request.week, gameType: 'REG' }),
  ]);
  if (league.season !== String(request.season)) throw new ResearchDataError('The league season does not match the projected season.');
  const selected = matchups.filter((matchup) => matchup.roster_id === request.rosterId);
  if (selected.length !== 1 || selected[0]?.matchup_id == null) throw new ResearchDataError('The selected roster has no unique matchup for this week.');
  const sides = matchups.filter((matchup) => matchup.matchup_id === selected[0]!.matchup_id);
  if (sides.length !== 2 || sides[0]!.roster_id === sides[1]!.roster_id) throw new ResearchDataError('A head-to-head projection needs exactly two distinct rosters.');
  const opponentByPlayerId = new Map<string, string>();
  const prepared = sides.map((side) => {
    const starters = side.starters ?? [];
    if (!starters.length) throw new ResearchDataError('The selected week has no verified starting lineup.');
    if (new Set(starters.filter((id) => id !== '0')).size !== starters.filter((id) => id !== '0').length) {
      throw new ResearchDataError('The starting lineup contains a duplicate player.');
    }
    return { side, players: starters.map((playerId): MatchupPlayerEstimate => {
      const player = profiles[playerId];
      const name = player?.full_name ?? ([player?.first_name, player?.last_name].filter(Boolean).join(' ') || playerId);
      const base = { playerId, name, position: player?.position ?? null, points: null, ignoredSettings: [] };
      if (!player || playerId === '0') return { ...base, status: 'unavailable', reason: 'This starter slot has no verified player.' };
      const games = schedule.filter((game) => game.homeTeam === player.team || game.awayTeam === player.team);
      if (games.length !== 1) return { ...base, status: 'unavailable', reason: 'This starter has no unique scheduled game.' };
      const game = games[0]!;
      if (player.team) opponentByPlayerId.set(playerId, game.homeTeam === player.team ? game.awayTeam : game.homeTeam);
      const kickoff = easternKickoff(game.gameDate, game.gameTime)?.getTime();
      if (kickoff === undefined) return { ...base, status: 'unavailable', reason: 'The scheduled kickoff time is unknown.' };
      if (kickoff <= now.getTime()) {
        const actual = side.players_points?.[playerId];
        // Schedule scores can lag or describe an in-progress game. Allow time for completion.
        if (game.homeScore !== null && game.awayScore !== null && now.getTime() - kickoff >= 8 * 60 * 60 * 1000 &&
          typeof actual === 'number' && Number.isFinite(actual)) {
          return { ...base, status: 'completed', points: actual, reason: null };
        }
        return { ...base, status: 'unavailable', reason: 'The game started, but a completed individual score is not verified.' };
      }
      return { ...base, status: 'projected', reason: null };
    }) };
  });
  const names = prepared.flatMap(({ players }) => players.filter((player) => player.status === 'projected').map((player) => player.name));
  const batch = await projectPlayers(service, { leagueId: request.leagueId, season: request.season, week: request.week, playerNames: names });
  const byName = new Map(batch.results.map((result) => [result.playerName, result]));
  throwIfRequestAborted();
  const sigmaByPlayerId = new Map<string, number>();
  const rosters = prepared.map(({ side, players }) => {
    for (const player of players) {
      if (player.status !== 'projected') continue;
      const result = byName.get(player.name);
      if (!result || result.status === 'unavailable') {
        player.status = 'unavailable';
        player.reason = result?.reason ?? 'The player projection is unavailable.';
      } else if (result.projection.scoreScope === 'historical-baseline' || !Number.isFinite(result.projection.expectedPoints)) {
        player.status = 'unavailable';
        player.reason = 'The available baseline is not a verified weekly estimate.';
      } else {
        player.points = result.projection.expectedPoints;
        player.ignoredSettings = result.projection.scoring.ignoredSettings;
        const { floor, ceiling } = result.projection;
        if (Number.isFinite(floor) && Number.isFinite(ceiling) && ceiling >= floor) {
          sigmaByPlayerId.set(player.playerId, Math.max(1, (ceiling - floor) / (2 * 1.282)));
        }
      }
    }
    const total = (status: MatchupPlayerEstimate['status']) => Math.round(players
      .filter((player) => player.status === status).reduce((sum, player) => sum + Math.round((player.points ?? 0) * 100), 0)) / 100;
    const completedPoints = total('completed');
    const inProgressPoints = Math.round(players
      .filter((player) => player.reason === 'The game started, but a completed individual score is not verified.')
      .reduce((sum, player) => {
        const actual = side.players_points?.[player.playerId];
        return sum + (typeof actual === 'number' && Number.isFinite(actual) ? Math.round(actual * 100) : 0);
      }, 0)) / 100;
    const remainingProjectedPoints = total('projected');
    const missingStarters = players.filter((player) => player.points === null).map((player) => ({ name: player.name, reason: player.reason }));
    const ignoredSettings = [...new Set(players.flatMap((player) => player.ignoredSettings))].sort();
    return { rosterId: side.roster_id, completedPoints, inProgressPoints, remainingProjectedPoints,
      projectedSubtotal: Math.round((completedPoints + remainingProjectedPoints) * 100) / 100,
      complete: missingStarters.length === 0 && ignoredSettings.length === 0 && side.custom_points == null,
      customPoints: side.custom_points ?? null, missingStarters, ignoredSettings, players };
  });
  let winProbability: number | null = null;
  const stackCorrelations: StackCorrelationEntry[] = [];
  const projA = rosters[0]!.players.filter((player) => player.status === 'projected');
  const projB = rosters[1]!.players.filter((player) => player.status === 'projected');
  if (rosters[0]!.complete && rosters[1]!.complete && (projA.length + projB.length > 0) &&
    [...projA, ...projB].every((player) => sigmaByPlayerId.has(player.playerId))) {
    const meta = (player: MatchupPlayerEstimate) => ({
      position: player.position,
      team: profiles[player.playerId]?.team ?? null,
      opponent: opponentByPlayerId.get(player.playerId) ?? null,
    });
    const rosterVariance = (players: MatchupPlayerEstimate[]) => {
      let variance = players.reduce((sum, player) => sum + sigmaByPlayerId.get(player.playerId)! ** 2, 0);
      for (let i = 0; i < players.length; i += 1) {
        for (let j = i + 1; j < players.length; j += 1) {
          const a = players[i]!;
          const b = players[j]!;
          const rho = sameGameCorrelation(meta(a), meta(b));
          if (rho !== 0) {
            variance += 2 * rho * sigmaByPlayerId.get(a.playerId)! * sigmaByPlayerId.get(b.playerId)!;
            stackCorrelations.push({ players: [a.name, b.name], relationship: 'same-roster', correlation: rho });
          }
        }
      }
      return variance;
    };
    const varA = rosterVariance(projA);
    const varB = rosterVariance(projB);
    let covAB = 0;
    for (const a of projA) {
      for (const b of projB) {
        const rho = sameGameCorrelation(meta(a), meta(b));
        if (rho !== 0) {
          covAB += rho * sigmaByPlayerId.get(a.playerId)! * sigmaByPlayerId.get(b.playerId)!;
          stackCorrelations.push({ players: [a.name, b.name], relationship: 'opposing-roster', correlation: rho });
        }
      }
    }
    const sigmaDiff = Math.sqrt(Math.max(1, varA + varB - 2 * covAB));
    winProbability = Math.round(normalCdf((rosters[0]!.projectedSubtotal - rosters[1]!.projectedSubtotal) / sigmaDiff) * 1000) / 1000;
  }
  return { league: { id: league.league_id, name: league.name }, season: request.season, week: request.week,
    rosters, projections: batch.results, winProbability, stackCorrelations,
    limitations: ['Use the returned subtotals without recalculating them.',
      'A subtotal is a full estimate only when complete is true. Missing starters and omitted scoring rules remain explicit.',
      'Completed points come from Sleeper. Remaining points use historical projections. In-progress games remain unavailable.',
      'Commissioner custom points remain separate from the model subtotal.',
      'This calculation estimates matchup win probability only when all starters are complete and uncertainty intervals are available. News does not automatically change the numerical estimate.'] };
}

/** Solve the optimal starting lineup across starters and bench players for a selected roster and week. */
export async function optimizeRosterLineup(
  sleeper: Pick<SleeperClient, 'getLeague' | 'getLeagueRosters' | 'getLeagueMatchups' | 'getPlayers'>,
  nflverse: Pick<NflverseClient, 'getSchedule'>,
  service: Pick<PlayerProjectionService, 'project'>,
  request: { leagueId: string; rosterId: number; season: number; week: number },
  now = new Date(),
) {
  throwIfRequestAborted();
  const [league, rosters, matchups, profiles, schedule] = await Promise.all([
    sleeper.getLeague(request.leagueId),
    sleeper.getLeagueRosters(request.leagueId),
    sleeper.getLeagueMatchups(request.leagueId, request.week),
    sleeper.getPlayers(),
    nflverse.getSchedule({ season: request.season, week: request.week, gameType: 'REG' }),
  ]);
  if (league.season !== String(request.season)) throw new ResearchDataError('The league season does not match the projected season.');
  const roster = rosters.find((candidate) => candidate.roster_id === request.rosterId);
  if (!roster) throw new ResearchDataError('The selected roster was not found in this league.');
  const starterSlots = (league.roster_positions ?? []).map((slot) => slot.toUpperCase()).filter((slot) => !BENCH_SLOTS.has(slot));
  if (!starterSlots.length) throw new ResearchDataError('The league has no configurable starter slots.');
  const matchup = matchups.find((candidate) => candidate.roster_id === request.rosterId);
  const currentStarterIds = (matchup?.starters?.length ? matchup.starters : roster.starters) ?? [];
  const activeStarterIds = currentStarterIds.filter((id) => id && id !== '0');
  if (new Set(activeStarterIds).size !== activeStarterIds.length) {
    throw new ResearchDataError('The starting lineup contains a duplicate player.');
  }
  const starterSet = new Set(activeStarterIds);
  const blockedReserve = new Set([...(roster.reserve ?? []), ...(roster.taxi ?? [])].filter((id) => !starterSet.has(id)));
  const candidateIds = [...new Set([
    ...activeStarterIds,
    ...(roster.players ?? []).filter((id) => id && id !== '0' && !blockedReserve.has(id)),
  ])];
  type RosterCandidate = MatchupPlayerEstimate & {
    positions: string[];
    injuryStatus: string | null;
    lockedInProgress: boolean;
    recommendationEligible: boolean;
  };
  const byId = new Map<string, RosterCandidate>();
  for (const playerId of candidateIds) {
    const player = profiles[playerId];
    const name = player?.full_name ?? ([player?.first_name, player?.last_name].filter(Boolean).join(' ') || playerId);
    const positions = (player?.fantasy_positions?.length ? player.fantasy_positions : player?.position ? [player.position] : []).map((pos) => pos.toUpperCase());
    const injuryStatus = player?.injury_status ?? null;
    const base: RosterCandidate = {
      playerId, name, position: player?.position ?? positions[0] ?? null, positions, injuryStatus,
      points: null, status: 'unavailable', reason: null, ignoredSettings: [],
      lockedInProgress: false, recommendationEligible: false,
    };
    if (!player) {
      byId.set(playerId, { ...base, reason: 'This roster player has no verified profile.' });
      continue;
    }
    const games = schedule.filter((game) => game.homeTeam === player.team || game.awayTeam === player.team);
    if (games.length !== 1) {
      byId.set(playerId, { ...base, reason: 'No unique scheduled game this week (bye or unscheduled).' });
      continue;
    }
    const game = games[0]!;
    const kickoff = easternKickoff(game.gameDate, game.gameTime)?.getTime();
    if (kickoff === undefined) {
      byId.set(playerId, { ...base, reason: 'The scheduled kickoff time is unknown.' });
      continue;
    }
    if (kickoff <= now.getTime()) {
      if (!starterSet.has(playerId)) {
        byId.set(playerId, { ...base, reason: 'This bench player is locked because their game already started.' });
        continue;
      }
      const actual = matchup?.players_points?.[playerId];
      if (game.homeScore !== null && game.awayScore !== null && now.getTime() - kickoff >= 8 * 60 * 60 * 1000 &&
        typeof actual === 'number' && Number.isFinite(actual)) {
        byId.set(playerId, { ...base, status: 'completed', points: actual, recommendationEligible: true });
      } else {
        byId.set(playerId, { ...base, lockedInProgress: true, reason: 'The game started, but a completed individual score is not verified.' });
      }
      continue;
    }
    if (injuryStatus && UNAVAILABLE_INJURY.test(injuryStatus)) {
      byId.set(playerId, { ...base, reason: `Player is listed as ${injuryStatus}.` });
      continue;
    }
    byId.set(playerId, { ...base, status: 'projected' });
  }
  const names = [...byId.values()].filter((player) => player.status === 'projected').map((player) => player.name);
  const batch = await projectPlayers(service, { leagueId: request.leagueId, season: request.season, week: request.week, playerNames: names });
  const byName = new Map(batch.results.map((result) => [result.playerName, result]));
  throwIfRequestAborted();
  for (const player of byId.values()) {
    if (player.status !== 'projected') continue;
    const result = byName.get(player.name);
    if (!result || result.status === 'unavailable') {
      player.status = 'unavailable';
      player.reason = result?.reason ?? 'The player projection is unavailable.';
    } else if (result.projection.scoreScope === 'historical-baseline' || !Number.isFinite(result.projection.expectedPoints)) {
      player.status = 'unavailable';
      player.reason = 'The available baseline is not a verified weekly estimate.';
    } else {
      player.points = result.projection.expectedPoints;
      player.ignoredSettings = result.projection.scoring.ignoredSettings;
      player.recommendationEligible = result.projection.recommendationEligible === true;
    }
  }
  const eligiblePlayers: LineupPlayer[] = [...byId.values()]
    .filter((player) => (player.status === 'completed' || player.status === 'projected') &&
      player.points !== null && Number.isFinite(player.points) &&
      (player.status === 'completed' || !player.injuryStatus || !UNAVAILABLE_INJURY.test(player.injuryStatus)))
    .map((player) => ({ id: player.playerId, name: player.name, positions: player.positions, points: player.points! }));
  const optimal = optimizeLineup(eligiblePlayers, starterSlots);
  const assignments = optimal.assignments.map((entry) => ({ ...entry }));
  for (const entryA of assignments) {
    if (!starterSet.has(entryA.player.id)) continue;
    const origIndex = currentStarterIds.indexOf(entryA.player.id);
    if (origIndex < 0 || origIndex >= starterSlots.length || entryA.slotIndex === origIndex) continue;
    const entryB = assignments.find((candidate) => candidate.slotIndex === origIndex);
    const origSlot = starterSlots[origIndex]!;
    if (entryB && eligibleForSlot(entryA.player.positions, origSlot) && eligibleForSlot(entryB.player.positions, entryA.slot)) {
      entryB.slot = entryA.slot;
      entryB.slotIndex = entryA.slotIndex;
      entryA.slot = origSlot;
      entryA.slotIndex = origIndex;
    }
  }
  assignments.sort((a, b) => a.slotIndex - b.slotIndex);
  const currentLineup = starterSlots.map((slot, index) => {
    const playerId = currentStarterIds[index] ?? '0';
    const resolved = playerId !== '0' ? byId.get(playerId) : undefined;
    if (!resolved) {
      return { slot, playerId: '0', name: 'Empty Slot', position: null, points: null, status: 'unavailable' as const, injuryStatus: null, reason: 'This starter slot is empty.' };
    }
    return { slot, playerId: resolved.playerId, name: resolved.name, position: resolved.position,
      points: resolved.points, status: resolved.status, injuryStatus: resolved.injuryStatus, reason: resolved.reason };
  });
  const currentProjectedPoints = Math.round(currentLineup.reduce((sum, entry) => sum + Math.round((entry.points ?? 0) * 100), 0)) / 100;
  const optimalLineup = assignments.map(({ slot, slotIndex, player }) => {
    const resolved = byId.get(player.id)!;
    return { slot, slotIndex, playerId: player.id, name: player.name, position: resolved.position,
      points: player.points, status: resolved.status, injuryStatus: resolved.injuryStatus, wasStarter: starterSet.has(player.id) };
  });
  const optimalPlayerIds = new Set(assignments.map((entry) => entry.player.id));
  const displacedIndices = new Set(
    currentLineup
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.playerId === '0' ||
        (!optimalPlayerIds.has(entry.playerId) && entry.status !== 'completed' && !byId.get(entry.playerId)?.lockedInProgress))
      .map(({ index }) => index),
  );
  const promoted = assignments.filter((entry) => !starterSet.has(entry.player.id));
  const directSlots = new Set(promoted.filter((entry) => displacedIndices.has(entry.slotIndex)).map((entry) => entry.slotIndex));
  const recommendedSwaps = promoted.map((entry) => {
    let sitIndex: number | undefined;
    if (displacedIndices.has(entry.slotIndex)) {
      sitIndex = entry.slotIndex;
    } else {
      sitIndex = [...displacedIndices]
        .filter((index) => !directSlots.has(index))
        .sort((a, b) => (currentLineup[a]!.points ?? -Infinity) - (currentLineup[b]!.points ?? -Infinity))[0]
        ?? [...displacedIndices].sort((a, b) => (currentLineup[a]!.points ?? -Infinity) - (currentLineup[b]!.points ?? -Infinity))[0];
    }
    if (sitIndex !== undefined) {
      displacedIndices.delete(sitIndex);
      directSlots.delete(sitIndex);
    }
    const sit = sitIndex !== undefined ? currentLineup[sitIndex]! : null;
    const startMeta = byId.get(entry.player.id)!;
    return {
      slot: entry.slot,
      startPlayer: { playerId: entry.player.id, name: entry.player.name, position: startMeta.position, points: entry.player.points },
      sitPlayer: sit ? { playerId: sit.playerId, name: sit.name, position: sit.position, points: sit.points, injuryStatus: sit.injuryStatus } : null,
      pointsGain: Math.round((entry.player.points - (sit?.points ?? 0)) * 100) / 100,
    };
  });
  const warnings: string[] = [];
  for (const entry of currentLineup) {
    if (entry.playerId === '0') warnings.push(`Starter slot ${entry.slot} is currently empty.`);
    else if (entry.status === 'unavailable') warnings.push(`Current starter ${entry.name} (${entry.slot}) is unavailable: ${entry.reason ?? 'no projection'}`);
    else if (entry.injuryStatus) warnings.push(`Current starter ${entry.name} (${entry.slot}) carries injury designation: ${entry.injuryStatus}.`);
  }
  for (const missingSlot of optimal.missingSlots) {
    warnings.push(`No eligible active player available to fill starter slot ${missingSlot}.`);
  }
  const ignoredSettings = [...new Set([...byId.values()].flatMap((player) => player.ignoredSettings))].sort();
  const hasLockedInProgressStarter = activeStarterIds.some((id) => byId.get(id)?.lockedInProgress === true);
  const complete = optimal.complete && ignoredSettings.length === 0 && !hasLockedInProgressStarter;
  const recommendationEligible = complete && assignments.every((entry) => byId.get(entry.player.id)?.recommendationEligible === true);
  return {
    league: { id: league.league_id, name: league.name },
    rosterId: request.rosterId,
    season: request.season,
    week: request.week,
    starterSlots,
    currentLineup,
    currentProjectedPoints,
    optimalLineup,
    optimalProjectedPoints: optimal.expectedPoints,
    pointsDelta: Math.round(Math.max(0, optimal.expectedPoints - currentProjectedPoints) * 100) / 100,
    recommendedSwaps,
    missingSlots: optimal.missingSlots,
    complete,
    recommendationEligible,
    ignoredSettings,
    warnings,
    projections: batch.results,
  };
}


