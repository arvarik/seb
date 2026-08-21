import { z } from 'zod';

import type {
  NwsAlert,
  NwsForecastPeriod,
  NwsHourlyForecast,
  NwsPointMetadata,
} from './types.js';

const nullableString = z.string().nullable();
const nullableNumber = z.number().finite().nullable();

export const nwsForecastPeriodSchema: z.ZodType<NwsForecastPeriod> = z.object({
  detailedForecast: z.string(),
  endTime: z.string().min(1),
  isDaytime: z.boolean(),
  precipitationProbability: nullableNumber,
  relativeHumidity: nullableNumber,
  shortForecast: z.string(),
  startTime: z.string().min(1),
  temperature: z.number().finite(),
  temperatureUnit: z.string().min(1),
  windDirection: z.string(),
  windSpeed: z.string(),
});

export const nwsHourlyForecastSchema: z.ZodType<NwsHourlyForecast> = z.object({
  generatedAt: nullableString,
  periods: z.array(nwsForecastPeriodSchema).min(1),
  sourceUrl: z.string().url(),
  timeZone: nullableString,
  updatedAt: nullableString,
});

export const nwsPointMetadataSchema: z.ZodType<NwsPointMetadata> = z.object({
  city: nullableString,
  forecastHourlyUrl: z.string().url(),
  gridId: z.string().min(1),
  gridX: z.number().finite(),
  gridY: z.number().finite(),
  state: nullableString,
  timeZone: nullableString,
});

export const nwsAlertSchema: z.ZodType<NwsAlert> = z.object({
  certainty: nullableString,
  description: nullableString,
  ends: nullableString,
  event: z.string().min(1),
  headline: nullableString,
  instruction: nullableString,
  onset: nullableString,
  severity: nullableString,
  urgency: nullableString,
});

export const nwsAlertListSchema = z.array(nwsAlertSchema);

const nullableSourceString = z.string().nullable().optional();
const nullableSourceNumber = z.number().finite().nullable();

export const nwsPointDocumentSchema = z.object({
  properties: z.object({
    forecastHourly: z.string().url(),
    gridId: z.string().min(1),
    gridX: z.number().finite(),
    gridY: z.number().finite(),
    timeZone: nullableSourceString,
    relativeLocation: z.object({
      properties: z.object({
        city: nullableSourceString,
        state: nullableSourceString,
      }).passthrough(),
    }).nullable().optional(),
  }).passthrough(),
}).passthrough();

export const nwsForecastDocumentSchema = z.object({
  properties: z.object({
    generatedAt: nullableSourceString,
    updated: nullableSourceString,
    periods: z.array(z.object({
      startTime: z.string().min(1),
      endTime: z.string().min(1),
      isDaytime: z.boolean(),
      temperature: z.number().finite(),
      temperatureUnit: z.string().min(1),
      probabilityOfPrecipitation: z.object({ value: nullableSourceNumber }).passthrough(),
      relativeHumidity: z.object({ value: nullableSourceNumber }).passthrough(),
      windSpeed: z.string(),
      windDirection: z.string(),
      shortForecast: z.string(),
      detailedForecast: z.string(),
    }).passthrough()).min(1),
  }).passthrough(),
}).passthrough();

export const nwsAlertsDocumentSchema = z.object({
  features: z.array(z.object({
    properties: z.object({
      event: z.string().min(1),
      severity: nullableSourceString,
      urgency: nullableSourceString,
      certainty: nullableSourceString,
      headline: nullableSourceString,
      description: nullableSourceString,
      instruction: nullableSourceString,
      onset: nullableSourceString,
      ends: nullableSourceString,
    }).passthrough(),
  }).passthrough()),
}).passthrough();
