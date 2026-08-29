import { throwIfRequestAborted } from '../ai/request-signal.js';
import { NflverseClient } from '../nflverse/client.js';
import type { NflversePlayerWeek } from '../nflverse/types.js';
import { SleeperClient } from '../sleeper/client.js';
import type { SleeperPlayer } from '../sleeper/types.js';
import { GameWeatherService } from '../weather/game-weather.js';
import { WeatherClient } from '../weather/client.js';
import {
  projectPlayer,
  type ScoringAwarePlayerProjection,
} from './player-projection.js';

export interface PlayerProjectionRequest {
  analysisSeason?: number;
  leagueId: string;
  playerName: string;
  season: number;
  throughWeek?: number;
  week: number;
}

export class PlayerProjectionService {
  private readonly gameWeather: GameWeatherService;

  constructor(
    private readonly sleeper: SleeperClient,
    private readonly nflverse: NflverseClient,
    weather: WeatherClient,
  ) {
    this.gameWeather = new GameWeatherService(nflverse, weather);
  }

  async project(request: PlayerProjectionRequest): Promise<ScoringAwarePlayerProjection> {
    let analysisSeason = request.analysisSeason ??
      (request.week === 1 ? request.season - 1 : request.season);
    let throughWeek = request.throughWeek ??
      (analysisSeason < request.season ? 18 : Math.max(0, request.week - 1));
    if (throughWeek < 1) {
      throw new Error('A player projection needs at least one completed analysis week. Select the prior season for Week 1.');
    }

    const [league, initialRows, playerMatches] = await Promise.all([
      this.sleeper.getLeague(request.leagueId),
      this.nflverse.getPlayerWeeklyStats({
        playerName: request.playerName,
        season: analysisSeason,
        seasonType: 'REG',
        throughWeek,
      }),
      this.sleeper.findPlayers(request.playerName, { active: true, limit: 10 }),
    ]);
    let matchingRows = initialRows;
    if (
      matchingRows.length === 0 &&
      request.analysisSeason === undefined &&
      request.throughWeek === undefined &&
      analysisSeason === request.season
    ) {
      analysisSeason = request.season - 1;
      throughWeek = 18;
      matchingRows = await this.nflverse.getPlayerWeeklyStats({
        playerName: request.playerName,
        season: analysisSeason,
        seasonType: 'REG',
        throughWeek,
      });
    }
    const rows = resolvePlayerRows(matchingRows, request.playerName);
    const latest = rows.at(-1);
    if (!latest) throw new Error(`nflverse found no completed games for ${request.playerName}.`);
    const player = resolveSleeperPlayer(playerMatches, latest.playerDisplayName);
    const currentTeam = player?.team?.toUpperCase() ?? latest.team;

    const [schedule, positionRows] = await Promise.all([
      this.nflverse.getSchedule({
        gameType: 'REG',
        season: request.season,
        team: currentTeam,
        week: request.week,
      }),
      this.nflverse.getPlayerWeeklyStats({
        position: normalizedPosition(latest.position),
        season: analysisSeason,
        seasonType: 'REG',
        throughWeek,
      }),
    ]);
    const game = schedule[0] ?? null;
    const opponent = game
      ? game.homeTeam === currentTeam ? game.awayTeam : game.homeTeam
      : null;
    const weather = game
      ? await this.gameWeather.getScheduledGameWeather(game).catch(() => {
          throwIfRequestAborted();
          return null;
        })
      : null;

    return projectPlayer({
      analysisSeason,
      currentTeam,
      injuryStatus: player?.injury_status ?? player?.status ?? null,
      leagueId: league.league_id,
      leagueName: league.name,
      opponent,
      opponentRows: positionRows,
      rows,
      scoringSettings: league.scoring_settings,
      throughWeek,
      weatherRisk: weather?.risk ?? null,
      weatherStatus: weather?.status ?? null,
      week: request.week,
    });
  }
}

function resolvePlayerRows(
  rows: readonly NflversePlayerWeek[],
  requestedName: string,
): NflversePlayerWeek[] {
  const requested = normalizeName(requestedName);
  const byPlayer = new Map<string, NflversePlayerWeek[]>();
  for (const row of rows) {
    const current = byPlayer.get(row.playerId) ?? [];
    current.push(row);
    byPlayer.set(row.playerId, current);
  }
  const groups = [...byPlayer.values()];
  const exact = groups.filter((group) => normalizeName(group[0]?.playerDisplayName ?? '') === requested);
  const selected = exact.length === 1 ? exact[0] : groups.length === 1 ? groups[0] : null;
  if (!selected) {
    const names = groups.map((group) => group[0]?.playerDisplayName).filter(Boolean);
    throw new Error(
      names.length > 0
        ? `The player name is ambiguous. Matches: ${names.join(', ')}.`
        : `nflverse found no completed games for ${requestedName}.`,
    );
  }
  return [...selected].sort((left, right) => left.week - right.week);
}

function resolveSleeperPlayer(
  players: readonly SleeperPlayer[],
  name: string,
): SleeperPlayer | null {
  const normalized = normalizeName(name);
  return players.find((player) =>
    normalizeName(
      player.full_name ?? [player.first_name, player.last_name].filter(Boolean).join(' '),
    ) === normalized,
  ) ?? null;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizedPosition(value: string): 'QB' | 'RB' | 'WR' | 'TE' | 'K' {
  const normalized = value.toUpperCase();
  if (['QB', 'RB', 'WR', 'TE', 'K'].includes(normalized)) {
    return normalized as 'QB' | 'RB' | 'WR' | 'TE' | 'K';
  }
  throw new Error(`Seb cannot project the ${value} position.`);
}
