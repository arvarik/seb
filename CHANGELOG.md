# Changelog

This file records each user-visible Seb release.

The project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Auto-Bundled Newsroom Checks Inside Decision Tools (`bundleCandidateNewsChecks`)**: Automatically executes parallel, exact-name first-class newsroom searches inside `compareStartSit`, `optimizeRosterLineup`, `rankWaiverTargets`, and `analyzeTradeImpact` (plus `runWeeklyPortfolioBrief`), expands `bundledNewsChecks` in `buildRecommendationEvidence` so start/sit, lineup, waiver, and trade recommendations clear the Decision Gate in a single tool call, and resolves NFL D/ST aliases (`"Seattle Defense"`, `"SEA D/ST"`) through `TeamIdentityRegistry`.
- **Multi-League Weekly Autopilot (`seb brief`, `/brief`, `runWeeklyPortfolioBrief`, `--post`)**: Fans out deterministically across active Sleeper leagues in parallel with per-league fault isolation, best-ball (`best_ball: 1`) and `disable_adds: 1` support, open-bench drop checks, action-center alerts, exact combinatorial lineup swaps, owner-perspective matchup win probabilities, top waiver/FAAB claims, forecast shifts, and deduplicated newsroom checks—with `--json`, `--no-progress`, and platform-native `--post slack|discord|telegram|groupme [--channel ID]` formatting (`SlackFormatConverter`, `TelegramFormatConverter` `MarkdownV2`, `markdownToPlainText`).
- **Zero-UUID `seb resume`, Session Working Memory & SQLite Forecast Diffs**:
  - Support bare `seb resume` (preferring the latest real conversation over local-command-only sessions), numeric index (`seb resume 1` matching `seb sessions [--json]`), unique ID prefix, and case-insensitive title, full-transcript, league, or tracked-player search alongside exact session UUIDs.
  - Persist bounded `SessionWorkingMemory` across long interactive sessions and saved snapshots—folding each evicted turn at most once while preserving negations in preferences, tracking multi-player comparisons/trades, and skipping ungrounded `Decision unavailable` blocks (inspectable via `/memory [clear]`).
  - Save user-confirmed notes across sessions in `~/.config/seb/memory.json` (`/remember [NOTE]`, `/forget <NUMBER|all>`, `/memory`) for the terminal, `seb ask`, and connector direct messages. A newer preference replaces an older one with the same key (`risk`, `faab`, `avoid:<topic>`), session preferences override saved notes, and decisions keep their season, week, and league, so only current-week decisions reach the model.
  - Persist deduplicated `player-projection` snapshots in SQLite (`PlayerProjectionService.project`) with SHA-256 leaf provenance manifests (`createDirectProvenanceManifest`), in-flight concurrency deduplication, historical-window isolation, and compact `forecastShifts` surfaced to the LLM.

## [1.1.3] - 2026-10-29

### Fixed

- **Decision Gate False Blocks & Targeted Recovery**:
  - Ignore negated recommendation disclaimers (such as `"do not make any player recommendations"` or `"no player recommendations"`) in `questionRequestsRecommendation` unless an affirmative decision question is also present.
  - Recognize pure all-option refusals (such as `"None of the three can fill your Week 8 flex"` or `"Don't start any of the three"`) in `answerWithholdsOrClarifies` without triggering a wasted recovery pass or `Decision unavailable`.
  - Allow healthy kept starters in zero-swap `optimizeRosterLineup` runs to satisfy status evidence via fresh league/newsroom verification while still requiring explicit beat-news coverage for injured starters and swap candidates, and surface `missingStatusSubjects` in `buildRecommendationRecoveryPrompt` so recovery passes know which players lack reporting checks.
  - Scope open-ended waiver follow-up projections (`rankWaiverTargets` + `projectPlayers`) to the top 3 projected waiver candidates rather than requiring individual headlines for every rostered comparison player or unprojected position slice.
- **Structured `seb ask --json` Confidence Grounding & Recovery**: Run single-pass Decision Gate recovery during `seb ask --json` research when needed, forward extracted tool `confidence` metadata to the structured formatter, and ground `analysis.confidence` to the returned tool confidence score rather than invented formatter defaults.
- **Interactive `seb resume` Hygiene**: Persist `localOnlyMessageIds` in saved session snapshots, filter historical local-only slash turns (such as `/help`, `/doctor`, and `/stats`) from resumed LLM prompts and `seb sessions` titles, and strip deprecated `rawInput` fields from legacy `output-error` tool parts before `validateUIMessages`.
- **Connector Chunking & Judgment Span Metadata**: Attach `seb.version` to all Judgment root spans alongside `seb.connector.platform`, `seb.connector.channel_id`, and `seb.connector.user_id` on `seb.connector.reply` traces, and skip whitespace-only tail chunks in `postConnectorResponse`.

