# Changelog

This file records each user-visible Seb release.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-08-29

### Added

- Seb now searches 44 built-in NFL news sources before it uses Google Search.
- The registry includes official NFL, independent, fantasy-impact, and all 32 official team news sources.
- News discovery now reads RSS feeds, news sitemaps, and supported publisher pages.
- Article enrichment now validates canonical URLs and publication dates from structured page metadata.
- The `news:smoke` command now tests every retained source against its live public endpoint.

### Changed

- Google Search now supplies secondary coverage when direct sources return fewer than five results or fewer than two publishers.
- Direct news results now prefer recent, relevant, and official reporting while limiting one publisher to three results.
- Syndicated RSS items now preserve the original publisher for coverage counts and citations.
- News requests now identify team sources from a team code, city, name, or supported alias.
- News cache records now include discovery data, article metadata, and robots policies.
- News source progress and cache clearing now use the `news` source family.
- The agent now removes old reasoning and tool data before each model step.
- The final agent step now produces an answer without another tool call.
- Agents without web tools now state that current news is unavailable.
- Connector replies now use one two-minute deadline across primary and fallback models.
- Concurrent reads in one Seb process now share one source refresh per database file.

### Security

- The news client now follows each site's robots policy and crawl delay.
- The news client now rejects cross-site redirects, `no-store` responses, oversized bodies, and invalid content types.
- The news client now validates each redirect and its robots policy before it requests the next URL.
- Crawler retries no longer bypass a publisher crawl delay.
- Synthetic content hashes now support conditional cache reuse when a source omits an HTTP validator.
- Remote session strings now have a length limit and use one labeled JSON value.
- Cache reads now require the stored source URL to match the requested source.

### Fixed

- Duplicate news URLs and titles no longer produce repeated evidence.
- Detailed news queries no longer accept substring matches or generic intent words as relevant coverage.
- Invalid, missing, stale, or future publication dates no longer appear as current news.
- Publisher home-page canonical links no longer replace a valid article URL.
- Mixed Yahoo and PFF feeds no longer add unrelated college items.
- First-class news now satisfies the recommendation evidence gate without a Google result.
- Cached and stale news now display their actual cache state instead of a live badge.
- FantasyPros dates now come from the current server-rendered page without extra article requests.
- Stopping an interactive model request or network command now cancels active source work.
- Connector shutdown now cancels active model and source work.
- One cancelled caller no longer cancels a shared refresh that other callers still need.
- Each shared refresh now writes one cache value and applies each caller's stale fallback.
- A cancelled refresh no longer returns stale data or counts as a source failure.
- Retry cleanup and oversized-body cleanup no longer delay caller cancellation.
- Cancelling an nflverse request now stops file expansion and CSV parsing.
- Cache reads now apply the current freshness policy to an existing record.
- Cache policy deadlines now persist before storage pruning runs.
- Closing a shared database now removes it from the shared database registry.
- Unreadable or oversized HTTP error bodies now preserve the useful source error.
- Interactive account changes now commit only after discovery and profile storage succeed.
- The doctor now stops its Gemini check when the caller cancels the command.

## [0.0.11] - 2026-08-21

### Changed

- The project now uses AI SDK `7.0.76`.

### Fixed

- Wrapped and multiline prompts now keep the previous answer anchored in the visible transcript.
- Long prompts now keep the editor cursor and status row visible.
- Terminal resizing and temporary overlays now preserve the transcript position.
- Unicode text now wraps, aligns, edits, truncates, and selects by terminal display width.
- Wrapped prompts now preserve spaces, and pasted tabs now render as stable spaces.
- Terminals below the supported size now show a bounded resize notice.
- Cache commands now reject several actions instead of executing the last action.
- Setup and completion commands now accept their help flags.
- Interactive diagnostics now reject invalid options before they run network checks.
- Inline skill prompts now preserve line breaks and avoid guessing a player from the full question.
- Successful tool results now update player and team context, including full NFL team names.
- Incomplete model streams now withhold partial recommendations.

## [0.0.10] - 2026-08-21

### Added

