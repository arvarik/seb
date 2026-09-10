export type NflverseGameType = 'PRE' | 'REG' | 'POST' | string;

export interface NflverseGame {
  awayRest: number | null;
  awayScore: number | null;
  awayTeam: string;
  gameDate: string;
  gameId: string;
  gameTime: string | null;
  gameType: NflverseGameType;
  homeRest: number | null;
  homeScore: number | null;
  homeTeam: string;
  location: string | null;
  roof: string | null;
  season: number;
  spreadLine: number | null;
  stadium: string | null;
  stadiumId: string | null;
  surface: string | null;
  temperature: number | null;
  totalLine: number | null;
  week: number;
  wind: number | null;
}

export interface NflversePlayerWeek {
  kicking?: {
    fieldGoalsMade: number | null;
    fieldGoalsAttempted: number | null;
    extraPointsMade: number | null;
    extraPointsAttempted: number | null;
    madeDistances: number[] | null;
    missedDistances: number[] | null;
  } | undefined;
  specialTeamsForcedFumbles?: number | null | undefined;
  specialTeamsRecoveries?: number | null | undefined;
  specialTeamsTackles?: number | null | undefined;
  kickReturnYards?: number | null | undefined;
  puntReturnYards?: number | null | undefined;
  specialTeamsTouchdowns?: number | null | undefined;
  fumbleRecoveryTouchdowns?: number | null | undefined;

  fumbles?: number | null | undefined;
  fumblesLost?: number | null | undefined;
  passingTwoPointConversions?: number | null | undefined;
  rushingTwoPointConversions?: number | null | undefined;
  receivingTwoPointConversions?: number | null | undefined;

  airYardsShare: number | null;
  attempts: number;
  carries: number;
  completions: number;
  fantasyPoints: number;
  fantasyPointsPpr: number;
  gameId: string;
  interceptions: number;
  opponentTeam: string;
  passingTouchdowns: number;
  passingYards: number;
  playerDisplayName: string;
  playerId: string;
  position: string;
  receivingAirYards: number;
  receivingTouchdowns: number;
  receivingYards: number;
  receptions: number;
  rushingTouchdowns: number;
  rushingYards: number;
  season: number;
  seasonType: string;
  targetShare: number | null;
  targets: number;
  team: string;
  week: number;
}

export interface NflverseScheduleFilters {
  gameType?: string;
  season?: number;
  team?: string;
  week?: number;
}

export interface NflversePlayerStatFilters {
  playerId?: string;
  playerName?: string;
  position?: string;
  season: number;
  seasonType?: string;
  team?: string;
  throughWeek?: number;
  week?: number;
}

export interface PlayerTrendSummary {
  airYardsShare: number | null;
  averagePprPoints: number;
  averageTargets: number;
  averageTouches: number;
  games: number;
  latestWeek: number;
  playerDisplayName: string;
  playerId: string;
  position: string;
  recentAveragePprPoints: number;
  recentAverageTargets: number;
  recentAverageTouches: number;
  targetShare: number | null;
  team: string;
  totalPprPoints: number;
  volatility: number;
}

export interface TeamPerformanceSummary {
  averagePointsAllowed: number;
  averagePointsScored: number;
  games: number;
  losses: number;
  passingTouchdowns: number;
  passingYards: number;
  receivingTouchdowns: number;
  receivingYards: number;
  rushingTouchdowns: number;
  rushingYards: number;
  team: string;
  ties: number;
  wins: number;
}