## [1.1.2] - 2026-10-28

### Added

- **Self-Healing Decision Gate Recovery (`buildRecommendationRecoveryPrompt`)**: Automatically executes one recovery pass across interactive sessions, `seb ask`, and chat connectors when a recommendation is blocked by missing or stale context, clearing stale Sleeper, news, and weather caches first before withholding advice.
- **Auto-Resolved Single-League Context & Slot Inference**: Automatically resolves league scoring settings when a queried player belongs to a single owned Sleeper league, infers the narrowest compatible flex slot (`WRRB_FLEX`, `REC_FLEX`, `WRTE_FLEX`, `FLEX`, `WRRBTE_FLEX`, `SUPER_FLEX`) in `compareStartSit`, and surfaces bench projections (`bench`) in compacted `optimizeRosterLineup` outputs.
- **GroupMe Setup Guide (`docs/connectors/GROUPME.md`)**: Step-by-step setup documentation for GroupMe bots, `?secret=` webhook authentication, thread subscription, and 1,000-character chunking.

### Changed

- **Full Documentation Modernization**: Overhauled `README.md` and all guides under `docs/` with architecture and pipeline Mermaid diagrams, unified configuration/CLI/skill tables, accurate connector environment precedence, and updated storage, data-source, and forecasting specifications.
- **Context Compaction & Tool-Call Receipts**: Replaced aggressive context drops with two-pass interactive turn compaction (preserving up to 3 uncompacted recent turns within the 120k-character budget) and `[Verified tool calls in this turn (outputs compacted): ...]` summaries so follow-up challenges retain prior grounding receipts.
- **News Discovery Resilience**: Enforced bounded per-source (`8s`) and total search (`20s`) deadlines in `NewsClient`, single-attempt feed discovery, and a 30-category cap per RSS/Atom item so verbose feeds never fail schema validation.

### Fixed

- **Recommendation Eligibility Edge Cases**:
  - Scope open-ended waiver checks (`rankWaiverTargets` + `getRosterPlayers`) to recommended targets rather than all existing rostered players, and treat successful zero-headline news searches as verified silence rather than missing coverage.
  - Detect retired or teamless players (`team: null`) and illegal/nonexistent explicit slots (such as `Superflex` in single-QB leagues) so verified refusals pass cleanly without triggering `DECISION UNAVAILABLE`.
- **Provider Fallbacks & Diagnostics**: Preserve provider-specific fallback model families (`gemini-flash-lite`, `claude-haiku`, `gpt-mini`) on provider-only overrides (`/provider`, `--provider`), and replace forced `toolChoice` in `seb doctor` when probing Anthropic thinking models.
- **Connectors & Judgment Telemetry**:
  - Preserve incoming user turn order in `buildPrompt` and monotonic `dateSent` timestamps in `createGroupMeAdapter` when coarse integer-second webhooks arrive within the same second as bot reply chunks, and strip `## Evidence` appendices from compacted connector history.
  - Record single-turn root `input` payloads in Judgment interactive/connector traces and clamp Gemini hosted-search server-tool span timestamps within parent LLM spans.
- **Environment Template Validation**: Use strict `'true'`/`'false'` boolean literals for `SEB_SESSIONS` and `SEB_HISTORY` in `.env.example` so `seb configure --import-env` succeeds without validation errors.

### Dependencies

- Upgrade `ai` to `7.0.156`, `@ai-sdk/anthropic` to `4.0.91`, `@ai-sdk/google` to `4.0.107`, `@ai-sdk/openai` to `4.0.104`, `@ai-sdk/openai-compatible` to `3.0.80`, `@ai-sdk/otel` to `1.0.156`, and `@ai-sdk/devtools` to `1.0.59`.
- Upgrade `chat` and `@chat-adapter/*` (`discord`, `slack`, `telegram`, `state-memory`, `state-redis`, `tests`) to `4.43.0`.
- Upgrade `judgeval` to `1.5.0`, `hono` to `4.13.14`, `oxlint` to `1.90.0`, and `@types/node` to `26.6.6`.