- The home screen and My Fantasy view now show urgent lineup, player status, reserve, trade deadline, and playoff actions.
- Scoring-aware player projections now show a median, floor, ceiling, confidence, matchup adjustment, weather adjustment, and limits.
- The waiver assistant now ranks available targets and shows transparent FAAB ranges from roster need, demand, risk, and recent production.
- The trade impact tool now compares scoring value and roster position changes for both sides.
- `Ctrl+G` now opens one visible selector for league, roster, week, player, and team context.
- Each answer now keeps an immutable numbered Evidence section with live, cached, or stale retrieval details.
- Scheduled live contracts now check Sleeper, nflverse, the National Weather Service, and Gemini structured answers.

### Changed

- A deterministic eligibility gate now withholds advice when required source, identity, status, news, scoring, or projection evidence is incomplete.
- Explicit commands now select the active experience. Question keywords no longer change it silently.
- Long answers now open at the latest Decision section or answer heading.
- Seb now owns the terminal conversation loop through the public AI SDK transport contract.
- The project now uses AI SDK `7.0.73` and Google provider `4.0.49`.

### Fixed

- Tool-selected players and teams no longer replace active context unless the user named that subject.
- League and roster commands now reject values outside the discovered account context.
- Connector, terminal, text, and JSON recommendations now use the same evidence rules.

## [0.0.9] - 2026-08-20

### Added

- Mouse drag now selects visible terminal text and copies it on release.
- The `/select` command now enables native terminal text selection and copying.

### Fixed

- Wide comparison cards now render inline Markdown in every header and value.
- Web answers now show up to three sources on one compact line.
- The web source line now stays inside the current Seb response.
- Recoverable tool errors now show a retry state instead of a temporary failure.

## [0.0.8] - 2026-08-20

### Changed

- Mouse wheel events now move the transcript by three rows.
- Page Up and Page Down now use the available viewport height.

### Fixed

- The terminal now combines rapid scroll events into a maximum of 60 frames per second.
- The terminal now skips unchanged frames. Extra events at either scroll boundary no longer redraw the screen.
- Horizontal trackpad gestures and mouse release events no longer move the transcript.
- Streamed text now updates the scroll boundary before the next input event.

## [0.0.7] - 2026-08-20

### Added

- The cache command now reports byte sizes and prunes expired or old records.
- Text and connector answers now list direct data sources with freshness details.
- CI now runs linting, type checks, tests, coverage checks, and a production dependency audit.
- The test suite now enforces global coverage thresholds.

### Changed

- Source clients now validate remote records before they save or return data.
- Source clients now stop downloads that exceed bounded response sizes.
- nflverse now decompresses and parses source files without synchronous gzip work.
- Snapshot listings now query metadata without loading payload or provenance JSON.
- Snapshot retention now uses source-specific limits and a 512 MiB global limit.
- Live doctor checks now bypass the local source cache.
- The connector service now drains background work with a shutdown deadline.
- Weekly weather analysis now reuses the schedule rows that it already loaded.

### Security

- The terminal now removes untrusted control sequences before it renders text.
- Telegram webhook mode now requires a secret and polling mode exposes no webhook route.
- Seb now reapplies private permissions to the local cache directory.
- Doctor now reports unsafe environment and cache permissions.

### Fixed

- Connector platform errors no longer start an incorrect Gemini fallback request.
- The `/new` and `/clear` commands now remove their confirmation from the next model context.
- Cache and snapshot write failures now appear as source warnings.
- Snapshot reads now verify both payload and provenance checksums.
- The user agent now reads the current package version.

- The terminal now renders emphasis, strong emphasis, strikethrough, escapes, nested inline styles, code spans, and image labels without visible Markdown markers.
- Headings and wrapped long words now keep their inline terminal styles.

## [0.0.6] - 2026-08-20

### Changed

- Mouse and trackpad wheel events now move the transcript by one row for smoother reading.
- Contextual actions now appear only on the first prompt and after `/new` or `/clear`.
- The `/next` command still shows contextual actions at any time.

### Fixed

- Markdown links, angle-bracket links, and bare HTTP URLs now remain clickable after line wrapping.
- Long linked URLs now fit the terminal width without losing their link target.
- Wrapped styled text now keeps its terminal formatting.
- Terminals without link support now print each bare URL once.
- The renderer no longer removes a legitimate final paragraph that starts with `Try next:`.

## [0.0.5] - 2026-08-20

### Added

