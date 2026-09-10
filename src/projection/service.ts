import { enrichSpecialTeams, PLAYER_SPECIAL_TEAMS_SETTINGS } from '../nflverse/defense.js';
import { projectDefense } from './defense.js';
import { ResearchDataError } from '../data/research-error.js';
import { easternKickoff } from '../time.js';
import { resolveCompletedAnalysisWindow } from '../analysis/window.js';
import { LearningStore } from '../learning/store.js';
import { positionPrior } from '../learning/engine.js';
import { normalizePlayerName } from '../identity/normalize.js';
import { TeamIdentityRegistry } from '../identity/teams.js';
import { throwIfRequestAborted } from '../ai/request-signal.js';
import { NflverseApiError, NflverseClient } from '../nflverse/client.js';
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
    private readonly learning: LearningStore | false = new LearningStore(),
  ) {
    this.gameWeather = new GameWeatherService(nflverse, weather);
  }

  async project(request: PlayerProjectionRequest): Promise<ScoringAwarePlayerProjection> {
    throwIfRequestAborted();
    const team = new TeamIdentityRegistry().resolve(request.playerName.replace(/\s+(?:D\/ST|DST|DEF|defense)$/iu, ''));
    let analysisSeason = request.analysisSeason ??
      (request.week === 1 ? request.season - 1 : request.season);
    let throughWeek = request.throughWeek ??
      (analysisSeason < request.season ? 18 : Math.max(0, request.week - 1));
    if (!Number.isInteger(request.week) || request.week < 1 || request.week > 18 ||
      !Number.isInteger(request.season) || request.season < 1999 || request.season > 2100 ||
      !Number.isInteger(analysisSeason) || !Number.isInteger(throughWeek) || throughWeek > 18 ||
      analysisSeason > request.season || (analysisSeason === request.season && throughWeek >= request.week)) {
      throw new ResearchDataError('Projection training must use a valid season and end before the projected week.');
    }
    if (throughWeek < 1) {
      throw new ResearchDataError('A player projection needs at least one completed analysis week. Select the prior season for Week 1.');
    }

    const state = await this.sleeper.getNflState();
    const completed = resolveCompletedAnalysisWindow(String(request.season), state, {});
    if (analysisSeason > completed.analysisSeason && request.analysisSeason === undefined && request.throughWeek === undefined) {
      analysisSeason = completed.analysisSeason;
      throughWeek = completed.throughWeek;
    } else if (analysisSeason === completed.analysisSeason && throughWeek > completed.throughWeek && request.throughWeek === undefined) {
      throughWeek = completed.throughWeek;
    }
    resolveCompletedAnalysisWindow(String(request.season), state, { analysisSeason, throughWeek });
    if (team.status === 'resolved') {
      const code = team.identity.code;
      const [league, data, schedule] = await Promise.all([
        this.sleeper.getLeague(request.leagueId), (async () => {
          const automatic = request.analysisSeason === undefined && request.throughWeek === undefined && analysisSeason === request.season;
          let data = await this.nflverse.getDefenseData(analysisSeason).catch((error: unknown) => {
            throwIfRequestAborted();
            if (automatic && error instanceof NflverseApiError && error.status === 404) return { weeks: [], specialTeams: {} };
            throw error;
          });
          if (automatic && !data.weeks.some(row => row.team === code && row.week <= throughWeek)) {
            analysisSeason = request.season - 1; throughWeek = 18;
            data = await this.nflverse.getDefenseData(analysisSeason);
          }
          return data;
        })(),
        this.nflverse.getSchedule({ season: request.season, week: request.week, team: code, gameType: 'REG' }),
      ]);
      if (league.season !== String(request.season)) throw new ResearchDataError('The league season does not match the projection.');
      if (schedule.length > 1) throw new ResearchDataError('The defense has multiple scheduled games.');
      const game = schedule[0];
      const kickoff = game ? easternKickoff(game.gameDate, game.gameTime) : null;
      return projectDefense({ rows: data.weeks, team: code, name: `${team.identity.city} ${team.identity.name}`,
        opponent: game ? game.homeTeam === code ? game.awayTeam : game.homeTeam : null,
        analysisSeason, throughWeek, season: request.season, week: request.week,
        leagueId: league.league_id, leagueName: league.name, scoringSettings: league.scoring_settings,
        scheduled: Boolean(kickoff), gameStarted: Boolean(kickoff && kickoff.getTime() <= Date.now()) });
    }
    const automaticCurrentSeason = request.analysisSeason === undefined && request.throughWeek === undefined && analysisSeason === request.season;
    const historicalTarget = request.season < Number(state.season) ||
      (request.season === Number(state.season) && request.week < state.week);
    const [league, initialRows, playerMatches] = await Promise.all([
      this.sleeper.getLeague(request.leagueId),
      this.nflverse.getPlayerWeeklyStats({
        playerName: request.playerName,
        season: analysisSeason,
        seasonType: 'REG',
        throughWeek,
      }).catch((error: unknown) => {
        throwIfRequestAborted();
        if (automaticCurrentSeason && error instanceof NflverseApiError && error.status === 404) return [];
        throw error;
      }),
      historicalTarget ? Promise.resolve([]) : this.sleeper.findPlayers(request.playerName, { active: true, limit: 10 }),
    ]);
    if (league.season !== String(request.season)) throw new ResearchDataError('The selected league season does not match the projected season.');
    let matchingRows = initialRows;
    if (
      matchingRows.length === 0 &&
      automaticCurrentSeason
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
    let rows = resolvePlayerRows(matchingRows, request.playerName);
    const latest = rows.at(-1);
    if (!latest) throw new ResearchDataError(`nflverse found no completed games for ${request.playerName}.`);
    if (!['QB', 'RB', 'WR', 'TE', 'K'].includes(latest.position.toUpperCase())) {
      throw new ResearchDataError('Seb projects QB, RB, WR, TE, and K scoring only. This position has no supported projection. Do not count it as zero.');
    }
    const player = historicalTarget ? null : resolveSleeperPlayer(playerMatches, latest.playerDisplayName, latest.position);
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
    if (PLAYER_SPECIAL_TEAMS_SETTINGS.some(k => Number(league.scoring_settings[k] ?? 0) !== 0)) {
      const data = await this.nflverse.getDefenseData(analysisSeason);
      try {
        rows = enrichSpecialTeams(rows, data);
        positionRows.splice(0, positionRows.length, ...enrichSpecialTeams(positionRows, data));
      } catch { throw new ResearchDataError('Special-teams data lacks a completed player game.'); }
    }
    if (schedule.length > 1) throw new ResearchDataError('The schedule contains multiple games for this team and week.');
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

    const { overrides, learned } = await this.learningContext(request, analysisSeason, throughWeek, latest.position, league.scoring_settings);
    throwIfRequestAborted();
    const parameters = overrides?.enabled === false ? undefined : overrides?.parameters ?? learned?.parameters;
    return projectPlayer({
      projectionSeason: request.season,
      scheduled: Boolean(game),
      kickoffKnown: !game || Boolean(easternKickoff(game.gameDate, game.gameTime)),
      currentProfileKnown: Boolean(player?.team && player.active !== false),
      gameStarted: Boolean(game && (easternKickoff(game.gameDate, game.gameTime)?.getTime() ?? Infinity) <= Date.now()),
      manualOverride: Boolean(overrides?.parameters) && overrides?.enabled !== false,
      priorMean: positionPrior(positionRows.filter((row) => row.season === analysisSeason && row.seasonType === 'REG' && row.week <= throughWeek), latest.position, latest.playerId, league.scoring_settings),
      ...(parameters ? { parameters } : {}),
      ...(learned && !overrides?.parameters ? {
        calibrationResiduals: learned.residuals[latest.position] ?? [],
        learningThroughWeek: learned.throughWeek,
        learningSeason: learned.season,
      } : {}),
      analysisSeason,
      currentTeam,
      injuryStatus: [player?.injury_status, player?.status].filter(Boolean).join(' ') || null,
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

  private async learningContext(
    request: PlayerProjectionRequest,
    analysisSeason: number,
    throughWeek: number,
    position: string,
    scoring: import('../sleeper/types.js').SleeperSettings,
  ) {
    try {
      const overrides = this.learning ? await this.learning.overrides() : null;
      // Existing learned parameters and calibration describe offensive players only.
      const learned = this.learning && overrides?.enabled !== false && position !== 'K'
        ? await this.learning.latest(analysisSeason, analysisSeason === request.season ? Math.min(request.week, throughWeek + 1) : throughWeek + 1, scoring) ??
          (analysisSeason === request.season ? await this.learning.latest(request.season - 1, 19, scoring) : null)
        : null;
      return { overrides, learned };
    } catch {
      throwIfRequestAborted();
      throw new ResearchDataError('Seb cannot read valid local forecast settings. Run /doctor to inspect the saved learning data, then retry.');
    }
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
    const names = [...new Set(groups.map((group) => group[0]?.playerDisplayName).filter(Boolean))];
    throw new ResearchDataError(
      names.length > 0
        ? `The player name is ambiguous. Use a full name. Matches: ${names.slice(0, 10).join(', ')}${names.length > 10 ? ', and more' : ''}.`
        : `nflverse found no completed games for ${requestedName}.`,
    );
  }
  return [...selected].sort((left, right) => left.week - right.week);
}

function resolveSleeperPlayer(
  players: readonly SleeperPlayer[],
  name: string,
  position: string,
): SleeperPlayer | null {
  const normalized = normalizeName(name);
  const matches = players.filter((player) => player.position?.toUpperCase() === position.toUpperCase() &&
    normalizeName(
      player.full_name ?? [player.first_name, player.last_name].filter(Boolean).join(' '),
    ) === normalized,
  );
  if (matches.length > 1) throw new ResearchDataError('The current player profile is ambiguous. Resolve a source identity first.');
  return matches[0] ?? null;
}

function normalizeName(value: string): string {
  return normalizePlayerName(value);
}

function normalizedPosition(value: string): 'QB' | 'RB' | 'WR' | 'TE' | 'K' {
  const normalized = value.toUpperCase();
  if (['QB', 'RB', 'WR', 'TE', 'K'].includes(normalized)) {
    return normalized as 'QB' | 'RB' | 'WR' | 'TE' | 'K';
  }
  throw new ResearchDataError(`Seb cannot project the ${value} position.`);
}