## [1.1.1] - 2026-10-15

### Added

- **Constrained Roster Lineup Optimizer (`optimizeRosterLineup`)**: Deterministically assigns owned roster players across Sleeper starter, flex, and superflex slots (`QB`, `RB`, `WR`, `TE`, `FLEX`, `WRRB_FLEX`, `REC_FLEX`, `SUPER_FLEX`, `IDP_FLEX`, `K`, `DEF`) using maximum-weight assignment, locking completed and in-progress games and reporting `recommendedSwaps`, `expectedGain`, and `optimalTotalPoints`.
- **Same-Game Stack & Bring-Back Covariance (`sameGameCorrelation`)**: Models bivariate Gaussian covariance ($\rho$) for same-team QB/pass-catcher stacks (`+0.32`), opposing QBs (`+0.20`), same-game pass-catcher bring-backs (`+0.14`), and offensive vs. opposing `DEF` (`-0.25`) in `compareProjections`, `projectLeagueMatchup`, and Monte Carlo `simulatePlayoffOdds`.
- **Cross-Source News Event Clustering (`corroboratedBy`)**: Groups multi-outlet coverage of the same player/team story within a 36-hour window into a single primary article with `corroboratedBy` outlet tags and `+8`/`+12` multi-source ranking boosts.
- **SQLite FTS5 BM25 News Search (`news_articles_fts`)**: Indexes fetched news articles in a Porter-tokenized SQLite FTS5 virtual table (`rank = bm25(news_articles_fts, 5.0, 2.0, 1.0, 3.0)`) for sub-millisecond relevance-ranked local recall before network RSS/sitemap fetches.

### Fixed

- **Lineup Optimization & Recommendation Gate**:
  - Lock bench players whose real-world NFL game has already kicked off (`kickoff <= now`) in `optimizeRosterLineup`, reject duplicate starter IDs, stabilize kept starter slot assignments to prevent false swap chains, and check per-player `recommendationEligible` across optimal starters.
  - Scope `optimizeRosterLineup` recommendation gate checks to recommended swap targets (`startPlayer`) so unverified bench or sit players do not block valid lineup advice, and allow roster-verified healthy players without redundant injury-status warnings.
- **Correlated Projections & Playoff Simulation**:
  - Verify mutual schedule alignment (`a.opponent === b.team && b.opponent === a.team`) in `sameGameCorrelation`, canonicalize player pair ordering in `simulatePlayoffOdds` to prevent inverted correlation matrices, and include `WRRBTE_FLEX` and `WRTE_FLEX` in `compareStartSit`.
  - Guard `WaiverAssistantService` weekly scoring loops against atypical Sleeper roster rows with missing positions.
- **News Clustering, FTS5 & Cache Consistency**:
  - Enforce team/topic overlap and a 36-hour window on normalized title clustering, prefer non-stale primary articles in `deduplicateArticles`, and distinguish ESPN/Yahoo/NFL wire origins from team feeds in `publisherIdentity`.
  - Align `hasQueryTokenMatch` with FTS5 Porter stemming, re-index HTML-enriched and multi-team sitemap articles into `news_articles_fts`, and synchronize FTS5 rows when `CachedResource` deletes or prunes expired `news:` entries.
  - Enforce `ttlMs` and `staleIfErrorMs` expiration bounds on `CachedResource` L1 memory hits, include `defense-` keys in `NflverseClient.clearCache('stats')`, and preserve `active` flags in player identity seed preparation.
- **Agent Harness, Interactive TUI & Connectors**:
  - Preserve active-turn reasoning and provider signatures in `pruneFantasyMessages` for Thinking-enabled Anthropic and Google models, and strip prior-step `cacheControl` markers so multi-step loops never exceed Anthropic's 4-breakpoint limit.
  - Guard character-budget forced `conclude` with `stepNumber > 0`, preserve `Skill instructions: ` prefixes when omitting unavailable news commands, and refresh `news` caches in interactive `/refresh`.
  - Refresh connector runtime context before early command returns and validate GroupMe message length and prefix boundaries.

## [1.1.0] - 2026-10-15

### Added

