import { SleeperClient } from './sleeper/client.js';

async function main(): Promise<void> {
  const state = await new SleeperClient().getNflState();
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        source: 'Sleeper',
        season: state.season,
        seasonType: state.season_type,
        week: state.week,
        leagueSeason: state.league_season ?? null,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Sleeper smoke test failed: ${message}\n`);
  process.exitCode = 1;
});
