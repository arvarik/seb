import { z } from 'zod';

import type { NflverseGame, NflversePlayerWeek } from './types.js';

const nullableNumber = z.number().finite().nullable();
const nullableString = z.string().nullable();

export const nflverseGameSchema: z.ZodType<NflverseGame> = z.object({
  awayRest: nullableNumber,
  awayScore: nullableNumber,
  awayTeam: z.string().min(1),
  gameDate: z.string().min(1),
  gameId: z.string().min(1),
  gameTime: nullableString,
  gameType: z.string().min(1),
  homeRest: nullableNumber,
  homeScore: nullableNumber,
  homeTeam: z.string().min(1),
  location: nullableString,
  roof: nullableString,
  season: z.number().int().min(1999).max(2100),
  spreadLine: nullableNumber,
  stadium: nullableString,
  stadiumId: nullableString,
  surface: nullableString,
  temperature: nullableNumber,
  totalLine: nullableNumber,
  week: z.number().int().min(1).max(30),
  wind: nullableNumber,
});

export const nflversePlayerWeekSchema: z.ZodType<NflversePlayerWeek> = z.object({
  airYardsShare: nullableNumber,
  attempts: z.number().finite(),
  carries: z.number().finite(),
  completions: z.number().finite(),
  fantasyPoints: z.number().finite(),
  fantasyPointsPpr: z.number().finite(),
  gameId: z.string().min(1),
  interceptions: z.number().finite(),
  opponentTeam: z.string().min(1),
  passingTouchdowns: z.number().finite(),
  passingYards: z.number().finite(),
  playerDisplayName: z.string().min(1),
  playerId: z.string().min(1),
  position: z.string().min(1),
  receivingAirYards: z.number().finite(),
  receivingTouchdowns: z.number().finite(),
  receivingYards: z.number().finite(),
  receptions: z.number().finite(),
  rushingTouchdowns: z.number().finite(),
  rushingYards: z.number().finite(),
  season: z.number().int().min(1999).max(2100),
  seasonType: z.string().min(1),
  targetShare: nullableNumber,
  targets: z.number().finite(),
  team: z.string().min(1),
  week: z.number().int().min(1).max(30),
});

export const nflverseScheduleSchema = z.array(nflverseGameSchema).min(1);
export const nflversePlayerStatsSchema = z.array(nflversePlayerWeekSchema).min(1);