- **GroupMe Chat Connector (`src/connectors/groupme.ts`)**: First-class Chat SDK adapter for GroupMe league group chats with timing-safe `GROUPME_WEBHOOK_SECRET` verification, `@bot` mention detection, and 1,000-character plain-text message chunking.
- **Expanded First-Class News Registry (`47` live-verified sources)**: Added **Pro Football Rumors** (`profootballrumors`), **NFL Trade Rumors** (`nfltraderumors`), **Draft Sharks Shark Bites** (`draftsharks`), and **RotoBaller Fantasy Football** (`rotoballer`) RSS feeds, plus an explicit 3-tier source priority hierarchy (`NewsSourceTier = 1 | 2 | 3`) and `<category>` tag matching.

### Changed

- **Agent Harness & Token Optimization**:
  - Preserve KV prefix cache stability on the final `conclude` step by returning `{ activeTools: [] }` without mutating system instructions.
  - Enable Anthropic ephemeral prompt caching (`cacheControl: { type: 'ephemeral' }`) on system instructions.
  - Prune intra-turn intermediate reasoning parts from prior tool steps while preserving provider signatures.
  - Replace $O(N^2)$ `JSON.stringify` prompt-fitting loops with an $O(N)$ character estimator and reduce `MAX_AGENT_STEPS` from `32` to `16`.
  - Add `toModelOutput` token compaction to `searchFirstClassNews`, `projectLeagueMatchup`, `getLeagueOverview`, and `getPlayerWeeklyStats` (~45–60% token savings on tool results while keeping `execute` outputs intact).
- **Performance, Projections & Recommendation Eligibility**:
  - Add an in-memory L1 Map cache in `CachedResource` (`max 256` entries) with cross-process generation validation to avoid repeated SQLite reads and JSON/Zod parsing on hot data paths.
  - Add a fast path for HTML entity decoding in `cleanText` and memoize parsed `RobotsPolicy` instances per origin in `NewsClient`.
  - Skip per-article HTML metadata downloads for dated news-sitemap entries (`nfl`, `team-was`) that have zero query token matches.
  - Pool positional empirical residual quantiles across games in `PlayerProjectionService` to unlock calibrated 80% uncertainty intervals earlier in the season.
  - Separate `inProgressPoints` from `completedPoints` and `projectedRemainingPoints` in `projectLeagueMatchup` for live in-progress NFL games.
  - Enrich `TradeImpactService` and `WaiverAssistantService` with nflverse special-teams return yardage when leagues score individual return yards.
  - Scope `recommendation-eligibility.ts` player status and news verification to recommended/starter subjects so one unverified bench player does not block an entire answer.
  - Check neutral-venue games before roof type in `GameWeatherService` so neutral indoor games return `neutral-venue-unmapped` consistently.
- **Terminal UI/UX & CLI**:
  - Fix restored session tool activity duration bugs (`1792106340s`), preserve viewport scroll offsets when expanding/collapsing tool rows on click, and reveal prompt suggestions when switching experiences or skills.
  - Enforce `SEB_ICONS=ascii` consistently across markdown bullets, quotes, code fences, links, and table borders.
  - Preserve existing saved Sleeper accounts in `seb setup <username>` and share the default SQLite cache in `seb learn`.
  - Add `TELEGRAM_ALLOWED_USER_IDS` validation, cached connector runtime context (60s TTL), compacted connector thread history, and markdown-link-safe message splitting across Discord, Telegram, and GroupMe.

### Dependencies

- Remove `string-width` and `robots-parser` runtime dependencies (`-30` transitive packages in `node_modules`) in favor of native `Intl.Segmenter` grapheme width calculation and an inline ESM RFC 9309 robots policy parser.
- Upgrade `ai` to `7.0.142`, `@ai-sdk/google` to `4.0.98`, `@ai-sdk/openai` to `4.0.95`, `@ai-sdk/anthropic` to `4.0.81`, `@ai-sdk/openai-compatible` to `3.0.70`, `@ai-sdk/otel` to `1.0.142`, and `@ai-sdk/devtools` to `1.0.45`.
- Upgrade `chat` and `@chat-adapter/*` packages to `4.42.0`, `hono` to `4.13.13`, `@hono/node-server` to `2.1.5`, `zod` to `4.6.7`, `csv-parse` to `7.0.3`, `judgeval` to `1.3.5`, `tsx` to `4.23.15`, `oxlint` to `1.88.0`, `@types/node` to `26.6.5`, and `vitest` / `@vitest/coverage-v8` to `5.0.5`.

## [1.0.2] - 2026-09-10

