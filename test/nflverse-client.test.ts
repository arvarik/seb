import { gzipSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { NflverseClient } from '../src/nflverse/client.js';

const scheduleCsv = `game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,away_rest,home_rest,spread_line,total_line,roof,surface,temp,wind,stadium_id,stadium
2026_01_BUF_KC,2026,REG,1,2026-09-10,Thursday,20:20,BUF,,KC,,7,7,-2.5,48.5,outdoors,grass,,,KAN00,Arrowhead Stadium
2026_01_DAL_PHI,2026,REG,1,2026-09-11,Friday,20:00,DAL,,PHI,,7,7,1.5,45.5,outdoors,grass,,,PHI00,Lincoln Financial Field
2025_WC_BUF_JAX,2025,WC,19,2026-01-10,Saturday,16:30,BUF,,JAX,,7,7,-1.5,44.5,outdoors,grass,,,JAX00,EverBank Stadium
`;

const statsCsv = `player_id,player_display_name,position,season,week,season_type,game_id,team,opponent_team,completions,attempts,passing_yards,passing_tds,passing_interceptions,carries,rushing_yards,rushing_tds,receptions,targets,receiving_yards,receiving_tds,receiving_air_yards,target_share,air_yards_share,fantasy_points,fantasy_points_ppr
00-1,Josh Allen,QB,2025,1,REG,2025_01_BUF_BAL,BUF,BAL,20,30,250,2,1,8,45,1,0,0,0,0,0,,,28.5,28.5
00-2,James Cook,RB,2025,1,REG,2025_01_BUF_BAL,BUF,BAL,0,0,0,0,0,15,80,1,4,5,35,0,10,0.12,0.04,17.5,21.5
`;

describe('NflverseClient', () => {
  it('loads and filters the compressed nflverse schedule', async () => {
    let calls = 0;
    const client = new NflverseClient({
      cacheDirectory: false,
      fetch: async () => {
        calls += 1;
        return csvResponse(scheduleCsv);
      },
    });

    const [games, secondRead] = await Promise.all([
      client.getSchedule({ season: 2026, team: 'kc', week: 1 }),
      client.getSchedule({ season: 2026, team: 'phi', week: 1 }),
    ]);

    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({
      gameId: '2026_01_BUF_KC',
      homeTeam: 'KC',
      spreadLine: -2.5,
      roof: 'outdoors',
    });
    expect(secondRead[0]?.homeTeam).toBe('PHI');
    expect(calls).toBe(1);
  });

  it('loads weekly player usage and production statistics', async () => {
    const requested: string[] = [];
    const client = new NflverseClient({
      cacheDirectory: false,
      fetch: async (input) => {
        requested.push(String(input));
        return csvResponse(statsCsv);
      },
    });

    const stats = await client.getPlayerWeeklyStats({
      season: 2025,
      playerName: 'james cook',
      seasonType: 'REG',
    });

    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      carries: 15,
      targets: 5,
      fantasyPointsPpr: 21.5,
    });
    expect(requested[0]).toContain('stats_player_week_2025.csv.gz');
  });

  it('maps the POST filter to nflverse postseason stage values', async () => {
    const client = new NflverseClient({
      cacheDirectory: false,
      fetch: async () => csvResponse(scheduleCsv),
    });

    const games = await client.getSchedule({ season: 2025, gameType: 'POST' });

    expect(games).toHaveLength(1);
    expect(games[0]).toMatchObject({ gameType: 'WC', week: 19 });
  });

  it('rejects an unavailable nflverse file with a useful error', async () => {
    const client = new NflverseClient({
      cacheDirectory: false,
      fetch: async () => new Response('missing', { status: 404 }),
    });

    await expect(
      client.getPlayerWeeklyStats({ season: 2026 }),
    ).rejects.toThrow('nflverse returned HTTP 404');
  });

  it('rejects rows with missing required columns', async () => {
    const client = new NflverseClient({
      cacheDirectory: false,
      fetch: async () => csvResponse('game_id,season\nexample,2026\n'),
    });

    await expect(client.getSchedule()).rejects.toThrow('game_type');
  });

  it('skips nflverse aggregate rows without player IDs', async () => {
    const aggregate = statsCsv.replace(
      '00-1,Josh Allen',
      ',Team aggregate',
    );
    const client = new NflverseClient({
      cacheDirectory: false,
      fetch: async () => csvResponse(aggregate),
    });

    const stats = await client.getPlayerWeeklyStats({ season: 2025 });

    expect(stats).toHaveLength(1);
    expect(stats[0]?.playerId).toBe('00-2');
  });

  it('rejects compressed downloads before it reads an oversized body', async () => {
    const client = new NflverseClient({
      cacheDirectory: false,
      fetch: async () => new Response('small', {
        headers: { 'content-length': String(33 * 1024 * 1024) },
      }),
    });

    await expect(client.getSchedule()).rejects.toThrow('exceeds');
  });
});

function csvResponse(value: string): Response {
  return new Response(gzipSync(value), {
    status: 200,
    headers: { 'content-type': 'application/gzip' },
  });
}
