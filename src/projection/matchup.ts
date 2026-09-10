import { throwIfRequestAborted } from '../ai/request-signal.js';
import { ResearchDataError } from '../data/research-error.js';
import type { NflverseClient } from '../nflverse/client.js';
import type { SleeperClient } from '../sleeper/client.js';
import { easternKickoff } from '../time.js';
import { projectPlayers } from './batch.js';
import type { PlayerProjectionService } from './service.js';

interface MatchupPlayerEstimate {
  playerId: string;
  name: string;
  position: string | null;
  points: number | null;
  status: 'completed' | 'projected' | 'unavailable';
  reason: string | null;
  ignoredSettings: string[];
}

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
      if (player.position === 'DEF') return { ...base, status: 'unavailable', reason: 'Team defense projections are unavailable.' };
      return { ...base, status: 'projected', reason: null };
    }) };
  });
  const names = prepared.flatMap(({ players }) => players.filter((player) => player.status === 'projected').map((player) => player.name));
  const batch = await projectPlayers(service, { leagueId: request.leagueId, season: request.season, week: request.week, playerNames: names });
  const byName = new Map(batch.results.map((result) => [result.playerName, result]));
  throwIfRequestAborted();
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
      }
    }
    const total = (status: MatchupPlayerEstimate['status']) => Math.round(players
      .filter((player) => player.status === status).reduce((sum, player) => sum + Math.round((player.points ?? 0) * 100), 0)) / 100;
    const completedPoints = total('completed');
    const remainingProjectedPoints = total('projected');
    const missingStarters = players.filter((player) => player.points === null).map((player) => ({ name: player.name, reason: player.reason }));
    const ignoredSettings = [...new Set(players.flatMap((player) => player.ignoredSettings))].sort();
    return { rosterId: side.roster_id, completedPoints, remainingProjectedPoints,
      projectedSubtotal: Math.round((completedPoints + remainingProjectedPoints) * 100) / 100,
      complete: missingStarters.length === 0 && ignoredSettings.length === 0 && side.custom_points == null,
      customPoints: side.custom_points ?? null, missingStarters, ignoredSettings, players };
  });
  return { league: { id: league.league_id, name: league.name }, season: request.season, week: request.week,
    rosters, projections: batch.results, winProbability: null,
    limitations: ['Use the returned subtotals without recalculating them.',
      'A subtotal is a full estimate only when complete is true. Missing starters and omitted scoring rules remain explicit.',
      'Completed points come from Sleeper. Remaining points use historical projections. In-progress games remain unavailable.',
      'Commissioner custom points remain separate from the model subtotal.',
      'This calculation does not estimate a matchup win probability. News does not automatically change the numerical estimate.'] };
}
