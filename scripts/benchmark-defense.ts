import { NflverseClient } from '../src/nflverse/client.js';
import { projectDefense, scoreDefenseWeek } from '../src/projection/defense.js';
import { mean } from '../src/projection/statistics.js';

const season = Number(process.argv[2] ?? 2025);
if (!Number.isInteger(season) || season < 1999 || season > 2100) throw new Error('Pass one valid NFL season.');
const data = await new NflverseClient().getDefenseData(season);
const scoring = { sack: 1, int: 2, fum_rec: 2, safe: 2, blk_kick: 2, def_td: 6, def_st_td: 6,
  pts_allow_0: 10, pts_allow_1_6: 7, pts_allow_7_13: 4, pts_allow_14_20: 1, pts_allow_21_27: 0, pts_allow_28_34: -1, pts_allow_35p: -4 };
const results = data.weeks.filter(w => w.week >= 5).map(outcome => {
  const history = data.weeks.filter(w => w.week < outcome.week);
  const team = history.filter(w => w.team === outcome.team);
  const actual = scoreDefenseWeek(outcome, scoring);
  const projection = projectDefense({ rows: history, team: outcome.team, name: outcome.team, opponent: outcome.opponent,
    analysisSeason: season, throughWeek: outcome.week - 1, season, week: outcome.week,
    leagueId: 'benchmark', leagueName: 'Standard D/ST', scoringSettings: scoring, scheduled: true, gameStarted: false });
  return { actual, forecast: projection.expectedPoints, teamMean: mean(team.map(r => scoreDefenseWeek(r, scoring))),
    leagueMean: mean(history.map(r => scoreDefenseWeek(r, scoring))), covered: actual >= projection.floor && actual <= projection.ceiling };
});
const metrics = (key: 'forecast' | 'teamMean' | 'leagueMean') => ({
  mae: mean(results.map(r => Math.abs(r.actual - r[key]))),
  rmse: Math.sqrt(mean(results.map(r => (r.actual - r[key]) ** 2))),
});
console.log(JSON.stringify({ season, firstTestWeek: 5, forecasts: results.length, model: metrics('forecast'),
  teamMean: metrics('teamMean'), leagueMean: metrics('leagueMean'), historicalIntervalCoverage: mean(results.map(r => Number(r.covered))),
  limits: 'Rolling evaluation uses revised public data. It does not reconstruct historical source availability or prove future accuracy.' }, null, 2));