- Add scoring-aware D/ST forecasts from completed NFL plays and official weekly team totals.
- Separate defense, team special teams, and individual special teams. Apply points-allowed exclusions and net-yardage tiers.
- Blend team and opponent outcomes with NFL averages. Shrink rare touchdowns and disclose uncalibrated forecast ranges.
- Add a reproducible defense benchmark and document scoring sources, assumptions, and accuracy limits.
- Expand purple tool rows on click. Expand grouped calls into identifiable rows, then open each call for details.
- Align the Docker configuration folder with its persistent volume so profiles and resumed conversations survive container replacement.
- Save private conversations with stable identifiers. Print a resume command on exit and add `seb resume <id>` and `seb sessions`.
- Preserve failed questions, completed tool results, and answer evidence across resumes. Never replay unfinished approvals.
- Simplify the header and home page. Show the model name and three rows of skill names. Remove redundant prompt instructions.
- Preserve active-turn research and provider signatures across long tool conversations.
- Raise the model-step limit to 32 and reserve a final answer with Gemini function calling explicitly disabled.
- Add batch player projections with bounded concurrency and explicit missing-player results.
- Calculate matchup subtotals from verified weekly starters and completed scores instead of asking the model to add player points.
- Calculate kicker projections from made, missed, and blocked kicks, distance ranges, and yardage rules.
- Fix punctuation and suffix matching, recover from missing current-season statistics, and exclude current injuries and teams from historical forecasts.
- Map nflverse Rams team codes consistently so schedules, opponents, and weather remain available.
- Resolve defense names without searching unrelated players. Keep missing scores and unsupported scoring rules explicit.
- Mark partial scoring and historical baselines so batch results cannot claim complete weekly scores.
- Reject duplicate opponent data and invalid comparison ranges. Explain invalid local learning data without exposing its contents.
- Keep failed questions for natural retries without resending partial answers or approval state.
- Allow editable drafts and one queued prompt while a response runs. Preserve drafts after failure or cancellation.
- Collapse embedded and duplicate evidence sections into one line per answer. Keep full evidence in sources, copy, and exports.
- Add space below the input and distinguish data limitations from model provider errors.

## [1.0.1] - 2026-09-08

### Added

- Continuous Delivery release pipeline (`.github/workflows/release.yml`) automating verification, npm publishing with cryptographic SLSA provenance, Docker image builds to GitHub Container Registry (`ghcr.io`), and GitHub Releases.
- Containerization support with a production `Dockerfile` and `.dockerignore` for zero-install Docker execution without requiring Node.js 22 on the host machine.
- Scoped package naming (`@arvarik/seb`) for public npm registry distribution and zero-install execution via `npx @arvarik/seb`.

### Changed

- Streamlined and modernized `README.md` with concise marketing structure, 30-second quickstart, and decision safeguards overview.
- Optimized Dependabot configuration to consolidate minor and patch dependency updates into a single weekly pull request and ignore breaking `vitest` major updates.

### Dependencies

- Bump `@ai-sdk/anthropic` to 4.0.49, `@ai-sdk/google` to 4.0.64, `@ai-sdk/openai` to 4.0.60, `ai` to 7.0.93, and `@ai-sdk/devtools` to 1.0.15.
- Bump `hono` to 4.13.7, `zod` to 4.5.4, `tsx` to 4.23.13, and `oxlint` to 1.82.0.
- Bump dev dependency `@types/node` to 26.4.1.

## [1.0.0] - 2026-09-08

### Added

- Apache-2.0 licensing, contribution and security guides, community templates, and a documented version 1 interface policy.
- Linux and macOS CI coverage, outdated-run cancellation, weekly dependency updates, and synchronized setup versions.
- Scoring-aware forecast ensembles, uncertainty intervals, legal-slot starter comparisons, and exact offensive trade lineups.
- Seeded playoff qualification simulations with complete historical and future schedule checks.
- Explicit local weekly learning with chronological validation, bounded overrides, immutable revisions, and player and team summaries.
- A weekly-learning skill, inspection tools, `seb learn`, `seb evaluate`, and historical benchmark reports.

### Fixed

