# Changelog

This file records each user-visible Seb release.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A live slash-command palette with fuzzy matches and contextual argument values.
- Interactive Sleeper league and roster discovery commands.

### Changed

- Setup profiles now store only a global NFL season instead of one fantasy roster.
- Version 1 profiles migrate to the team-independent version 2 schema.
- The project now uses the latest AI SDK 7.0.71 and TUI 1.0.72 releases.

## [0.0.2] - 2026-08-20

### Added

- nflverse schedule and weekly player-stat clients with compressed CSV support.
- Player trend, team performance, and defense-by-position analysis tools.
- NWS point discovery, hourly forecast, and active alert clients.
- Game weather and combined game environment tools.
- A weekly outdoor game weather-risk screen with bounded request concurrency.
- Interactive session context, slash commands, skills, source history, and transcript exports.
- Contextual next-action suggestions after local commands and model answers.
- Gemini fallback after primary-model capacity or rate-limit errors.
- Live diagnostics and a smoke test for nflverse and NWS data.
- Detailed interactive, skill, and data source guides.
- Persistent canonical player and NFL team identities across Sleeper and nflverse.
- A private SQLite cache with checksums, conditional requests, and versioned snapshots.
- Field-level source provenance with freshness and derivation records.
- Bounded retries, request timeouts, stale-if-error reads, and circuit breakers.
- A first-run setup wizard with Gemini validation, season selection, and a private Sleeper profile.
- Searchable interactive commands and Bash, Fish, and Zsh completion scripts.
- A historical replay harness with leakage checks and baseline accuracy metrics.
- Snapshot provenance inspection through `seb snapshots --id` and `/provenance`.

### Changed

- All source clients now store cache entries in `.cache/seb.sqlite`.
- Cache refresh commands now preserve historical snapshots.
- Cache refresh commands preserve canonical identities and source links.
- Source output now reports retrieval time, cache outcome, and stale-data warnings.

## [0.0.1] - 2026-08-20

### Added

- A read-only Sleeper agent with player, league, roster, matchup, transaction, and trend tools.
- League ranking and matchup prediction with transparent score-based heuristics.
- An interactive terminal interface with streaming answers and tool cards.
- One-shot text, standard input, and JSON command modes.
- Local diagnostics for Node.js, Gemini, and Sleeper.
- Slack, Discord, Telegram, and custom connector guidance.
- Test harnesses for the agent, Sleeper client, analysis, connectors, CLI, and diagnostics.
