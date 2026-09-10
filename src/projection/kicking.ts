import { ResearchDataError } from '../data/research-error.js';
import type { NflversePlayerWeek } from '../nflverse/types.js';
import type { SleeperSettings } from '../sleeper/types.js';

const DISTANCE_RANGES = [
  ['0_19', 0, 20], ['20_29', 20, 30], ['30_39', 30, 40],
  ['40_49', 40, 50], ['50p', 50, Infinity], ['50_59', 50, 60], ['60p', 60, Infinity],
] as const;

export const KICKING_SETTINGS = new Set([
  'fgm', 'fgmiss', 'xpm', 'xpmiss', 'fgm_yds', 'fgm_yds_over_30',
  ...DISTANCE_RANGES.flatMap(([range]) => [`fgm_${range}`, `fgmiss_${range}`]),
]);

export function scoreKicking(row: NflversePlayerWeek, settings: SleeperSettings): number {
  const kicking = row.kicking;
  const count = (value: number | null | undefined): number => {
    if (value == null || !Number.isInteger(value) || value < 0) throw new Error('missing count');
    return value;
  };
  const missed = (attempted: number | null | undefined, made: number | null | undefined) => count(count(attempted) - count(made));
  const distances = (values: number[] | null | undefined, expected: number) => {
    if (!values || values.length !== expected || values.some((value) => !Number.isInteger(value) || value < 0)) throw new Error('missing distances');
    return values;
  };
  const madeDistances = () => distances(kicking?.madeDistances, count(kicking?.fieldGoalsMade));
  const missedDistances = () => distances(kicking?.missedDistances, missed(kicking?.fieldGoalsAttempted, kicking?.fieldGoalsMade));
  const components: Record<string, () => number> = {
    fgm: () => count(kicking?.fieldGoalsMade),
    fgmiss: () => missed(kicking?.fieldGoalsAttempted, kicking?.fieldGoalsMade),
    xpm: () => count(kicking?.extraPointsMade),
    xpmiss: () => missed(kicking?.extraPointsAttempted, kicking?.extraPointsMade),
    fgm_yds: () => madeDistances().reduce((sum, distance) => sum + distance, 0),
    fgm_yds_over_30: () => madeDistances().reduce((sum, distance) => sum + Math.max(0, distance - 30), 0),
  };
  for (const [range, minimum, maximum] of DISTANCE_RANGES) {
    components[`fgm_${range}`] = () => madeDistances().filter((distance) => distance >= minimum && distance < maximum).length;
    components[`fgmiss_${range}`] = () => missedDistances().filter((distance) => distance >= minimum && distance < maximum).length;
  }
  let points = 0;
  for (const [key, component] of Object.entries(components)) {
    const weight = settings[key];
    if (weight == null || weight === 0) continue;
    if (typeof weight !== 'number' || !Number.isFinite(weight)) throw new ResearchDataError(`Scoring setting ${key} must be a finite number.`);
    try {
      points += weight * component();
    } catch {
      throw new ResearchDataError(`The source lacks valid ${key} kicking statistics required by this league. Do not treat missing values as zero.`);
    }
  }
  return points;
}