- Validate kickoff calendar dates and reject nonexistent or ambiguous daylight-saving times. Reuse the time-zone formatter.
- Reconstruct historical standings from valid opponent pairs and completed scores. Count median matches separately from weekly scoring and opponent averages.
- Apply Sleeper playoff tiebreakers in order: record, points scored, higher points against, then a random draw for exact ties.
- Score exclusive yardage bonus tiers correctly. Include supported fumbles, conversions, reception premiums, and special-teams scores.
- Reject malformed scoring weights, missing required statistics, nonfinite scores, ambiguous identities, duplicate weeks, and future training data.
- Check current player status, kickoff, league scoring, and relevant news before permitting starter recommendations.
- Use valid kickoff forecast periods and exclude target-game historical weather from past forecasts. Apply alert risk only inside a verified kickoff window.
- Support IDP slots and guarded active-player identity matching after team changes.
- Preserve league identifiers in large prompts. Cancel stalled model operations and source waits without interrupting other callers.
- Distinguish intermediate tool steps from final completion. Warn about partial one-shot text and withhold incomplete recommendations.
- Keep JSON research and formatting strict. Match eligibility evidence to the executed tool inputs and selected league.
- Isolate request circuits by origin. Use one canonical Sleeper player cache and apply player filters locally.
- Reject stale fallback data after its deadline and preserve evidence for distinct source requests.
- Normalize CLI value options and help aliases. Show progress while checking buffered answers.
- Remove untrusted terminal commands across streaming chunk boundaries. Serialize history saves with unique private temporary files.
- Bound profile, history, and learning reads before allocating file contents.
- Clamp FAAB ranges to actual budgets and explain league minimum bids. Preserve priority-waiver rules and stable candidate scores.
- Split Discord and Telegram replies within platform limits and show sanitized model errors.
- Keep capacity fallback within the original provider and deadline. Cancellation, timeouts, and visible output prevent a retry.

### Dependencies

- Update the Chat SDK core and all installed adapters to 4.40.0, including the shared test adapters.
- Update the OpenAI-compatible provider to 3.0.44 and both GitHub Actions to v7.
- Group related dependency updates. Retain Vitest 4 with matching coverage until the Chat SDK test package supports Vitest 5.

### Documentation

- Replace the old V1 design with implemented scope, explicit limits, and a separate future roadmap.
- Update provider family defaults, identity transfer rules, completion behavior, storage guarantees, and release instructions.
- Explain forecast uncertainty and model fallibility without claiming guaranteed accuracy.

## [0.2.3] - 2026-09-07

### Added

- Model families select the newest stable version from the provider catalog. Setup saves the family, while each run uses a resolved model ID.
- Google, Anthropic, and OpenAI primary and fallback defaults use model families. Exact IDs remain pinned.
- Model discovery reads complete catalogs with pagination, a timeout, size limits, and redirect rejection. Offline Doctor skips discovery.

### Changed

- Evidence uses one blue summary line with a `/sources` hint. The source command shows full details. Copy commands and exports retain the evidence text.

## [0.2.2] - 2026-09-07

### Fixed

- Tool activity uses compact rows. Consecutive successful calls to the same tool share a count and total duration.
- Mouse selection extends across the conversation when you hold the pointer at the top or bottom edge.
- Selection retains a stable transcript while new response content arrives. Resizing clears the selection safely.
- `/copy all` copies the full conversation without screen wrapping or the previous clipboard length cutoff.
- `/select` prints the full conversation to normal terminal scrollback for native selection. Escape returns to Seb.

## [0.2.1] - 2026-09-07

### Fixed

- Escape stops stalled requests, including requests that still wait for provider setup. Cancelled responses show an incomplete-response notice.
- Completed answers preserve the reading position when the user scrolls through the transcript.

- New prompts keep earlier answers in the terminal transcript. Approval continuations retain the same answer ID.
- Sleeper league users accept a null commissioner flag. This restores league overview, analysis, and matchup estimates for affected leagues.
- Tool errors distinguish invalid inputs, unavailable tools, and Sleeper failures from model provider failures.

### Changed

- Provider reasoning appears in a separate, muted transcript section. Progress labels distinguish thinking, reasoning, and answer writing.
- The busy prompt shows that a response is in progress. Tool indicators stop when a request ends.

- Prompt entry draws one frame per input chunk, restores drafts after history navigation, and ignores duplicate submission keys.
- Long prompts use at most five editor rows to keep the transcript visible.
- Team-name questions use a direct Sleeper league-member lookup without score analysis or web search.

## [0.2.0] - 2026-09-01

### Added

