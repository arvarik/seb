import { easternKickoff } from '../time.js';
import { NflverseClient } from '../nflverse/client.js';
import type { NflverseGame } from '../nflverse/types.js';
import { WeatherClient } from './client.js';
import { findHomeStadium } from './stadiums.js';
import type { NwsAlert, NwsForecastPeriod } from './types.js';

export type WeatherRisk = 'low' | 'medium' | 'high';
export type WeatherGameType = 'POST' | 'PRE' | 'REG';

export class GameScheduleNotFoundError extends Error {
  constructor(season: number, week: number, team: string) {
    super(
      `nflverse has no game for ${team.toUpperCase()} in ${season} Week ${week}.`,
    );
    this.name = 'GameScheduleNotFoundError';
  }
}

export interface GameWeatherResult {
  alerts: NwsAlert[];
  fantasyImpact: string[];
  forecast: NwsForecastPeriod | null;
  game: NflverseGame;
  kickoffAt: string | null;
  reason: string | null;
  risk: WeatherRisk | null;
  stadium: {
    latitude: number;
    longitude: number;
    name: string;
  } | null;
  status: 'available' | 'historical' | 'indoor' | 'unavailable';
}

export class GameWeatherService {
  constructor(
    private readonly nflverse: NflverseClient,
    private readonly weather: WeatherClient,
  ) {}

  async getGameWeather(input: {
    gameType?: WeatherGameType | undefined;
    season: number;
    team: string;
    week: number;
  }): Promise<GameWeatherResult> {
    const games = await this.nflverse.getSchedule({
      season: input.season,
      team: input.team,
      week: input.week,
      gameType: resolveWeatherGameType(input.week, input.gameType),
    });
    const game = games[0];
    if (!game) {
      throw new GameScheduleNotFoundError(input.season, input.week, input.team);
    }
    return this.getScheduledGameWeather(game);
  }

  async getScheduledGameWeather(game: NflverseGame): Promise<GameWeatherResult> {
    const kickoff = easternKickoff(game.gameDate, game.gameTime);
    if (isIndoor(game.roof)) {
      return baseResult(game, kickoff, {
        status: 'indoor',
        reason: `The nflverse roof value is ${game.roof ?? 'indoor'}. Outdoor weather has no direct game-field effect.`,
      });
    }

    if (kickoff && kickoff.getTime() < Date.now() - 60 * 60 * 1_000) {
      return {
        ...baseResult(game, kickoff, {
          status: 'historical',
          reason: 'The kickoff is in the past. nflverse supplies recorded temperature and wind when available.',
        }),
        fantasyImpact: historicalImpact(game),
        risk: historicalRisk(game),
      };
    }

    if (game.location && game.location.toLowerCase() !== 'home') {
      return baseResult(game, kickoff, {
        status: 'unavailable',
        reason: 'This game uses a neutral venue. Seb does not apply the home-stadium coordinate.',
      });
    }

    const stadium = findHomeStadium(game.homeTeam);
    if (!stadium) {
      return baseResult(game, kickoff, {
        status: 'unavailable',
        reason: 'Seb has no United States stadium coordinate for this venue.',
      });
    }
    if (!kickoff) {
      return {
        ...baseResult(game, kickoff, {
          status: 'unavailable',
          reason: 'nflverse has no valid kickoff time for this game.',
        }),
        stadium: compactStadium(stadium),
      };
    }
    if (kickoff.getTime() > Date.now() + 8 * 24 * 60 * 60 * 1_000) {
      return {
        ...baseResult(game, kickoff, {
          status: 'unavailable',
          reason: 'The kickoff falls outside the National Weather Service hourly forecast window.',
        }),
        stadium: compactStadium(stadium),
      };
    }

    const [forecast, alerts] = await Promise.all([
      this.weather.getHourlyForecast(stadium.latitude, stadium.longitude),
      this.weather.getActiveAlerts(stadium.latitude, stadium.longitude),
    ]);
    const period = selectPeriod(forecast.periods, kickoff);
    if (!period) {
      return {
        ...baseResult(game, kickoff, {
          status: 'unavailable',
          reason: 'The kickoff falls outside the National Weather Service hourly forecast window.',
        }),
        alerts,
        stadium: compactStadium(stadium),
      };
    }

    const kickoffAlerts = alerts.filter((alert) => {
      const onset = Date.parse(alert.onset ?? '');
      const ends = Date.parse(alert.ends ?? '');
      return onset <= kickoff.getTime() && kickoff.getTime() < ends;
    });
    const assessment = assessWeather(period, kickoffAlerts);
    if (alerts.length > kickoffAlerts.length) {
      assessment.impacts.push('Some current alerts have no verified time window that includes kickoff. They do not change the kickoff risk rating.');
    }
    return {
      alerts,
      fantasyImpact: assessment.impacts,
      forecast: period,
      game,
      kickoffAt: kickoff.toISOString(),
      reason: null,
      risk: assessment.risk,
      stadium: compactStadium(stadium),
      status: 'available',
    };
  }
}

