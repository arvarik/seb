import { NewsClient } from './news/client.js';

async function main(): Promise<void> {
  const news = new NewsClient({ database: false });
  const results = await news.probeSources();
  const failed = results.filter((result) => result.status === 'failed');

  process.stdout.write(`${JSON.stringify({
    failedSourceCount: failed.length,
    passedSourceCount: results.length - failed.length,
    results,
    sourceCount: results.length,
  }, null, 2)}\n`);

  if (failed.length > 0) {
    const labels = failed.map((result) => result.label).join(', ');
    throw new Error(`The following news sources failed: ${labels}.`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`News source smoke test failed: ${message}\n`);
  process.exitCode = 1;
});
