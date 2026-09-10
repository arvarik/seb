import { z } from 'zod';

const counters = ['sack', 'int', 'ff', 'fum_rec', 'def_td', 'safe', 'blk_kick', 'def_st_td', 'def_st_ff', 'def_st_fum_rec', 'def_st_tkl_solo', 'def_kr_yd', 'def_pr_yd', 'qb_hit', 'tkl_loss', 'def_2pt'] as const;
export const defenseWeekSchema = z.object({
  gameId: z.string().min(1), season: z.number().int(), week: z.number().int().min(1).max(18),
  team: z.string().min(1), opponent: z.string().min(1),
  stats: z.record(z.string(), z.number().finite()),
});
export const defenseDataSchema = z.object({
  weeks: z.array(defenseWeekSchema),
  specialTeams: z.record(z.string(), z.object({ ff: z.number().nonnegative(), recoveries: z.number().nonnegative(), tackles: z.number().nonnegative(), kickYards: z.number(), puntYards: z.number() })),
});
export type DefenseWeek = z.infer<typeof defenseWeekSchema>;
export type DefenseData = z.infer<typeof defenseDataSchema>;
export const DEFENSE_COLUMNS = new Set(['game_id', 'play_id', 'season', 'season_type', 'week', 'home_team', 'away_team', 'home_score', 'away_score', 'posteam', 'defteam', 'play_type', 'play_type_nfl', 'special', 'td_team', 'touchdown', 'safety', 'sack', 'interception', 'qb_hit', 'tackled_for_loss', 'yards_gained', 'punt_blocked', 'field_goal_result', 'extra_point_result', 'return_team', 'return_yards', 'kickoff_returner_player_id', 'punt_returner_player_id', 'defensive_two_point_conv', 'two_point_attempt', ...[1, 2].flatMap(i => [`forced_fumble_player_${i}_team`, `forced_fumble_player_${i}_player_id`, `fumble_recovery_${i}_team`, `fumble_recovery_${i}_player_id`, `fumbled_${i}_team`, `solo_tackle_${i}_team`, `solo_tackle_${i}_player_id`])]);
const teamCode = (v: string | undefined) => v === 'LA' ? 'LAR' : v ?? '';

/** Keep separate counters for defense, team special teams, and individual special teams. */
export function aggregateDefense(rows: readonly Record<string, string>[], season: number): DefenseData {
  const weeks = new Map<string, DefenseWeek>();
  const specialTeams: DefenseData['specialTeams'] = {};
  const completed = new Set<string>();
  const seen = new Set<string>();
  const required = [...DEFENSE_COLUMNS];
  if (!rows.length || required.some(key => !(key in rows[0]!))) throw new Error('The defense play data lacks required columns.');
  const number = (r: Record<string, string>, key: string) => {
    const n = r[key]?.trim() ? Number(r[key]) : 0;
    if (!Number.isFinite(n)) throw new Error(`The defense play data contains an invalid ${key}.`);
    return n;
  };
  for (const r of rows) {
    if (r.season_type !== 'REG' || Number(r.season) !== season) continue;
    const id = `${r.game_id}:${r.play_id}`;
    if (seen.has(id)) throw new Error('The defense play data contains duplicate plays.');
    seen.add(id);
    const home = teamCode(r.home_team), away = teamCode(r.away_team);
    for (const team of [home, away]) {
      const key = `${r.game_id}:${team}`;
      if (!weeks.has(key)) weeks.set(key, { gameId: r.game_id!, season, week: number(r, 'week'), team,
        opponent: team === home ? away : home, stats: Object.fromEntries([...counters.map(k => [k, 0]), ['pts_allow', 0], ['yds_allow', 0]]) });
    }
    const stat = (team: string, key: string, value = 1) => {
      const entry = weeks.get(`${r.game_id}:${team}`);
      if (!entry) throw new Error('The defense play data has an unknown team.');
      entry.stats[key] = (entry.stats[key] ?? 0) + value;
    };
    const player = (id: string | undefined, key: keyof DefenseData['specialTeams'][string], value = 1) => {
      if (!id) return;
      const entry = specialTeams[`${r.game_id}:${id}`] ??= { ff: 0, recoveries: 0, tackles: 0, kickYards: 0, puntYards: 0 };
      entry[key] += value;
    };
    if (r.play_type_nfl === 'END_GAME') {
      if (!r.home_score?.trim() || !r.away_score?.trim()) throw new Error('The completed game lacks final scores.');
      completed.add(r.game_id!);
      stat(home, 'pts_allow', number(r, 'away_score'));
      stat(away, 'pts_allow', number(r, 'home_score'));
    }
    const def = teamCode(r.defteam), off = teamCode(r.posteam), st = r.special === '1';
    if (!def || !off || r.play_type === 'no_play' || r.two_point_attempt === '1') continue;
    if (!st) {
      for (const [source, target] of [['sack', 'sack'], ['interception', 'int'], ['qb_hit', 'qb_hit'], ['tackled_for_loss', 'tkl_loss']] as const) stat(def, target, number(r, source));
      if (['run', 'pass', 'qb_kneel', 'qb_spike'].includes(r.play_type!)) stat(def, 'yds_allow', number(r, 'yards_gained'));
    }
    if (r.touchdown === '1') {
      const scoring = teamCode(r.td_team);
      if (st) stat(scoring, 'def_st_td');
      else if (scoring !== off) {
        stat(scoring, 'def_td');
        // Sleeper excludes touchdowns against the offense, but retains the ensuing PAT.
        stat(off, 'pts_allow', -6);
      }
    }
    if (r.safety === '1') {
      stat(def, 'safe');
      if (!st) stat(off, 'pts_allow', -2);
    }
    if (r.defensive_two_point_conv === '1') stat(def, 'def_2pt');
    if (r.punt_blocked === '1' || r.field_goal_result === 'blocked' || r.extra_point_result === 'blocked') stat(def, 'blk_kick');
    for (const i of [1, 2]) {
      const forcing = teamCode(r[`forced_fumble_player_${i}_team`]);
      if (forcing && (st || forcing === def)) {
        stat(forcing, st ? 'def_st_ff' : 'ff');
        if (st) player(r[`forced_fumble_player_${i}_player_id`], 'ff');
      }
      const recovering = teamCode(r[`fumble_recovery_${i}_team`]);
      const fumbling = teamCode(r[`fumbled_${i}_team`]);
      if (recovering && recovering !== fumbling && (st || recovering === def)) {
        stat(recovering, st ? 'def_st_fum_rec' : 'fum_rec');
        if (st) player(r[`fumble_recovery_${i}_player_id`], 'recoveries');
      }
      const tackling = teamCode(r[`solo_tackle_${i}_team`]);
      if (st && tackling) { stat(tackling, 'def_st_tkl_solo'); player(r[`solo_tackle_${i}_player_id`], 'tackles'); }
    }
    if (st && r.return_team) {
      const kick = r.play_type === 'kickoff', punt = r.play_type === 'punt';
      if (kick || punt) {
        stat(teamCode(r.return_team), kick ? 'def_kr_yd' : 'def_pr_yd', number(r, 'return_yards'));
        player(r[kick ? 'kickoff_returner_player_id' : 'punt_returner_player_id'], kick ? 'kickYards' : 'puntYards', number(r, 'return_yards'));
      }
    }
  }
  return defenseDataSchema.parse({ weeks: [...weeks.values()].filter(w => completed.has(w.gameId)),
    specialTeams: Object.fromEntries(Object.entries(specialTeams).filter(([key]) => completed.has(key.split(':')[0]!))) });
}

