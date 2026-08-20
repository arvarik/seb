#!/usr/bin/env node

await import('tsx/esm');
const { launchCli } = await import('../src/cli.ts');
await launchCli();