- Seb now supports Google Gemini, Anthropic, OpenAI, and OpenAI-compatible model providers.
- `seb configure` now collects or reuses provider access, a primary model, and a fallback model through a masked terminal flow.
- `seb chat` and `seb ask` now accept `--provider` and `--model` overrides.
- `/provider` and `/model` now show or switch the active model configuration during an interactive session.
- Private credential and non-secret model settings stores now use validated, bounded, atomic local files.

### Changed

- Every model provider can use the 44 built-in first-class news sources.
- Google Search and URL Context remain available only with the Google provider.
- The doctor now checks the selected provider with a forced local tool loop. The Google check also requires one grounded Search source.
- Connector services now select providers, models, and fallback models from environment variables.
- Provider-only overrides keep the configured fallback. Explicit CLI and slash model overrides use one model without a separate fallback.
- Usage reports and safe error messages now identify the active provider without storing model content or raw errors.

### Security

- Model settings store no API keys. Private keys use a separate file with mode `0600` on Unix systems.
- Seb binds each saved OpenAI-compatible key to one canonical endpoint. A changed endpoint never receives the old key.
- Configuration saves use bounded file reads, atomic replacement, and a short local commit lock.
- Model configuration prompts mask keys and never add them to chat or prompt history.
- Interactive model and provider commands redact their arguments from the visible transcript and prompt history.
- Remote OpenAI-compatible endpoints require HTTPS and explicit approval during interactive configuration.
- OpenAI-compatible URLs reject embedded credentials, query strings, fragments, and individual completion endpoint paths.
- OpenAI-compatible model and discovery requests reject redirects to another origin.
- Current-directory `.env` files cannot select a provider, custom endpoint, private storage path, or DevTools recording.

### Testing

- Mock tests cover provider selection, provider construction, model switching, configuration prompts, storage, connector routing, and provider-neutral errors.
- Live Anthropic, OpenAI, and OpenAI-compatible credentials are not required by the unit test suite.

## [0.1.2] - 2026-09-01

### Added

- `seb usage` and `/usage` now show concise local Gemini API usage.
- `seb stats` and `/stats` now show detailed token, latency, model, and tool analytics.
- Usage and stats JSON reports now use stable schema version 1.
- SQLite schema 6 now stores local agent runs, logical model steps, and tool calls.
- `seb stats prune` and `seb stats clear` now remove saved usage telemetry. They preserve unfinished runs unless users add `--include-unfinished`.
- Usage reports now show the successful run rate, safe error categories, and failures after a returned client tool.

### Changed

- The production agent now uses the standard Gemini `generateContent` endpoint.
- The doctor and live answer contract now verify a streaming local tool result before final model text.
- Interactive model history now has message, character, and prompt limits.
- Source tracking now limits live records, per-answer sources, and saved answer snapshots.

### Fixed

- Gemini tool loops no longer fail after a successful local tool result.
- Interactive provider failures now show a safe action instead of `An error occurred.`
- Failed answers no longer replace the last complete answer, update the active subject, or append a normal Evidence section.
- Failed prompts and partial assistant output no longer enter the next model request.
- Tool approvals now preserve the original question, evidence, and tool results through continuation.
- A pending tool approval no longer replaces the last complete answer.
- Provider HTTP timeouts now remain failed provider calls instead of cancellations.
- A transport setup failure no longer closes the interactive session.
- `/league` without an argument now opens the current fantasy dashboard.
- Recursive evidence checks now reject cyclic or deeply nested tool output safely.

### Security

- Local usage telemetry now excludes prompts, answers, tool inputs, tool results, and raw errors.

## [0.1.1] - 2026-08-31

### Changed

- Waiver demand now uses one absolute scale instead of the largest candidate in each request.
- Waiver production now uses position-specific point references instead of the strongest candidate in each request.

### Fixed

- Common start, sit, add, drop, and player comparison questions now enter the recommendation evidence gate.
- Recommendation evidence now matches the requested player and selected league before it permits an action.
- Start and sit recommendations now require an eligible scoring-aware projection.
- Unsupported active scoring rules now make projection, waiver, and trade evidence ineligible for a final action.
- Trade analysis now rejects duplicate players and received packages from different opposing rosters.
- A lone low-production waiver candidate no longer receives maximum production, demand, or FAAB scores.
- News discovery and article metadata now pass their declared schemas before Seb caches them.
- News queries now match common plural-to-singular forms such as `injuries` and `injury`.

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
