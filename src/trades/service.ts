import { normalizePlayerName } from '../identity/normalize.js';
import { LearningStore } from '../learning/store.js';
import { resolveCompletedAnalysisWindow } from '../analysis/window.js';
import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import type {
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
    private readonly learning: LearningStore | false = new LearningStore(),
  ) {}

  async analyze(request: TradeImpactRequest): Promise<TradeImpactAnalysis> {
    const [league, rosters, players, state] = await Promise.all([
      this.sleeper.getLeague(request.leagueId),
      this.sleeper.getLeagueRosters(request.leagueId),
      this.sleeper.getPlayers(),
      this.sleeper.getNflState(),
    ]);
    let window = resolveCompletedAnalysisWindow(league.season, state, request);
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
    assertUniquePlayers(givePlayers, 'give');
    assertUniquePlayers(receivePlayers, 'receive');
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
    const receivePlayerIds = new Set(receivePlayers.map((player) => player.player_id));
    const counterparties = rosters.filter((candidate) => {
      if (candidate.roster_id === request.rosterId) return false;
      const candidatePlayerIds = new Set(candidate.players ?? []);
      return [...receivePlayerIds].every((playerId) => candidatePlayerIds.has(playerId));
    });
    if (counterparties.length === 0) {
      throw new Error('Every received player must belong to the same opposing roster.');
    }
    const learned = this.learning ? await this.learning.context(window.analysisSeason, window.throughWeek, league.scoring_settings) : null;
    return analyzeTradeImpact({
      ...(learned?.parameters ? { parameters: learned.parameters } : {}),
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

function assertUniquePlayers(
  players: readonly SleeperPlayer[],
  side: 'give' | 'receive',
): void {
  const ids = players.map((player) => player.player_id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Each player on the ${side} side must appear only once.`);
  }
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
  return normalizePlayerName(value);
}
