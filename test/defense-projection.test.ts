import { gzipSync } from 'node:zlib';
import { NflverseClient as LiveClient } from '../src/nflverse/client.js';
import { runWithRequestSignal } from '../src/ai/request-signal.js';
import { describe, expect, it, vi } from 'vitest';
import { aggregateDefense, DEFENSE_COLUMNS, enrichSpecialTeams, reconcileDefense, type DefenseWeek } from '../src/nflverse/defense.js';
import { inspectDefenseScoring, projectDefense, scoreDefenseWeek } from '../src/projection/defense.js';
import { PlayerProjectionService } from '../src/projection/service.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type { NflverseClient } from '../src/nflverse/client.js';
import type { WeatherClient } from '../src/weather/client.js';
import { NflverseApiError } from '../src/nflverse/client.js';
import { game, league, stat } from './analysis-fixtures.js';
import { scorePlayerWeek } from '../src/projection/player-projection.js';

function play(id: number, values: Record<string, string> = {}) {
  return { ...Object.fromEntries([...DEFENSE_COLUMNS].map(k => [k, ''])), game_id: 'g', play_id: String(id), season: '2025', week: '1', season_type: 'REG', home_team: 'BUF', away_team: 'MIA', posteam: 'BUF', defteam: 'MIA', play_type: 'run', special: '0', ...values };
}
const end = (id = 99) => play(id, { play_type_nfl: 'END_GAME', home_score: '7', away_score: '20', play_type: '' });
function week(team: string, week: number, stats: Record<string, number> = {}): DefenseWeek {
  return { team, week, season: 2025, gameId: `${team}-${week}`, opponent: team === 'BUF' ? 'MIA' : 'BUF', stats: { pts_allow: 20, yds_allow: 300, sack: 2, int: 1, def_td: 0, def_st_td: 0, ...stats } };
}
const settings = { sack: 1, int: 2, def_td: 6, def_st_td: 6, pts_allow_14_20: 1, pts_allow_35p: -4 };
const input = { rows: [week('BUF', 1), week('BUF', 2), week('MIA', 1)], team: 'BUF', name: 'Buffalo Bills', opponent: 'MIA', analysisSeason: 2025, throughWeek: 18, season: 2026, week: 1, leagueId: '123', leagueName: 'Test', scoringSettings: settings, scheduled: true, gameStarted: false };

