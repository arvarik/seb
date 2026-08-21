import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import type {
  SleeperLeague,
  SleeperNflState,
  SleeperPlayer,
  SleeperPlayerMap,
} from '../sleeper/types.js';
import {
  analyzeTradeImpact,
  type TradeImpactAnalysis,
} from './trade-impact.js';

export interface TradeImpactRequest {
  analysisSeason?: number;
  givePlayerNames: string[];
  leagueId: string;
  receivePlayerNames: string[];
  rosterId: number;
  throughWeek?: number;
}

export class TradeImpactService {
  constructor(
    private readonly sleeper: SleeperClient,
    private readonly nflverse: NflverseClient,
  ) {}

  async analyze(request: TradeImpactRequest): Promise<TradeImpactAnalysis> {
    const [league, rosters, players, state] = await Promise.all([
      this.sleeper.getLeague(request.leagueId),
      this.sleeper.getLeagueRosters(request.leagueId),
      this.sleeper.getPlayers(),
      this.sleeper.getNflState(),
    ]);
    let window = resolveAnalysisWindow(league, state, request);
    let rows = await this.readStats(window.analysisSeason, window.throughWeek);
    if (
      rows.length === 0 &&
      request.analysisSeason === undefined &&
      request.throughWeek === undefined
    ) {
      window = { analysisSeason: window.analysisSeason - 1, throughWeek: 18 };
      rows = await this.readStats(window.analysisSeason, window.throughWeek);
    }
    const roster = rosters.find((candidate) => candidate.roster_id === request.rosterId);
    if (!roster) throw new Error(`Roster ${request.rosterId} does not exist in this league.`);
    const givePlayers = resolvePlayers(players, request.givePlayerNames);
    const receivePlayers = resolvePlayers(players, request.receivePlayerNames);
    const ownPlayerIds = new Set(roster.players ?? []);
    const invalidGive = givePlayers.find((player) => !ownPlayerIds.has(player.player_id));
    if (invalidGive) {
      throw new Error(`${playerName(invalidGive)} is not on roster ${request.rosterId}.`);
    }
    const invalidReceive = receivePlayers.find((player) => ownPlayerIds.has(player.player_id));
    if (invalidReceive) {
      throw new Error(`${playerName(invalidReceive)} is already on roster ${request.rosterId}.`);
    }
    const rosteredIds = new Set(rosters.flatMap((candidate) => candidate.players ?? []));
    const freeAgent = receivePlayers.find((player) => !rosteredIds.has(player.player_id));
    if (freeAgent) {
      throw new Error(`${playerName(freeAgent)} is not rostered in this league. Use the waiver assistant.`);
    }
    return analyzeTradeImpact({
      analysisSeason: window.analysisSeason,
      givePlayers,
      league,
      receivePlayers,
      roster,
      rosterPlayers: (roster.players ?? []).flatMap((playerId) => {
        const player = players[playerId];
        return player ? [player] : [];
      }),
      rows,
      throughWeek: window.throughWeek,
    });
  }

  private readStats(season: number, throughWeek: number) {
    return this.nflverse.getPlayerWeeklyStats({
      season,
      seasonType: 'REG',
      throughWeek,
    });
  }
}

function resolveAnalysisWindow(
  league: SleeperLeague,
  state: SleeperNflState,
  request: TradeImpactRequest,
): { analysisSeason: number; throughWeek: number } {
  const leagueSeason = parseSeason(league.season);
  if (request.analysisSeason !== undefined || request.throughWeek !== undefined) {
    return {
      analysisSeason: request.analysisSeason ?? leagueSeason,
      throughWeek: request.throughWeek ?? 18,
    };
  }
  const stateSeason = parseSeason(state.season);
  if (leagueSeason < stateSeason) {
    return { analysisSeason: leagueSeason, throughWeek: 18 };
  }
  const phase = state.season_type.trim().toLowerCase();
  if (phase === 'regular' && state.week > 1) {
    return { analysisSeason: leagueSeason, throughWeek: state.week - 1 };
  }
  if (phase === 'post' || phase === 'postseason') {
    return { analysisSeason: leagueSeason, throughWeek: 18 };
  }
  return {
    analysisSeason: parseOptionalSeason(state.previous_season) ?? leagueSeason - 1,
    throughWeek: 18,
  };
}

function parseSeason(value: string): number {
  const season = Number(value);
  if (!Number.isInteger(season) || season < 1999 || season > 2100) {
    throw new Error(`The season ${value} is invalid.`);
  }
  return season;
}

function parseOptionalSeason(value: string | undefined): number | null {
  return value ? parseSeason(value) : null;
}

function resolvePlayers(
  players: SleeperPlayerMap,
  names: readonly string[],
): SleeperPlayer[] {
  return names.map((name) => {
    const normalized = normalizeName(name);
    const matches = Object.values(players).filter((player) =>
      normalizeName(playerName(player)) === normalized,
    );
    if (matches.length === 0) throw new Error(`Sleeper found no player named ${name}.`);
    if (matches.length > 1) throw new Error(`The player name ${name} is ambiguous.`);
    return matches[0] as SleeperPlayer;
  });
}

function playerName(player: SleeperPlayer): string {
  return player.full_name ?? (
    [player.first_name, player.last_name].filter(Boolean).join(' ') || player.player_id
  );
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
