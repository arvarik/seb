# Seb

**The source-grounded NFL & fantasy football AI agent. One terminal.**

[![CI](https://github.com/arvarik/seb/actions/workflows/ci.yml/badge.svg)](https://github.com/arvarik/seb/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-1.1.3-informational.svg)](package.json)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=node.js&logoColor=white)](package.json)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Seb unifies real-time NFL beat reporting, live Sleeper leagues, nflverse play-by-play statistics, and National Weather Service stadium forecasts into a single terminal agent and group-chat bot.

Unlike generic chatbots that guess stats or hallucinate lineups, Seb computes projections, optimal starter assignments, trade impacts, and FAAB tiers with **deterministic math**—and enforces a verification gate before recommending any roster move.

```text
Compare Jayden Daniels and Jared Goff for Week 8 in my league.
Optimize my full Game of Throws lineup and check bench upside.
Rank the top WR waiver targets this week and suggest FAAB bids.
```

---

## Why Seb?

| Capability | What Seb Delivers |
| --- | --- |
| **47 Curated Newsrooms** | 3-tier priority network across all 32 official NFL team feeds, national wires, and fantasy analysts with 36-hour cross-source corroboration and local SQLite FTS5 search. |
| **Instant Sleeper Sync** | Read-only discovery of your leagues, rosters, custom scoring settings, waiver budgets, and active matchup needs—automatically resolving league context when you own a player in one league. |
| **Deterministic Decisions** | Scoring-aware projections (`QB`, `RB`, `WR`, `TE`, `K`, and team `D/ST`), full-roster combinatorial lineup optimization, same-game stack covariance, legal trade validation, FAAB tiers, and Monte Carlo playoff odds. |
| **Self-Healing Evidence Gate** | Verifies player identity, injury status, league slot legality, and fresh news before allowing advice—automatically refreshing stale or missing sources once before ever withholding a call. |
| **Kickoff Weather & Learning** | Live National Weather Service stadium wind/precip/alert checks plus chronological post-week forecast calibration stored locally. |
| **Multi-Provider BYOK** | Run on Google Gemini, Anthropic Claude, OpenAI, or local/OpenAI-compatible endpoints (`Ollama`, `vLLM`, `LM Studio`) with automatic model-family discovery and capacity fallback. |
| **Privacy by Default** | Read-only Sleeper access, `0600` local credential files, metadata-only SQLite usage analytics, and opt-in-only OpenTelemetry tracing. |

---

## Quick Start

### 1. Install

Requires **Node.js 22+**:

```bash
git clone https://github.com/arvarik/seb.git
cd seb
npm ci

# Run directly from source
npm run seb

# Or install globally as `seb`
npm install -g .
```

<details>
<summary><strong>Run with Docker (no local Node.js required)</strong></summary>

```bash
# Pull the prebuilt image from GitHub Container Registry
docker run -it --rm -v ~/.seb:/root/.seb ghcr.io/arvarik/seb:latest

# Or build locally from source
docker build -t seb .
docker run -it --rm -v ~/.seb:/root/.seb seb
```
</details>

### 2. Configure Your Model & Sleeper Account

```bash
# Configure your AI provider and masked API key (~/.config/seb/)
seb configure

# Optional: connect your Sleeper username (read-only)
seb setup your-sleeper-username
```

### 3. Launch

```bash
# Start the interactive terminal UI
seb

# Or run a one-shot query from your shell (add --json for structured output)
seb ask "Optimize my Week 8 lineup and highlight any injury risks"
```

---

## Three Connected Experiences

Switch experiences anytime with `/explore`, `/fantasy`, and `/analyze`—your active player, team, league, and week carry seamlessly across turns.

| Experience | Command | Example Prompts |
| --- | --- | --- |
| **Explore** *(NFL Intelligence)* | `/explore` | *"Show Baltimore's red-zone rushing trends."* · *"What changed on Seattle's latest injury report?"* |
| **My Fantasy** *(Multi-League Hub)* | `/fantasy` | *"What needs my attention across all my leagues this week?"* · *"Which league has my thinnest RB depth?"* |
| **Analyze** *(Protected Decisions)* | `/analyze` | *"Optimize my starting lineup for Week 8."* · *"Evaluate trading Garrett Wilson for De'Von Achane."* |

---

## Interactive Terminal, CLI & Chat Bots

### Interactive Terminal Highlights

- **Slash Palette & Shortcuts**: Press `/` or `Ctrl+K` to search commands, `Ctrl+G` to inspect active league/player context, and `/about [topic]` to inspect Seb's live architecture, projection math, or storage schema.
- **Inspectable Tool Rows**: Click any purple tool row in the transcript to expand its exact JSON inputs and outputs; click grouped rows to inspect individual calls and latencies.
- **Saved & Resumable Sessions**: Exiting prints `seb resume <session-id>`. Run `seb sessions` anytime to list and restore saved conversations, tool details, and source evidence.

### Command-Line Reference

| Command | Purpose |
| --- | --- |
| `seb` / `seb chat` | Launch the interactive terminal UI (supports `--provider` and `--model`). |
| `seb ask "<question>"` | Run a single grounded query from scripts or shell (`--json` supported). |
| `seb configure` | Configure providers, models, or import settings (`--import-env <file>`). |
| `seb setup [username]` | Guided first-run setup or Sleeper username sync. |
| `seb sessions` / `seb resume <id>` | List or restore saved interactive conversations. |
| `seb doctor` | Run all 9 health checks across Node, config, SQLite, permissions, model, and APIs. |
| `seb usage` / `seb stats` | View local token consumption, latency percentiles, and run success rates. |
| `seb learn` | Inspect or update local post-week forecast calibration. |
| `seb evaluate` / `seb replay` | Run historical projection benchmarks and non-leakage walk-forward backtests. |
| `seb cache` / `seb snapshots` | Inspect, refresh, or prune `.cache/seb.sqlite` and SHA-256 source snapshots. |
| `seb completion <shell>` | Generate shell completions for `zsh`, `bash`, or `fish`. |

### League Group-Chat Bots

Run `npm run connectors` to host Seb inside your league's group chat with shared Hono + Chat SDK adapters, 12k-character compacted thread memory, and optional Redis state:

- **Slack** — Socket Mode & Events API webhooks ([Slack Guide](docs/connectors/SLACK.md))
- **Discord** — Gateway bot & HTTP interactions ([Discord Guide](docs/connectors/DISCORD.md))
- **Telegram** — Long polling & secret-verified webhooks ([Telegram Guide](docs/connectors/TELEGRAM.md))
- **GroupMe** — Secret-verified group webhooks with 1,000-char smart chunking ([GroupMe Guide](docs/connectors/GROUPME.md))

---

## Documentation

| Category | Guides |
| --- | --- |
| **Getting Started** | [Documentation Hub](docs/README.md) · [Setup Guide](docs/SETUP.md) · [Persistent Configuration](docs/CONFIGURATION.md) · [Model Providers](docs/MODELS.md) |
| **CLI & Terminal** | [CLI Reference](docs/CLI.md) · [Interactive Guide](docs/INTERACTIVE.md) · [Terminal UI](docs/TERMINAL_UI.md) · [Experiences](docs/EXPERIENCES.md) · [Skills](docs/SKILLS.md) |
| **Chat Connectors** | [Connectors Overview](docs/CONNECTORS.md) · [Slack](docs/connectors/SLACK.md) · [Discord](docs/connectors/DISCORD.md) · [Telegram](docs/connectors/TELEGRAM.md) · [GroupMe](docs/connectors/GROUPME.md) · [Custom Adapters](docs/connectors/CUSTOM_ADAPTER.md) |
| **Architecture & Science** | [System Architecture](docs/ARCHITECTURE.md) · [AI SDK & Telemetry](docs/AI_SDK.md) · [Forecasting & Analysis](docs/ANALYSIS.md) · [Defense & Special Teams](docs/DEFENSE_AND_SPECIAL_TEAMS.md) · [Evaluation](docs/EVALUATION.md) |
| **Data, Storage & Ops** | [Data Sources](docs/DATA_SOURCES.md) · [Identities](docs/IDENTITIES.md) · [Provenance](docs/PROVENANCE.md) · [Storage & Privacy](docs/STORAGE.md) · [Operations](docs/OPERATIONS.md) · [Versioning](docs/VERSIONING.md) |

### Optional Judgment tracing

Seb runs completely offline from Judgment by default (`SEB_JUDGMENT_TRACING=false`) and never loads the `judgeval` exporter unless explicitly enabled. To export OpenTelemetry traces for CLI runs, interactive sessions, and chat connectors to your Judgment `seb` project, import these settings via `seb configure --import-env /path/to/.env`:

```dotenv
SEB_JUDGMENT_TRACING=true
JUDGMENT_API_KEY=<your-judgment-api-key>
JUDGMENT_ORG_ID=<your-judgment-organization-id>
```

> [!WARNING]
> Enabling Judgment tracing exports conversation prompts, model completions, and tool inputs/outputs (which may include league and roster data) to Judgment. Local SQLite usage analytics (`seb usage` / `seb stats`) always remain metadata-only. See [Persistent Configuration](docs/CONFIGURATION.md) and [AI SDK & Telemetry](docs/AI_SDK.md#5-local-usage-telemetry) for full session-grouping, shutdown-flush, and opt-out details.

---

## Contributing & License

Contributions are welcome! Please review [CONTRIBUTING.md](CONTRIBUTING.md), our [Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

Licensed under the [Apache-2.0 License](LICENSE).
