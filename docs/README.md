# Seb documentation

This documentation explains how to use, understand, extend, and operate Seb.

## Start here

| Goal | Guide |
| --- | --- |
| Install Seb and connect an account | [Setup](SETUP.md) |
| Understand Explore, My Fantasy, and Analyze | [Experience model](EXPERIENCES.md) |
| Learn the terminal interface | [Interactive guide](INTERACTIVE.md) |
| Use scripts, pipes, or JSON | [Command-line guide](CLI.md) |
| Find keyboard and display controls | [Terminal interface](TERMINAL_UI.md) |
| Understand decision safeguards | [Skill guide](SKILLS.md#decision-safeguards) |

New users should read the setup and experience guides first.

## Product guides

- [Experience model](EXPERIENCES.md) explains automatic context and the three main ways to use Seb.
- [Interactive guide](INTERACTIVE.md) covers commands, follow-up context, sources, exports, and examples.
- [Terminal interface](TERMINAL_UI.md) covers editing, scrolling, tables, history, themes, and accessibility.
- [Skill guide](SKILLS.md) describes optional advanced workflows.
- [Command-line guide](CLI.md) covers one-shot requests, standard input, JSON, diagnostics, and shell completion.

## Trust and data

- [Data sources](DATA_SOURCES.md) lists each provider, supported facts, cache period, and known limit.
- [Storage](STORAGE.md) explains SQLite caches, snapshots, permissions, and recovery.
- [Identity](IDENTITIES.md) explains player and team mapping across sources.
- [Provenance](PROVENANCE.md) explains field-level source lineage and freshness.
- [Evaluation](EVALUATION.md) explains historical replay rules and baseline metrics.

## Build and operate

- [Architecture](ARCHITECTURE.md) describes request flow, agent boundaries, source clients, and extension points.
- [AI SDK integration](AI_SDK.md) covers direct news, decision safeguards, typed output, context pruning, and local traces.
- [Production operations](OPERATIONS.md) covers state, scaling, health checks, secrets, upgrades, and incidents.
- [Versioning](VERSIONING.md) defines release versions, tags, checks, and guarantees.
- [V1 design](V1.md) records the longer-term roadmap for injuries, projections, and simulations.

## Connectors

Seb includes Slack, Discord, and Telegram connectors.

- [Connector overview](CONNECTORS.md)
- [Slack](connectors/SLACK.md)
- [Discord](connectors/DISCORD.md)
- [Telegram](connectors/TELEGRAM.md)
- [Custom adapter](connectors/CUSTOM_ADAPTER.md)
- [Other supported platforms](connectors/OTHER_PLATFORMS.md)

Read the production operations guide before a public connector deployment.