export const PLAYER_SPECIAL_TEAMS_SETTINGS = ['st_ff', 'st_fum_rec', 'st_tkl_solo', 'kr_yd', 'pr_yd'];
export function enrichSpecialTeams(rows: readonly import('./types.js').NflversePlayerWeek[], data: DefenseData): import('./types.js').NflversePlayerWeek[] {
  const covered = new Set(data.weeks.map(row => row.gameId));
  return rows.map(row => {
    if (!covered.has(row.gameId)) throw new Error('Special-teams data lacks a completed player game.');
    const st = data.specialTeams[`${row.gameId}:${row.playerId}`];
    return { ...row, specialTeamsForcedFumbles: st?.ff ?? 0, specialTeamsRecoveries: st?.recoveries ?? 0,
      specialTeamsTackles: st?.tackles ?? 0, kickReturnYards: row.kickReturnYards ?? st?.kickYards ?? 0, puntReturnYards: row.puntReturnYards ?? st?.puntYards ?? 0 };
  });
}

/** Weekly official totals retain stat corrections and unusual multi-possession plays. */
export function reconcileDefense(data: DefenseData, totals: readonly Record<string, string>[]): DefenseData {
  const index = new Map(totals.filter(r => r.season_type === 'REG').map(r => [`${r.game_id}:${teamCode(r.team)}`, r]));
  if (index.size !== totals.filter(r => r.season_type === 'REG').length) throw new Error('Weekly team statistics contain duplicate games.');
  const get = (r: Record<string, string> | undefined, key: string): number => {
    if (!r?.[key]?.trim() || !Number.isFinite(Number(r[key]))) throw new Error(`Weekly team statistics lack ${key}.`);
    return Number(r[key]);
  };
  return { ...data, weeks: data.weeks.map(row => {
    const team = index.get(`${row.gameId}:${row.team}`), opponent = index.get(`${row.gameId}:${row.opponent}`);
    return { ...row, stats: { ...row.stats,
      sack: get(opponent, 'sacks_suffered'), int: get(team, 'def_interceptions'),
      qb_hit: get(team, 'def_qb_hits'), tkl_loss: get(team, 'def_tackles_for_loss'),
      yds_allow: get(opponent, 'passing_yards') + get(opponent, 'rushing_yards') + get(opponent, 'sack_yards_lost'),
      def_kr_yd: get(team, 'kickoff_return_yards'), def_pr_yd: get(team, 'punt_return_yards'),
      blk_kick: get(team, 'def_punt_blocks') + get(team, 'def_fg_blocks') + get(team, 'def_pat_blocks'),
      safe: get(team, 'def_safeties'), def_2pt: get(team, 'def_2pt_made'),
    } };
  }) };
}
