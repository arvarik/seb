import { enrichSpecialTeams, PLAYER_SPECIAL_TEAMS_SETTINGS } from '../nflverse/defense.js';
import { projectDefense } from './defense.js';
import { ResearchDataError } from '../data/research-error.js';
import { easternKickoff } from '../time.js';
import { resolveCompletedAnalysisWindow } from '../analysis/window.js';
import { LearningStore } from '../learning/store.js';
import { scoringKey } from '../learning/engine.js';
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
  scorePlayerWeek,
  type ScoringAwarePlayerProjection,
} from './player-projection.js';
import { DEFAULT_PROJECTION_PARAMETERS, rollingResiduals, type ProjectionParameters } from './statistics.js';

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
  private readonly teams = new TeamIdentityRegistry();
  private readonly priorCache = new Map<string, { sum: number; count: number; byPlayer: Map<string, { sum: number; count: number }> }>();
  private readonly residualCache = new Map<string, number[]>();
  private readonly learningFlights = new Map<string, Promise<{ overrides: Awaited<ReturnType<LearningStore['overrides']>> | null; learned: Awaited<ReturnType<LearningStore['latest']>> | null }>>();

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
    const team = this.teams.resolve(request.playerName.replace(/\s+(?:D\/ST|DST|DEF|defense)$/iu, ''));
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
    const hasSpecialTeams = PLAYER_SPECIAL_TEAMS_SETTINGS.some(k => Number(league.scoring_settings[k] ?? 0) !== 0);

    const [schedule, positionRows, defenseData, { overrides, learned }] = await Promise.all([
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
      hasSpecialTeams ? this.nflverse.getDefenseData(analysisSeason) : Promise.resolve(null),
      this.learningContext(request, analysisSeason, throughWeek, latest.position, league.scoring_settings),
    ]);
    if (defenseData) {
      try {
        rows = enrichSpecialTeams(rows, defenseData);
        positionRows.splice(0, positionRows.length, ...enrichSpecialTeams(positionRows, defenseData));
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
    throwIfRequestAborted();
    const parameters = overrides?.enabled === false ? undefined : overrides?.parameters ?? learned?.parameters;
    const eligiblePositionRows = positionRows.filter(
      (row) => row.season === analysisSeason && row.seasonType === 'REG' && row.week <= throughWeek,
    );
    const learnedResiduals = learned && !overrides?.parameters
      ? (learned.residuals[latest.position] ?? learned.residuals[latest.position.toUpperCase()])
      : undefined;
    const priorMean = this.cachedPositionPrior(
      eligiblePositionRows,
      analysisSeason,
      throughWeek,
      latest.position,
      latest.playerId,
      league.scoring_settings,
    );
    const pooledResiduals = !learnedResiduals || learnedResiduals.length < 20
      ? this.cachedPooledResiduals(eligiblePositionRows, analysisSeason, throughWeek, latest.position, league.scoring_settings, parameters)
      : undefined;
    const calibrationResiduals = learnedResiduals && learnedResiduals.length >= 20
      ? learnedResiduals
      : pooledResiduals && pooledResiduals.length >= 20
        ? pooledResiduals
        : learnedResiduals;
    return projectPlayer({
      projectionSeason: request.season,
      scheduled: Boolean(game),
      kickoffKnown: !game || Boolean(easternKickoff(game.gameDate, game.gameTime)),
      currentProfileKnown: Boolean(player?.team && player.active !== false),
      gameStarted: Boolean(game && (easternKickoff(game.gameDate, game.gameTime)?.getTime() ?? Infinity) <= Date.now()),
      manualOverride: Boolean(overrides?.parameters) && overrides?.enabled !== false,
      priorMean,
      ...(parameters ? { parameters } : {}),
      ...(calibrationResiduals ? { calibrationResiduals } : {}),
      ...(learned && !overrides?.parameters ? {
        learningThroughWeek: learned.throughWeek,
        learningSeason: learned.season,
      } : {}),
      ...(player?.fantasy_positions?.length ? { fantasyPositions: player.fantasy_positions } : {}),
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

  private cachedPositionPrior(
    rows: readonly NflversePlayerWeek[],
    analysisSeason: number,
    throughWeek: number,
    position: string,
    playerId: string,
    scoring: import('../sleeper/types.js').SleeperSettings,
  ): number | null {
    if (rows.length < 20) return null;
    const normalizedPos = position.toUpperCase();
    const key = `${analysisSeason}:${throughWeek}:${normalizedPos}:${scoringKey(scoring)}:${rows.length}`;
    let entry = this.priorCache.get(key);
    if (!entry) {
      let sum = 0;
      let count = 0;
      const byPlayer = new Map<string, { sum: number; count: number }>();
      for (const row of rows) {
        if (row.position.toUpperCase() !== normalizedPos) continue;
        const score = scorePlayerWeek(row, scoring);
        sum += score;
        count += 1;
        const p = byPlayer.get(row.playerId) ?? { sum: 0, count: 0 };
        p.sum += score;
        p.count += 1;
        byPlayer.set(row.playerId, p);
      }
      entry = { sum, count, byPlayer };
      this.priorCache.set(key, entry);
    }
    const p = entry.byPlayer.get(playerId);
    const peerCount = entry.count - (p?.count ?? 0);
    return peerCount >= 20 ? (entry.sum - (p?.sum ?? 0)) / peerCount : null;
  }

  private cachedPooledResiduals(
    rows: readonly NflversePlayerWeek[],
    analysisSeason: number,
    throughWeek: number,
    position: string,
    scoring: import('../sleeper/types.js').SleeperSettings,
    parameters: ProjectionParameters = DEFAULT_PROJECTION_PARAMETERS,
  ): number[] {
    const key = `${analysisSeason}:${throughWeek}:${position.toUpperCase()}:${scoringKey(scoring)}:${rows.length}:${JSON.stringify(parameters)}`;
    let residuals = this.residualCache.get(key);
    if (!residuals) {
      const positionPriorMean = this.cachedPositionPrior(rows, analysisSeason, throughWeek, position, '', scoring);
      residuals = pooledPositionResiduals(rows, scoring, parameters, positionPriorMean);
      this.residualCache.set(key, residuals);
    }
    return residuals;
  }

  private async learningContext(
    request: PlayerProjectionRequest,
    analysisSeason: number,
    throughWeek: number,
    position: string,
    scoring: import('../sleeper/types.js').SleeperSettings,
  ) {
    const isKicker = position.toUpperCase() === 'K';
    const targetWeek = analysisSeason === request.season ? Math.min(request.week, throughWeek + 1) : throughWeek + 1;
    const key = `${analysisSeason}:${targetWeek}:${request.season}:${isKicker ? 'K' : 'OFF'}:${scoringKey(scoring)}`;
    const existing = this.learningFlights.get(key);
    if (existing) return existing;
    const flight = (async () => {
      try {
        const overrides = this.learning ? await this.learning.overrides() : null;
        // Existing learned parameters and calibration describe offensive players only.
        const learned = this.learning && overrides?.enabled !== false && !isKicker
          ? await this.learning.latest(analysisSeason, targetWeek, scoring) ??
            (analysisSeason === request.season ? await this.learning.latest(request.season - 1, 19, scoring) : null)
          : null;
        return { overrides, learned };
      } catch {
        throwIfRequestAborted();
        throw new ResearchDataError('Seb cannot read valid local forecast settings. Run /doctor to inspect the saved learning data, then retry.');
      } finally {
        this.learningFlights.delete(key);
      }
    })();
    this.learningFlights.set(key, flight);
    return flight;
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
  let matches = players.filter((player) => player.position?.toUpperCase() === position.toUpperCase() &&
    normalizeName(
      player.full_name ?? [player.first_name, player.last_name].filter(Boolean).join(' '),
    ) === normalized,
  );
  if (matches.length > 1) {
    const activeRostered = matches.filter((player) => player.active !== false && Boolean(player.team));
    if (activeRostered.length === 1) matches = activeRostered;
  }
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

function pooledPositionResiduals(
  rows: readonly NflversePlayerWeek[],
  scoring: import('../sleeper/types.js').SleeperSettings,
  parameters: ProjectionParameters = DEFAULT_PROJECTION_PARAMETERS,
  priorMean: number | null = null,
): number[] {
  const byPlayer = new Map<string, NflversePlayerWeek[]>();
  for (const row of rows) {
    const group = byPlayer.get(row.playerId) ?? [];
    group.push(row);
    byPlayer.set(row.playerId, group);
  }
  const residuals: number[] = [];
  for (const group of byPlayer.values()) {
    if (group.length < 4) continue;
    const ordered = [...group].sort((a, b) => a.week - b.week);
    if (new Set(ordered.map((r) => r.week)).size !== ordered.length) continue;
    try {
      const scores = ordered.map((row) => scorePlayerWeek(row, scoring));
      for (const residual of rollingResiduals(scores, parameters, priorMean)) {
        residuals.push(residual);
        if (residuals.length >= 200) return residuals;
      }
    } catch {
      continue;
    }
  }
  return residuals;
}
