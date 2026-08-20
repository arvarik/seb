export interface NwsAlert {
  certainty: string | null;
  description: string | null;
  ends: string | null;
  event: string;
  headline: string | null;
  instruction: string | null;
  onset: string | null;
  severity: string | null;
  urgency: string | null;
}

export interface NwsForecastPeriod {
  detailedForecast: string;
  endTime: string;
  isDaytime: boolean;
  precipitationProbability: number | null;
  relativeHumidity: number | null;
  shortForecast: string;
  startTime: string;
  temperature: number;
  temperatureUnit: string;
  windDirection: string;
  windSpeed: string;
}

export interface NwsHourlyForecast {
  generatedAt: string | null;
  periods: NwsForecastPeriod[];
  sourceUrl: string;
  timeZone: string | null;
  updatedAt: string | null;
}

export interface NwsPointMetadata {
  city: string | null;
  forecastHourlyUrl: string;
  gridId: string;
  gridX: number;
  gridY: number;
  state: string | null;
  timeZone: string | null;
}
