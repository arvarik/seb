import { z } from 'zod';

import type {
  SleeperLeague,
  SleeperMatchup,
  SleeperNflState,
  SleeperPlayer,
  SleeperPlayerMap,
  SleeperRoster,
  SleeperTransaction,
  SleeperTrendingPlayer,
  SleeperUser,
} from './types.js';

const nullableString = z.string().nullable().optional();
const settingsSchema = z.record(
  z.string(),
  z.union([z.number(), z.string(), z.boolean(), z.null()]),
);
const numberRecordSchema = z.record(z.string(), z.number());
const unknownRecordSchema = z.record(z.string(), z.unknown());

export const sleeperNflStateSchema: z.ZodType<SleeperNflState> = z.object({
  week: z.number().int().min(0).max(30),
  leg: z.number().int().min(0).max(30),
  season: z.string().regex(/^\d{4}$/u),
  season_type: z.string().min(1),
  season_start_date: z.string().optional(),
  previous_season: z.string().optional(),
  league_season: z.string().optional(),
  league_create_season: z.string().optional(),
  display_week: z.number().int().min(0).max(30).optional(),
}).passthrough();

export const sleeperPlayerSchema: z.ZodType<SleeperPlayer> = z.object({
  player_id: z.string().min(1),
  first_name: nullableString,
  last_name: nullableString,
  full_name: nullableString,
  search_full_name: nullableString,
  position: nullableString,
  fantasy_positions: z.array(z.string()).nullable().optional(),
  team: nullableString,
  active: z.boolean().optional(),
  status: nullableString,
  injury_status: nullableString,
  injury_body_part: nullableString,
  injury_notes: nullableString,
  practice_participation: nullableString,
  depth_chart_position: z.union([z.string(), z.number(), z.null()]).optional(),
  depth_chart_order: z.number().nullable().optional(),
  number: z.number().nullable().optional(),
  age: z.number().nullable().optional(),
  years_exp: z.number().nullable().optional(),
  search_rank: z.number().nullable().optional(),
}).passthrough();

export const sleeperPlayerMapSchema: z.ZodType<SleeperPlayerMap> = z.record(
  z.string(),
  sleeperPlayerSchema,
);

export const sleeperUserSchema: z.ZodType<SleeperUser> = z.object({
  user_id: z.string().min(1),
  username: z.string().optional(),
  display_name: z.string().optional(),
  avatar: nullableString,
  metadata: z.record(z.string(), z.string().nullable()).nullable().optional(),
  is_owner: z.boolean().nullable().optional(),
}).passthrough();

export const sleeperLeagueSchema: z.ZodType<SleeperLeague> = z.object({
  league_id: z.string().min(1),
  name: z.string().min(1),
  season: z.string().min(1),
  season_type: z.string().min(1),
  sport: z.string().min(1),
  status: z.string().min(1),
  total_rosters: z.number().int().nonnegative(),
  roster_positions: z.array(z.string()),
  scoring_settings: settingsSchema,
  settings: settingsSchema,
  previous_league_id: nullableString,
  draft_id: nullableString,
  avatar: nullableString,
}).passthrough();

export const sleeperRosterSchema: z.ZodType<SleeperRoster> = z.object({
  roster_id: z.number().int().positive(),
  league_id: z.string().min(1),
  owner_id: nullableString,
  co_owners: z.array(z.string()).nullable().optional(),
  players: z.array(z.string()).nullable().optional(),
  starters: z.array(z.string()).nullable().optional(),
  reserve: z.array(z.string()).nullable().optional(),
  taxi: z.array(z.string()).nullable().optional(),
  settings: z.record(z.string(), z.number().nullable()),
}).passthrough();

export const sleeperMatchupSchema: z.ZodType<SleeperMatchup> = z.object({
  roster_id: z.number().int().positive(),
  matchup_id: z.number().int().nullable(),
  points: z.number(),
  custom_points: z.number().nullable().optional(),
  players: z.array(z.string()).nullable().optional(),
  starters: z.array(z.string()).nullable().optional(),
  players_points: numberRecordSchema.nullable().optional(),
}).passthrough();

export const sleeperTrendingPlayerSchema: z.ZodType<SleeperTrendingPlayer> = z.object({
  player_id: z.string().min(1),
  count: z.number().nonnegative(),
}).passthrough();

export const sleeperTransactionSchema: z.ZodType<SleeperTransaction> = z.object({
  transaction_id: z.string().min(1),
  type: z.string().min(1),
  status: z.string().min(1),
  leg: z.number().int().nonnegative(),
  roster_ids: z.array(z.number().int().positive()),
  created: z.number().optional(),
  status_updated: z.number().optional(),
  adds: numberRecordSchema.nullable().optional(),
  drops: numberRecordSchema.nullable().optional(),
  draft_picks: z.array(z.unknown()).optional(),
  waiver_budget: z.array(z.unknown()).optional(),
  metadata: unknownRecordSchema.nullable().optional(),
  settings: unknownRecordSchema.nullable().optional(),
}).passthrough();

export const sleeperLeagueListSchema = z.array(sleeperLeagueSchema);
export const sleeperUserListSchema = z.array(sleeperUserSchema);
export const sleeperRosterListSchema = z.array(sleeperRosterSchema);
export const sleeperMatchupListSchema = z.array(sleeperMatchupSchema);
export const sleeperTransactionListSchema = z.array(sleeperTransactionSchema);
export const sleeperTrendingPlayerListSchema = z.array(sleeperTrendingPlayerSchema);
