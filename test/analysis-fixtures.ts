import type { NflverseGame, NflversePlayerWeek } from '../src/nflverse/types.js';
import type { SleeperLeague } from '../src/sleeper/types.js';
import { PPR_SCORING } from '../src/learning/engine.js';
export function stat(overrides: Partial<NflversePlayerWeek> = {}): NflversePlayerWeek {
  return { fumbles: 0, fumblesLost: 0, passingTwoPointConversions: 0, rushingTwoPointConversions: 0, receivingTwoPointConversions: 0, airYardsShare: null, attempts: 0, carries: 10, completions: 0, fantasyPoints: 10,
    fantasyPointsPpr: 10, gameId: 'g1', interceptions: 0, opponentTeam: 'MIA', passingTouchdowns: 0,
    passingYards: 0, playerDisplayName: 'Example Runner', playerId: 'p1', position: 'RB',
    receivingAirYards: 0, receivingTouchdowns: 0, receivingYards: 0, receptions: 0,
    rushingTouchdowns: 0, rushingYards: 100, season: 2025, seasonType: 'REG', targetShare: null,
    targets: 0, team: 'BUF', week: 1, ...overrides };
}
export function game(overrides: Partial<NflverseGame> = {}): NflverseGame {
  return { awayRest: 7, awayScore: 20, awayTeam: 'MIA', gameDate: '2025-09-07', gameId: 'g1',
    gameTime: '13:00', gameType: 'REG', homeRest: 7, homeScore: 24, homeTeam: 'BUF', location: 'Home',
    roof: 'outdoors', season: 2025, spreadLine: null, stadium: null, stadiumId: null, surface: null,
    temperature: null, totalLine: null, week: 1, wind: null, ...overrides };
}
export function league(overrides: Partial<SleeperLeague> = {}): SleeperLeague {
  return { league_id: '123456', name: 'Test league', roster_positions: ['RB', 'FLEX'],
    scoring_settings: PPR_SCORING, season: '2025', season_type: 'regular', settings: {}, sport: 'nfl',
    status: 'in_season', total_rosters: 2, ...overrides };
}
export function trainingRows(weeks = 12, players = 40): NflversePlayerWeek[] {
  return Array.from({ length: weeks }, (_, index) => Array.from({ length: players }, (_, player) =>
    stat({ week: index + 1, gameId: `g${index + 1}`, playerId: `p${player}`, playerDisplayName: `Runner ${player}`,
      rushingYards: 40 + index * 10 + player % 3, team: player % 2 ? 'BUF' : 'MIA' }))).flat();
}
