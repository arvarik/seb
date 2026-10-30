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
import type { SebDatabase } from '../data/sqlite-store.js';
import { createDirectProvenanceManifest } from '../provenance/direct.js';
import { GameWeatherService } from '../weather/game-weather.js';
import { WeatherClient } from '../weather/client.js';
import {
  projectPlayer,
  scorePlayerWeek,
  type ForecastDiff,
  type ScoringAwarePlayerProjection,
} from './player-projection.js';
import { DEFAULT_PROJECTION_PARAMETERS, rollingResiduals, type ProjectionParameters } from './statistics.js';

export type ProjectionSnapshotStore = Pick<SebDatabase, 'createSnapshot' | 'listSnapshots'>;

interface PlayerProjectionSnapshotPayload {
  adjustments: Array<{ factor: number; label: string; reason: string }>;
  analysisSeason: number;
  ceiling: number;
  expectedPoints: number;
  floor: number;
  games: number;
  injuryStatus: string | null;
  learningThroughWeek: number | null;
  modelVersion: string;
  opponent: string | null;
  playerName: string;
  position: string;
  team: string;
  throughWeek: number;
}

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
  private readonly projectFlights = new Map<string, Promise<ScoringAwarePlayerProjection>>();

  constructor(
    private readonly sleeper: SleeperClient,
    private readonly nflverse: NflverseClient,
    weather: WeatherClient,
    private readonly learning: LearningStore | false = new LearningStore(),
    private readonly snapshotDatabase: ProjectionSnapshotStore | false = false,
  ) {
    this.gameWeather = new GameWeatherService(nflverse, weather);
  }

  async project(request: PlayerProjectionRequest): Promise<ScoringAwarePlayerProjection> {
    throwIfRequestAborted();
    const team = this.teams.resolve(request.playerName.replace(/\s+(?:D\/ST|DST|DEF|defense)$/iu, ''));
    const subjectKey = team.status === 'resolved'
      ? `DEF:${team.identity.code}`
      : normalizeName(request.playerName);
    const flightKey = `${request.leagueId}:${request.season}:${request.week}:${request.analysisSeason ?? ''}:${request.throughWeek ?? ''}:${subjectKey}`;
    const existingFlight = this.projectFlights.get(flightKey);
    if (existingFlight) return existingFlight;
    const flight = this.computeProjection(request, team).finally(() => {
      this.projectFlights.delete(flightKey);
    });
    this.projectFlights.set(flightKey, flight);
    return flight;
  }

  private async computeProjection(
    request: PlayerProjectionRequest,
    team: ReturnType<TeamIdentityRegistry['resolve']>,
  ): Promise<ScoringAwarePlayerProjection> {
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
    const historicalTarget = request.season < Number(state.season) ||
      (request.season === Number(state.season) && request.week < state.week);
    const customBacktestWindow =
      (request.analysisSeason !== undefined && request.analysisSeason !== completed.analysisSeason) ||
      (request.throughWeek !== undefined && request.throughWeek !== completed.throughWeek);
    const skipSnapshot = historicalTarget || customBacktestWindow;
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
      const defenseProjection = projectDefense({ rows: data.weeks, team: code, name: `${team.identity.city} ${team.identity.name}`,
        opponent: game ? game.homeTeam === code ? game.awayTeam : game.homeTeam : null,
        analysisSeason, throughWeek, season: request.season, week: request.week,
        leagueId: league.league_id, leagueName: league.name, scoringSettings: league.scoring_settings,
        scheduled: Boolean(kickoff), gameStarted: Boolean(kickoff && kickoff.getTime() <= Date.now()) });
      return skipSnapshot ? defenseProjection : this.withForecastSnapshot(defenseProjection, null);
    }
    const automaticCurrentSeason = request.analysisSeason === undefined && request.throughWeek === undefined && analysisSeason === request.season;
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
    const injuryStatus = [player?.injury_status, player?.status].filter(Boolean).join(' ') || null;
    const computedProjection = projectPlayer({
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
      injuryStatus,
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
    return skipSnapshot ? computedProjection : this.withForecastSnapshot(computedProjection, injuryStatus);
  }

  private withForecastSnapshot(
    projection: ScoringAwarePlayerProjection,
    injuryStatus: string | null,
  ): ScoringAwarePlayerProjection {
    if (!this.snapshotDatabase) return projection;
    const entityKey = `${projection.league.leagueId}:${projection.season}:${projection.week}:${projection.player.playerId}`;
    const current: PlayerProjectionSnapshotPayload = {
      adjustments: projection.adjustments.map((adj) => ({
        factor: adj.factor,
        label: adj.label,
        reason: adj.reason,
      })),
      analysisSeason: projection.analysisSeason,
      ceiling: projection.ceiling,
      expectedPoints: projection.expectedPoints,
      floor: projection.floor,
      games: projection.games,
      injuryStatus,
      learningThroughWeek: projection.model.learningThroughWeek,
      modelVersion: projection.model.version,
      opponent: projection.opponent,
      playerName: projection.player.name,
      position: projection.player.position,
      team: projection.player.team,
      throughWeek: projection.throughWeek,
    };
    try {
      const existing = this.snapshotDatabase.listSnapshots<PlayerProjectionSnapshotPayload>({
        entityKey,
        kind: 'player-projection',
        limit: 2,
      });
      const latest = existing[0];
      const changed = !latest ||
        Math.abs(projection.expectedPoints - latest.payload.expectedPoints) >= 0.01 ||
        Math.abs(projection.floor - latest.payload.floor) >= 0.01 ||
        Math.abs(projection.ceiling - latest.payload.ceiling) >= 0.01 ||
        latest.payload.throughWeek !== current.throughWeek ||
        latest.payload.analysisSeason !== current.analysisSeason ||
        latest.payload.injuryStatus !== current.injuryStatus ||
        latest.payload.opponent !== current.opponent ||
        latest.payload.team !== current.team ||
        (latest.payload.learningThroughWeek ?? null) !== current.learningThroughWeek ||
        latest.payload.modelVersion !== current.modelVersion;
      if (changed) {
        const nowIso = new Date().toISOString();
        this.snapshotDatabase.createSnapshot({
          asOf: nowIso,
          entityKey,
          kind: 'player-projection',
          payload: current,
          provenance: createDirectProvenanceManifest(current, {
            envelopeId: `snapshot:player-projection:${entityKey}:${nowIso}`,
            now: nowIso,
            source: {
              freshnessPolicy: { freshForMs: 6 * 60 * 60 * 1_000 },
              id: `projection:${projection.model.version}`,
              label: `Seb player projection (${projection.model.version})`,
              provider: 'seb',
              retrievedAt: nowIso,
              version: projection.model.version,
            },
          }),
          schemaVersion: 'player-projection-v1',
        }, 16);
        return latest
          ? { ...projection, forecastDiff: computeForecastDiff(latest.asOf, latest.payload, current) }
          : projection;
      }
      const priorShift = existing[1];
      const forecastDiff: ForecastDiff = priorShift
        ? {
            ...computeForecastDiff(priorShift.asOf, priorShift.payload, current),
            unchangedSince: latest.asOf,
          }
        : {
            deltaCeiling: 0,
            deltaExpectedPoints: 0,
            deltaFloor: 0,
            drivers: ['Unchanged since previous forecast'],
            previousAsOf: latest.asOf,
            previousExpectedPoints: latest.payload.expectedPoints,
            unchangedSince: latest.asOf,
          };
      return { ...projection, forecastDiff };
    } catch {
      return projection;
    }
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

function computeForecastDiff(
  previousAsOf: string,
  prev: PlayerProjectionSnapshotPayload,
  curr: PlayerProjectionSnapshotPayload,
): ForecastDiff {
  const round2 = (value: number) => Math.round(value * 100) / 100;
  const deltaExpectedPoints = round2(curr.expectedPoints - prev.expectedPoints);
  const deltaFloor = round2(curr.floor - prev.floor);
  const deltaCeiling = round2(curr.ceiling - prev.ceiling);
  const drivers: string[] = [];
  if (prev.analysisSeason !== curr.analysisSeason || prev.throughWeek !== curr.throughWeek) {
    drivers.push(
      `Completed stats window advanced (${prev.analysisSeason} W${prev.throughWeek} -> ${curr.analysisSeason} W${curr.throughWeek})`,
    );
  } else if (prev.games !== curr.games) {
    drivers.push(`Sample size changed (${prev.games} -> ${curr.games} games)`);
  }
  if (prev.team !== curr.team) {
    drivers.push(`Team changed (${prev.team} -> ${curr.team})`);
  }
  if (prev.opponent !== curr.opponent) {
    drivers.push(
      `Scheduled opponent changed (${prev.opponent ?? 'none'} -> ${curr.opponent ?? 'none'})`,
    );
  }
  if ((prev.injuryStatus ?? null) !== (curr.injuryStatus ?? null)) {
    drivers.push(
      `Injury status changed (${prev.injuryStatus ?? 'healthy'} -> ${curr.injuryStatus ?? 'healthy'})`,
    );
  }
  if (
    (prev.learningThroughWeek ?? null) !== (curr.learningThroughWeek ?? null) ||
    prev.modelVersion !== curr.modelVersion
  ) {
    const prevCal = `${prev.modelVersion}${prev.learningThroughWeek ? `@W${prev.learningThroughWeek}` : ''}`;
    const currCal = `${curr.modelVersion}${curr.learningThroughWeek ? `@W${curr.learningThroughWeek}` : ''}`;
    drivers.push(`Forecast calibration updated (${prevCal} -> ${currCal})`);
  }
  const prevAdj = new Map(prev.adjustments.map((adj) => [adj.label, adj]));
  const currAdj = new Map(curr.adjustments.map((adj) => [adj.label, adj]));
  for (const label of new Set([...prevAdj.keys(), ...currAdj.keys()])) {
    const before = prevAdj.get(label);
    const after = currAdj.get(label);
    const beforeFactor = before?.factor ?? 1;
    const afterFactor = after?.factor ?? 1;
    if (Math.abs(afterFactor - beforeFactor) >= 0.005) {
      drivers.push(
        `${label} shifted (${(beforeFactor * 100).toFixed(1)}% -> ${(afterFactor * 100).toFixed(1)}%)`,
      );
    } else if (
      before &&
      after &&
      before.reason !== after.reason &&
      (Math.abs(beforeFactor - 1) >= 0.005 || Math.abs(afterFactor - 1) >= 0.005)
    ) {
      drivers.push(`${label} context updated (${after.reason})`);
    }
  }
  if (drivers.length === 0 && Math.abs(deltaExpectedPoints) >= 0.01) {
    drivers.push('League scoring or positional peer prior updated');
  }
  if (drivers.length === 0 && (Math.abs(deltaFloor) >= 0.01 || Math.abs(deltaCeiling) >= 0.01)) {
    drivers.push('Forecast uncertainty interval updated');
  }
  if (drivers.length === 0) {
    drivers.push('Unchanged since previous forecast');
  }
  return {
    deltaCeiling,
    deltaExpectedPoints,
    deltaFloor,
    drivers,
    previousAsOf,
    previousExpectedPoints: prev.expectedPoints,
  };
}
