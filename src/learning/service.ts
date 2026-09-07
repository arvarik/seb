import { throwIfRequestAborted } from '../ai/request-signal.js';
import { NflverseClient } from '../nflverse/client.js';
import type { SleeperSettings } from '../sleeper/types.js';
import { completedLearningWeek } from './completed-week.js';
import { learnFromCompletedRows, PPR_SCORING } from './engine.js';
import { LearningStore } from './store.js';

export class LearningService {
  constructor(
    private readonly client = new NflverseClient({ database: false }),
    private readonly store = new LearningStore(),
    private readonly now = () => new Date(),
  ) {}

  async update(input: { season: number; throughWeek?: number; scoring?: SleeperSettings }) {
    if (!Number.isInteger(input.season) || input.season < 1999 || input.season > 2100 ||
      (input.throughWeek !== undefined && (!Number.isInteger(input.throughWeek) || input.throughWeek < 1 || input.throughWeek > 18))) {
      throw new Error('Learning requires a valid season and a week from 1 through 18.');
    }
    return this.store.exclusive(async () => {
      const games = await this.client.getSchedule({ season: input.season, gameType: 'REG' });
      const throughWeek = completedLearningWeek(games, input.season, input.throughWeek, this.now());
      const scoring = input.scoring ?? PPR_SCORING;
      const rows = await this.client.getPlayerWeeklyStats({ season: input.season, seasonType: 'REG', throughWeek });
      const completed = games.filter((game) => game.season === input.season && game.gameType === 'REG' && game.week <= throughWeek);
      const gamesById = new Map(completed.map((game) => [game.gameId, game]));
      if (rows.some((row) => {
        const game = gamesById.get(row.gameId);
        return !game || row.week !== game.week || row.season !== input.season || row.seasonType !== 'REG' ||
          ![game.homeTeam, game.awayTeam].includes(row.team);
      })) throw new Error('Player statistics do not match the completed schedule. Retry after the source updates.');
      const rowGameIds = new Set(rows.map((row) => row.gameId));
      if (completed.some((game) => !rowGameIds.has(game.gameId))) {
        throw new Error('Weekly player statistics are missing for a completed game. Retry after the source updates.');
      }
      const previous = await this.store.latest(input.season, throughWeek + 1, scoring);
      const revision = learnFromCompletedRows({ rows, season: input.season, throughWeek, scoring, now: this.now() });
      if (previous?.dataChecksum === revision.dataChecksum && previous.throughWeek === throughWeek) {
        return { changed: false, file: null, revision: previous };
      }
      throwIfRequestAborted();
      const file = await this.store.save(revision);
      return { changed: true, file, revision };
    });
  }
}
