# Seb Documentation

Welcome to the documentation hub for **Seb**, an evidence-backed NFL research and fantasy football assistant for the terminal, scripts, and chat platforms. Every guide below covers how Seb resolves live data, enforces decision safeguards, and runs locally or in production.

> [!TIP]
> New to Seb? Start with the [Setup guide](SETUP.md) to install the CLI and connect a model provider, then read the [Experience model](EXPERIENCES.md) to see how **Explore**, **My Fantasy**, and **Analyze** share context automatically.

## Getting Started

| Guide | Summary |
| --- | --- |
| [Setup guide](SETUP.md) | Install Seb via npm, npx, Docker, or source, verify data sources with `seb doctor`, and connect Sleeper. |
| [Persistent configuration](CONFIGURATION.md) | Manage `~/.config/seb` settings, dotenv imports, secret storage, precedence rules, and optional Judgment tracing. |
| [Model selection](MODELS.md) | Choose auto-updating model families or pinned IDs across Google Gemini, Anthropic, OpenAI, and compatible endpoints. |
| [Experience model](EXPERIENCES.md) | Learn how **Explore**, **My Fantasy**, and **Analyze** carry player, team, league, and roster context across turns. |

## CLI & Terminal UI

| Guide | Summary |
| --- | --- |
| [Interactive guide](INTERACTIVE.md) | Master slash commands, `/about` topics, contextual actions, session resume, turn compaction, and exports. |
| [Terminal interface](TERMINAL_UI.md) | Navigate prompt editing, command completion, clickable tool/reasoning details, tables, sparklines, and themes. |
| [Command-line guide](CLI.md) | Run one-shot queries, stdin pipes, validated `--json` outputs, session management, telemetry, and replay tools. |
| [Skill guide](SKILLS.md) | Focus Seb on 19 specialized NFL information, [fantasy decision](SKILLS.md#decision-safeguards), and research workflows. |

## Forecasting & Architecture

| Guide | Summary |
| --- | --- |
| [Analysis and learning](ANALYSIS.md) | Understand ensemble projections, lineup optimization, waiver/trade scoring, playoff simulations, and local learning. |
| [Defense and special teams](DEFENSE_AND_SPECIAL_TEAMS.md) | See how Seb projects team D/ST scoring, return yardage/TDs, and game-script sack and turnover rates. |
| [Projection review](PROJECTION_REVIEW.md) | Audit statistical calibration, uncertainty intervals, correlation rules, and modeling assumptions. |
| [Evaluation](EVALUATION.md) | Run leakage-free historical replays and compare baseline, ensemble, and adaptive forecast accuracy. |
| [Data sources](DATA_SOURCES.md) | Check every public provider (Sleeper, nflverse, NWS, and 47 NFL newsrooms), cache TTLs, and coverage limits. |
| [Identity resolution](IDENTITIES.md) | Trace how players and franchises map deterministically across Sleeper, nflverse, and news feeds. |
| [Provenance](PROVENANCE.md) | Inspect snapshot manifests, field-level lineage, cache outcomes, and staleness boundaries. |
| [Storage](STORAGE.md) | Review SQLite tables, configuration schemas, file permissions, retention commands, and database recovery. |
| [Architecture](ARCHITECTURE.md) | Explore request lifecycles, agent boundaries, tool contracts, and clean extension points. |
| [AI SDK integration](AI_SDK.md) | Examine grounded news routing, Decision Gate verification, structured JSON schemas, and local DevTools traces. |

## Chat Connectors

Seb ships webhook and bot adapters for **Slack**, **Discord**, **Telegram**, and **GroupMe** from a unified HTTP service (`seb connectors`). Review [Production operations](OPERATIONS.md) before exposing a connector publicly.

| Guide | Summary |
| --- | --- |
| [Connector overview](CONNECTORS.md) | Configure `seb connectors`, Redis state persistence, health checks, rate limits, and shared model resolution. |
| [Slack setup](connectors/SLACK.md) | Connect a Slack app for mentions, threads, and direct messages. |
| [Discord setup](connectors/DISCORD.md) | Deploy a Discord bot for slash interactions and channel threads. |
| [Telegram setup](connectors/TELEGRAM.md) | Configure a Telegram webhook bot with optional reply mention controls. |
| [GroupMe setup](connectors/GROUPME.md) | Set up a GroupMe callback bot with webhook secret verification and HTTPS tunneling. |
| [Custom adapter](connectors/CUSTOM_ADAPTER.md) | Build a custom platform integration on top of Seb's connector runtime. |
| [Other supported platforms](connectors/OTHER_PLATFORMS.md) | Evaluate compatibility options for additional team chat platforms. |

## Operations & Releases

| Guide | Summary |
| --- | --- |
| [Production operations](OPERATIONS.md) | Run Seb reliably with Redis state, health endpoints, secret rotation, upgrades, and incident playbooks. |
| [Versioning](VERSIONING.md) | Understand semantic version guarantees, release tags, schema compatibility, and CI version gates. |
| [Version 1 release review](RELEASE_REVIEW.md) | Read the security, reliability, and verification audit recorded for the v1 release line. |
| [Version 1 scope and roadmap](V1.md) | See what is included in v1 today versus planned future capabilities. |
