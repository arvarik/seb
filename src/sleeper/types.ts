export type SleeperSettings = Record<string, number | string | boolean | null>;

export interface SleeperNflState {
  week: number;
  leg: number;
  season: string;
  season_type: string;
  season_start_date?: string;
  previous_season?: string;
  league_season?: string;
  league_create_season?: string;
  display_week?: number;
}

export interface SleeperPlayer {
  player_id: string;
  first_name?: string | null;
  last_name?: string | null;
  full_name?: string | null;
  search_full_name?: string | null;
  position?: string | null;
  fantasy_positions?: string[] | null;
  team?: string | null;
  active?: boolean;
  status?: string | null;
  injury_status?: string | null;
  injury_body_part?: string | null;
  injury_notes?: string | null;
  practice_participation?: string | null;
  depth_chart_position?: string | number | null;
  depth_chart_order?: number | null;
  number?: number | null;
  age?: number | null;
  years_exp?: number | null;
  search_rank?: number | null;
}

export type SleeperPlayerMap = Record<string, SleeperPlayer>;

export interface SleeperUser {
  user_id: string;
  username?: string;
  display_name?: string;
  avatar?: string | null;
  metadata?: Record<string, string | null> | null;
  is_owner?: boolean;
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
  previous_league_id?: string | null;
  draft_id?: string | null;
  avatar?: string | null;
}

export interface SleeperRoster {
  roster_id: number;
  league_id: string;
  owner_id?: string | null;
  co_owners?: string[] | null;
  players?: string[] | null;
  starters?: string[] | null;
  reserve?: string[] | null;
  taxi?: string[] | null;
  settings: Record<string, number | null>;
}

export interface SleeperMatchup {
  roster_id: number;
  matchup_id: number | null;
  points: number;
  custom_points?: number | null;
  players?: string[] | null;
  starters?: string[] | null;
  players_points?: Record<string, number> | null;
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
  created?: number;
  status_updated?: number;
  adds?: Record<string, number> | null;
  drops?: Record<string, number> | null;
  draft_picks?: unknown[];
  waiver_budget?: unknown[];
  metadata?: Record<string, unknown> | null;
  settings?: Record<string, unknown> | null;
}

export interface ResolvedTrendingPlayer extends SleeperTrendingPlayer {
  player: SleeperPlayer | null;
}