describe('defense and special-teams data', () => {
  it('shares concurrent compressed source loads and records both sources', async () => {
    const base = { game_id: 'g', season_type: 'REG', sacks_suffered: '3', def_interceptions: '1', def_qb_hits: '8', def_tackles_for_loss: '7', passing_yards: '200', rushing_yards: '100', sack_yards_lost: '-20', kickoff_return_yards: '80', punt_return_yards: '10', def_punt_blocks: '0', def_fg_blocks: '1', def_pat_blocks: '0', def_safeties: '0', def_2pt_made: '0' };
    const csv = (rows: Record<string, string>[]) => { const keys = Object.keys(rows[0]!); return [keys.join(','), ...rows.map(r => keys.map(k => r[k]).join(','))].join('\n'); };
    const onSource = vi.fn();
    const fetch = vi.fn(async (url: unknown) => new Response(gzipSync(csv(String(url).includes('/pbp/') ? [end()] : [{ ...base, team: 'BUF' }, { ...base, team: 'MIA' }]))));
    const client = new LiveClient({ database: false, fetch, onSource });
    const [first, second] = await Promise.all([client.getDefenseData(2025), client.getDefenseData(2025)]);
    expect(first).toEqual(second); expect(first.weeks).toHaveLength(2); expect(fetch).toHaveBeenCalledTimes(2);
    expect(new Set(onSource.mock.calls.map(([source]) => source.id)).size).toBe(2);
    const controller = new AbortController(); controller.abort();
    expect(() => runWithRequestSignal(controller.signal, () => client.getDefenseData(2025))).toThrow();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('excludes a pick six from points allowed but retains its extra point', () => {
    const data = aggregateDefense([play(1, { touchdown: '1', td_team: 'MIA', interception: '1' }), end()], 2025);
    expect(data.weeks.find(w => w.team === 'BUF')!.stats.pts_allow).toBe(14);
    expect(data.weeks.find(w => w.team === 'MIA')!.stats).toMatchObject({ int: 1, def_td: 1, def_st_td: 0 });
  });
  it('counts return touchdowns against points allowed and credits only team special teams', () => {
    const data = aggregateDefense([play(1, { special: '1', play_type: 'punt', touchdown: '1', td_team: 'MIA' }), end()], 2025);
    expect(data.weeks.find(w => w.team === 'BUF')!.stats.pts_allow).toBe(20);
    expect(data.weeks.find(w => w.team === 'MIA')!.stats).toMatchObject({ def_td: 0, def_st_td: 1 });
  });
  it('separates defensive, special-teams, and individual fumbles without crediting own recoveries', () => {
    const rows = [play(1, { special: '1', play_type: 'kickoff', forced_fumble_player_1_team: 'MIA', forced_fumble_player_1_player_id: 'p', fumbled_1_team: 'BUF', fumble_recovery_1_team: 'MIA', fumble_recovery_1_player_id: 'p' }),
      play(2, { special: '1', fumbled_1_team: 'MIA', fumble_recovery_1_team: 'MIA', fumble_recovery_1_player_id: 'p' }), end()];
    const data = aggregateDefense(rows, 2025);
    expect(data.weeks.find(w => w.team === 'MIA')!.stats).toMatchObject({ ff: 0, fum_rec: 0, def_st_ff: 1, def_st_fum_rec: 1 });
    expect(data.specialTeams['g:p']).toMatchObject({ ff: 1, recoveries: 1 });
    const [player] = enrichSpecialTeams([stat({ gameId: 'g', playerId: 'p' })], data);
    expect(scorePlayerWeek(player!, { st_ff: 1, st_fum_rec: 2, def_st_ff: 99 })).toBe(3);
  });
  it('retains verified zeroes and refuses uncovered games', () => {
    const data = aggregateDefense([end()], 2025);
    expect(enrichSpecialTeams([stat({ gameId: 'g' })], data)[0]!.specialTeamsForcedFumbles).toBe(0);
    expect(() => enrichSpecialTeams([stat({ gameId: 'missing' })], data)).toThrow('lacks a completed');
  });
  it('rejects duplicate plays, missing columns, invalid numbers, and missing final scores', () => {
    expect(() => aggregateDefense([play(1), play(1)], 2025)).toThrow('duplicate');
    expect(() => aggregateDefense([{ game_id: 'g' }], 2025)).toThrow('columns');
    expect(() => aggregateDefense([play(1, { sack: 'bad' })], 2025)).toThrow('invalid sack');
    expect(() => aggregateDefense([end(), play(100, { play_type_nfl: 'END_GAME' })], 2025)).toThrow('final scores');
  });
  it('excludes incomplete games, postseason data, and other seasons', () => {
    expect(aggregateDefense([play(1)], 2025).weeks).toEqual([]);
    expect(aggregateDefense([play(1, { season_type: 'POST' }), { ...end(), season_type: 'POST' }], 2025).weeks).toEqual([]);
    expect(aggregateDefense([end()], 2024).weeks).toEqual([]);
  });
  it('normalizes Rams codes and excludes offensive safeties', () => {
    const data = aggregateDefense([play(1, { home_team: 'LA', posteam: 'LA', safety: '1' }), { ...end(), home_team: 'LA', posteam: 'LA' }], 2025);
    expect(data.weeks.find(w => w.team === 'LAR')!.stats.pts_allow).toBe(18);
  });
  it('uses official net yardage and defensive counts, including team sacks without player credit', () => {
    const data = aggregateDefense([end()], 2025);
    const base = { game_id: 'g', season_type: 'REG', sacks_suffered: '3', def_interceptions: '1', def_qb_hits: '8', def_tackles_for_loss: '7', passing_yards: '200', rushing_yards: '100', sack_yards_lost: '-20', kickoff_return_yards: '80', punt_return_yards: '10', def_punt_blocks: '0', def_fg_blocks: '1', def_pat_blocks: '0', def_safeties: '0', def_2pt_made: '0' };
    const totals = [{ ...base, team: 'BUF' }, { ...base, team: 'MIA' }];
    expect(reconcileDefense(data, totals).weeks[0]!.stats).toMatchObject({ yds_allow: 280, sack: 3, qb_hit: 8, tkl_loss: 7, blk_kick: 1 });
    expect(() => reconcileDefense(data, totals.slice(0, 1))).toThrow('lack');
    expect(() => reconcileDefense(data, [...totals, totals[0]!])).toThrow('duplicate');
  });
});

describe('defense scoring and forecasting', () => {
  it.each([[0, 10], [1, 7], [6, 7], [7, 4], [13, 4], [14, 1], [20, 1], [21, 0], [27, 0], [28, -1], [34, -1], [35, -4]])('applies one points tier for %i points', (points, expected) => {
    expect(scoreDefenseWeek(week('BUF', 1, { pts_allow: points }), { pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1, pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4 })).toBe(expected);
  });
  it.each([[99, 5], [100, 3], [199, 3], [200, 1], [299, 1], [300, 0], [550, -5]])('applies one yardage tier for %i yards', (yards, expected) => {
    expect(scoreDefenseWeek(week('BUF', 1, { yds_allow: yards }), { yds_allow_0_100: 5, yds_allow_100_199: 3, yds_allow_200_299: 1, yds_allow_550p: -5 })).toBe(expected);
  });
  it('keeps unknown defense settings explicit and excludes offensive and individual settings', () => {
    expect(inspectDefenseScoring({ sack: 1, pass_td: 4, st_td: 6, st_ff: 1, unusual_rule: 2 })).toEqual({ usedSettings: ['sack'], ignoredSettings: ['unusual_rule'] });
    expect(projectDefense({ ...input, scoringSettings: { sack: 1, unusual_rule: 2 } }).scoreScope).toBe('partial-scoring');
    expect(() => scoreDefenseWeek(week('BUF', 1), { safe: 2 })).toThrow('lack safe');
    expect(() => scoreDefenseWeek(week('BUF', 1), { sack: Infinity })).toThrow('finite');
  });
  it('scores each outcome before averaging nonlinear tiers', () => {
    const p = projectDefense({ ...input, rows: [week('BUF', 1, { pts_allow: 0 }), week('BUF', 2, { pts_allow: 40 })], scoringSettings: { pts_allow_0: 10, pts_allow_14_20: 1, pts_allow_35p: -4 } });
    expect(p.expectedPoints).toBe(3);
    expect(p.expectedPoints).not.toBe(1);
  });
  it('shrinks rare touchdown streaks and includes the opponent without losing negative scores', () => {
    const rows = [week('BUF', 1, { def_td: 3 }), ...Array.from({ length: 20 }, (_, i) => week('OTHER', i % 18 + 1, { def_td: 0 })).map((w, i) => ({ ...w, gameId: `other-${i}`, opponent: 'OTHER' }))];
    const p = projectDefense({ ...input, rows, scoringSettings: { def_td: 6 } });
    expect(p.expectedPoints).toBeLessThan(3);
    expect(p.floor).toBeLessThanOrEqual(p.expectedPoints);
    expect(p.ceiling).toBeGreaterThanOrEqual(p.expectedPoints);
    expect(projectDefense({ ...input, rows: [week('BUF', 1, { pts_allow: 40 })], scoringSettings: { pts_allow_35p: -4 } }).expectedPoints).toBe(-4);
  });
  it('rejects duplicate games and future training, ignores later outcomes, and labels started games', () => {
    expect(() => projectDefense({ ...input, rows: [input.rows[0]!, input.rows[0]!] })).toThrow('duplicate');
    expect(() => projectDefense({ ...input, season: 2025, week: 2, throughWeek: 2 })).toThrow('before');
    const first = projectDefense({ ...input, throughWeek: 1 });
    expect(projectDefense({ ...input, throughWeek: 1, rows: [...input.rows, week('BUF', 3, { sack: 99 })] }).expectedPoints).toBe(first.expectedPoints);
    expect(projectDefense({ ...input, gameStarted: true }).scoreScope).toBe('historical-baseline');
    expect(projectDefense({ ...input, scheduled: false }).recommendationEligible).toBe(false);
  });
  it('routes team aliases into a real defense projection and falls back on a missing new-season file', async () => {
    const client = { getDefenseData: vi.fn(async (season: number) => { if (season === 2026) throw new NflverseApiError('Missing', 404, 'test'); return { weeks: input.rows, specialTeams: {} }; }),
      getSchedule: async () => [game({ season: 2026, week: 2, gameDate: '2099-09-10' })] };
    const sleeper = { getNflState: async () => ({ season: '2026', season_type: 'regular', week: 2 }), getLeague: async () => league({ season: '2026', scoring_settings: settings }) };
    const service = new PlayerProjectionService(sleeper as unknown as SleeperClient, client as unknown as NflverseClient, {} as WeatherClient, false);
    const request = { playerName: 'Buffalo Bills D/ST', leagueId: '123', season: 2026, week: 2 };
    expect(await service.project(request)).toMatchObject({ player: { position: 'DEF', team: 'BUF' }, analysisSeason: 2025, scoreScope: 'weekly-estimate' });
    await expect(service.project({ ...request, analysisSeason: 2026, throughWeek: 1 })).rejects.toMatchObject({ status: 404 });
  });
});
