export type SleeperSettings = Record<string, number | string | boolean | null>;

export interface SleeperNflState {
  week: number;
  leg: number;
  season: string;
  season_type: string;
  season_start_date?: string | undefined;
  previous_season?: string | undefined;
  league_season?: string | undefined;
  league_create_season?: string | undefined;
  display_week?: number | undefined;
}

export interface SleeperPlayer {
  player_id: string;
  first_name?: string | null | undefined;
  last_name?: string | null | undefined;
  full_name?: string | null | undefined;
  search_full_name?: string | null | undefined;
  position?: string | null | undefined;
  fantasy_positions?: string[] | null | undefined;
  team?: string | null | undefined;
  active?: boolean | undefined;
  status?: string | null | undefined;
  injury_status?: string | null | undefined;
  injury_body_part?: string | null | undefined;
  injury_notes?: string | null | undefined;
  practice_participation?: string | null | undefined;
  depth_chart_position?: string | number | null | undefined;
  depth_chart_order?: number | null | undefined;
  number?: number | null | undefined;
  age?: number | null | undefined;
  years_exp?: number | null | undefined;
  search_rank?: number | null | undefined;
}

export type SleeperPlayerMap = Record<string, SleeperPlayer>;

export interface SleeperUser {
  user_id: string;
  username?: string | undefined;
  display_name?: string | undefined;
  avatar?: string | null | undefined;
  metadata?: Record<string, string | null> | null | undefined;
  is_owner?: boolean | undefined;
}

export interface SleeperLeague {
  league_id: string;
  name: string;
  season: string;
  season_type: string;
  sport: string;
  status: string;
  total_rosters: number;
  roster_positions: string[];
  scoring_settings: SleeperSettings;
  settings: SleeperSettings;
  previous_league_id?: string | null | undefined;
  draft_id?: string | null | undefined;
  avatar?: string | null | undefined;
}

export interface SleeperRoster {
  roster_id: number;
  league_id: string;
  owner_id?: string | null | undefined;
  co_owners?: string[] | null | undefined;
  players?: string[] | null | undefined;
  starters?: string[] | null | undefined;
  reserve?: string[] | null | undefined;
  taxi?: string[] | null | undefined;
  settings: Record<string, number | null>;
}

export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  custom_points?: number | null | undefined;
  players?: string[] | null | undefined;
  starters?: string[] | null | undefined;
  players_points?: Record<string, number> | null | undefined;
}

export interface SleeperTrendingPlayer {
  player_id: string;
  count: number;
}

export interface SleeperTransaction {
  transaction_id: string;
  type: string;
  status: string;
  leg: number;
  roster_ids: number[];
  created?: number | undefined;
  status_updated?: number | undefined;
  adds?: Record<string, number> | null | undefined;
  drops?: Record<string, number> | null | undefined;
  draft_picks?: unknown[] | undefined;
  waiver_budget?: unknown[] | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  settings?: Record<string, unknown> | null | undefined;
}

export interface ResolvedTrendingPlayer extends SleeperTrendingPlayer {
  player: SleeperPlayer | null;
}