- Explore, My Fantasy, and Analyze as the three primary product experiences.
- Automatic Sleeper account discovery from one optional saved username.
- Automatic current NFL state, display week, league season, owned roster, and league deadline context.
- Account-wide fantasy dashboards with current league and owned roster context.
- Historical league discovery through `/leagues USERNAME YEAR`.
- Responsive terminal tables, compact record cards, and data-aware table grouping.
- Mouse and trackpad transcript scrolling with explicit scroll position status.
- A dedicated experience guide and a goal-based documentation index.

### Changed

- The first-run preferences file now stores only an optional Sleeper username.
- Version 1 and version 2 profiles now migrate to the username-only version 3 schema.
- Interactive and one-shot requests now refresh automatic context before model use.
- The home screen now explains the three experiences and hides empty setup placeholders.
- The command palette now promotes experience and account actions before advanced overrides.
- Contextual actions now follow the active player, team, account, and experience.
- Plain-language questions now select the most relevant experience automatically.
- The README now presents Seb as a product and routes technical detail into focused guides.

### Fixed

- Inline `/skill NAME QUESTION` commands now run the supplied question.
- Player follow-ups now retain the active player instead of asking for the player again.
- Skill instructions now remain active during a natural follow-up.
- The mouse wheel now scrolls the transcript instead of recalling prompt history.
- Current week selection now falls back when Sleeper returns an invalid display week.
- NFL season and Sleeper league season now remain distinct.
- A failed roster request no longer removes healthy league context.
- Loading blank preferences no longer preserves an earlier account's leagues.

## [0.0.4] - 2026-08-20

### Added

- Player information, team information, and general NFL statistics skills.
- A read-only team player tool with an explicit Sleeper source limit.
- The `/exit` command with `/quit` and `/q` aliases.
- Grouped skill output for NFL information, fantasy decisions, and research.

### Changed

- The command palette now starts with the eight most common user tasks.
- The command catalog now uses seven task-based sections.
- Primary commands now use `/context`, `/source`, `/usage`, `/next`, `/export`, and `/shell-completion`.
- Earlier command names remain available as aliases.
- Skill completions now show each skill title and purpose.
- Seb now supports non-fantasy NFL research without adding unwanted fantasy advice.
- Trade and weather skills now route requests to explicit data tools.
- Skill actions now use editable placeholders when required context is missing.

### Fixed

- Skill completion now stops after one valid skill.
- Active skill actions now appear before optional setup actions.
- Weather tools now report the nflverse preseason limit and return a labeled home-stadium outlook.
- The `POST` schedule filter now includes nflverse playoff stage values.


## [0.0.3] - 2026-08-20

### Added

- A live slash-command palette with fuzzy matches and contextual argument values.
- A multiline prompt editor with cursor movement, word deletion, bracketed paste, and prompt recall.
- A private prompt history file with search, clearing, and an environment opt-out.
- A categorized command palette with recent commands, active values, previews, and warnings.
- Number-key selection for contextual suggestions.
- Retry, edit, copy, open-source, history, shortcut, theme, and icon commands.
- Persistent context and source-freshness badges.
- Decision confidence bars and terminal charts for supported analysis fields.
- Default, high-contrast, compact, no-color, Unicode, and ASCII display modes.
- OSC 8 source links and OSC 52 clipboard support.
- Friendly model and tool progress with elapsed times.
- Interactive Sleeper league and roster discovery commands.
- Gemini Google Search and URL Context tools for current public reporting.
- The Gemini Interactions endpoint for grounded source records.
- A versioned and validated fantasy analysis object for JSON output.
- Optional local AI SDK DevTools with a production safety check.

### Changed

- Setup profiles now store only a global NFL season instead of one fantasy roster.
- Version 1 profiles migrate to the team-independent version 2 schema.
- The project now uses the latest AI SDK 7.0.71 and TUI 1.0.72 releases.
- The agent now prunes old tool data before long model requests.
- Model middleware now gives each data tool valid input examples.
- The command line, interactive interface, and connectors now show grounded web sources.
- The agent now treats tool results and web pages as untrusted data.
- Seb now owns the terminal renderer while the AI SDK controls the agent transport and message loop.
- Interactive setup remains team-independent until the user selects session context.

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