export function resolveWeatherGameType(
  week: number,
  gameType?: WeatherGameType,
): WeatherGameType {
  return gameType ?? (week <= 18 ? 'REG' : 'POST');
}

function baseResult(
  game: NflverseGame,
  kickoff: Date | null,
  state: Pick<GameWeatherResult, 'reason' | 'status'>,
): GameWeatherResult {
  return {
    alerts: [],
    fantasyImpact: [],
    forecast: null,
    game,
    kickoffAt: kickoff?.toISOString() ?? null,
    reason: state.reason,
    risk: null,
    stadium: null,
    status: state.status,
  };
}

function selectPeriod(
  periods: readonly NwsForecastPeriod[],
  kickoff: Date,
): NwsForecastPeriod | null {
  const exact = periods.find((period) => {
    const start = Date.parse(period.startTime);
    const end = Date.parse(period.endTime);
    return start <= kickoff.getTime() && kickoff.getTime() < end;
  });
  if (exact) {
    return exact;
  }
  return null;
}

function assessWeather(
  period: NwsForecastPeriod,
  alerts: readonly NwsAlert[],
): { impacts: string[]; risk: WeatherRisk } {
  const wind = maximumWind(period.windSpeed);
  const precipitation = period.precipitationProbability ?? 0;
  const temperature =
    period.temperatureUnit.toUpperCase() === 'F' ? period.temperature : null;
  const severeAlert = alerts.some((alert) =>
    ['extreme', 'severe'].includes(alert.severity?.toLowerCase() ?? ''),
  );
  const impacts: string[] = [];

  if (wind >= 20) {
    impacts.push('Strong wind can reduce deep-passing and long-kick efficiency.');
  } else if (wind >= 15) {
    impacts.push('Moderate wind can add variance to deep passes and kicks.');
  }
  if (precipitation >= 60) {
    impacts.push('Likely precipitation can reduce passing efficiency and increase ball-security risk.');
  } else if (precipitation >= 35) {
    impacts.push('Possible precipitation adds uncertainty to passing and kicking.');
  }
  if (temperature !== null && temperature <= 25) {
    impacts.push('Very cold conditions can reduce overall offensive efficiency.');
  } else if (temperature !== null && temperature >= 95) {
    impacts.push('Very hot conditions can increase fatigue risk.');
  }
  if (severeAlert) {
    impacts.push('A severe or extreme weather alert can affect game operations.');
  }
  if (impacts.length === 0) {
    impacts.push('The forecast shows no major weather penalty for fantasy analysis.');
  }

  const high = severeAlert || wind >= 25 || precipitation >= 75 || (temperature !== null && temperature <= 15);
  const medium = wind >= 15 || precipitation >= 35 || (temperature !== null && (temperature <= 30 || temperature >= 95));
  return { impacts, risk: high ? 'high' : medium ? 'medium' : 'low' };
}

function historicalRisk(game: NflverseGame): WeatherRisk | null {
  if (game.wind === null && game.temperature === null) {
    return null;
  }
  if ((game.wind ?? 0) >= 25 || (game.temperature ?? 100) <= 15) {
    return 'high';
  }
  if ((game.wind ?? 0) >= 15 || (game.temperature ?? 100) <= 30) {
    return 'medium';
  }
  return 'low';
}

function historicalImpact(game: NflverseGame): string[] {
  const impacts: string[] = [];
  if ((game.wind ?? 0) >= 15) {
    impacts.push('The recorded wind added risk to deep passes and kicks.');
  }
  if ((game.temperature ?? 100) <= 30) {
    impacts.push('The recorded temperature created cold-game conditions.');
  }
  return impacts;
}

function maximumWind(value: string): number {
  const values = value.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  return Math.max(0, ...values);
}

function isIndoor(roof: string | null): boolean {
  const normalized = roof?.toLowerCase() ?? '';
  return normalized.includes('dome') || normalized.includes('closed');
}

function compactStadium(stadium: {
  latitude: number;
  longitude: number;
  name: string;
}) {
  return {
    name: stadium.name,
    latitude: stadium.latitude,
    longitude: stadium.longitude,
  };
}
