# Seb

**The source-grounded NFL & fantasy football AI agent. One terminal.**

[![CI](https://github.com/arvarik/seb/actions/workflows/ci.yml/badge.svg)](https://github.com/arvarik/seb/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
![Node.js](https://img.shields.io/badge/Node.js->=22-339933?logo=node.js&logoColor=white)
[![Version](https://img.shields.io/badge/version-1.0.1-informational.svg)](package.json)

Seb unifies real-time NFL news, live Sleeper leagues, nflverse statistics, and kickoff weather into a single conversational agent. 

Unlike generic chatbots that guess player stats or hallucinate lineups, Seb uses **deterministic math** for projections and rankings, safeguarding your start-sit, trade, and waiver decisions with verified evidence.

```text
Show Derrick Henry's recent production and latest verified news.
Look deeper into his usage.
Compare him with Saquon Barkley for this week's matchup and weather.
```

---

## Why Seb?

| Feature | What Seb Delivers |
| --- | --- |
| 🏈 **44+ Built-In Newsrooms** | Direct reporting from all 32 NFL team beat sources, official NFL feeds, and fantasy analysts. |
| 🏆 **Instant Sleeper Sync** | Discovers your leagues, rosters, scoring settings, and weekly matchup needs automatically. |
| 🛡️ **Grounded Decisions** | Deterministic projections, legal trade validation, FAAB waiver tiers, and playoff simulations. |
| 📈 **Weekly Learning** | Learns local player performance trends and forecast accuracy after completed games. |
| 🌦️ **Kickoff Weather** | Live game-day forecasts and active severe weather alerts from the National Weather Service. |
| 🤖 **Multi-Provider AI** | Bring your own model: Google Gemini, Anthropic Claude, OpenAI, or local/compatible LLMs. |
| 🔒 **Privacy First** | Read-only league access. Local usage records exclude prompts and answers. Remote Judgment tracing is optional and off by default. |

---

## Quick Start

### 1. Install

Requires Node.js 22+:

```bash
# Clone the repository
git clone https://github.com/arvarik/seb.git
cd seb
npm ci

# Option A: Run directly from source
npm run seb

# Option B: Install globally from source (available anywhere as `seb`)
npm install -g .
```

<details>
<summary>🐳 <strong>Run with Docker (no local Node.js required)</strong></summary>

```bash
docker build -t seb .
docker run -it --rm -v ~/.seb:/root/.seb seb
```
</details>

### 2. Configure

Run the interactive setup to securely configure your AI provider:

```bash
seb configure
```
*Keys are masked in the terminal and stored in a private local credentials file.*

### 3. Connect Sleeper

Link your Sleeper username for personalized fantasy intelligence:

```bash
seb setup your-sleeper-name
```
*Seb only reads league data; it never modifies lineups, trades, or settings.*

### 4. Launch

```bash
seb
```

Or ask a one-shot question directly from your shell:

```bash
seb ask "Compare my flex options for this week"
```

---

## Three Connected Modes

Switch seamlessly between modes using `/explore`, `/fantasy`, and `/analyze`:

### 🔍 Explore (NFL Intelligence)
Deep NFL research without needing a fantasy account.
* *"Show Baltimore's recent offensive trends and red zone usage."*
* *"What changed in the latest verified Seahawks injury report?"*
* *"Compare rushing usage and snap share for these two running backs."*

### 🏆 My Fantasy (Multi-League Overview)
Connect your Sleeper account to monitor all your leagues in one view.
* *"What needs my attention across my leagues this week?"*
* *"Show urgent news for players across my active rosters."*
* *"Which of my leagues has the weakest running back depth?"*

### 📊 Analyze (Protected Decisions)
Turn research into winning start-sit, trade, and waiver actions.
* *"Compare my flex options for Week 2 in full PPR."*
* *"Rank these waiver targets and recommend FAAB bid ranges."*
* *"Review this trade proposal for my Dynasty league."*

---

## CLI & Bot Connectors

### Command-Line Tools

| Command | Description |
| --- | --- |
| `seb` | Launch the full interactive terminal interface. |
| `seb ask "..."` | Ask one-shot questions from scripts or shell (supports `--json`). |
| `/about [topic]` | Inside chat, inspect Seb's architecture, projection formulas, storage schemas, and design principles. |
| `seb doctor` | Validate active model provider, local cache, and public APIs. |
| `seb usage / stats`| Inspect local token usage, response latency, and run success rates. |
| `seb learn` | Review adaptive forecast accuracy and completed-week parameter updates. |
| `seb cache clear` | Manage or prune the local SQLite cache. |

### League Chat Bots

Deploy Seb directly into your league's group chat! Seb includes built-in read-only connectors for:
* **Slack** (Socket Mode & Webhooks)
* **Discord** (Bot client)
* **Telegram** (Bot polling)

See the [Chat Connectors Guide](docs/CONNECTORS.md) for step-by-step bot setup.

---

## How Seb Protects Your Decisions

Generic AI models often hallucinate injury reports or miscalculate fantasy points. Seb prevents this through a 4-step safety architecture:

1. **Resolve**: Resolves the exact player, team, roster, and league scoring rules.
2. **Gather**: Pulls live facts from Sleeper, nflverse, NWS weather, and 44+ newsrooms.
3. **Compute**: Deterministic functions compute projections, trade impacts, and ranking scores.
4. **Validate**: A safety gate verifies that all facts match the requested player and league. If facts are missing or conflicting, Seb withholds the action rather than guessing.

### Transparent Limits
* **Offensive Focus**: Projections and lineup comparisons currently support offensive skill positions (QB, RB, WR, TE, K).
* **Public Latency**: News and nflverse game logs rely on public feeds and can lag breaking live game events.
* **Weather Coverage**: NWS weather forecasts cover United States venues only.

---

## Documentation

### Optional Judgment tracing

Seb works without a Judgment account. Tracing stays off unless you explicitly enable it.
When tracing is off, Seb does not load the Judgment SDK or send data to Judgment.
Adding credentials alone does not enable tracing.

To enable tracing, add these values to a dotenv file for explicit import, or to your service environment:

```dotenv
SEB_JUDGMENT_TRACING=true
JUDGMENT_API_KEY=<your saved Judgment API key>
JUDGMENT_ORG_ID=<your Judgment organization ID>
```

Git ignores `.env` and its variants, such as `.env.local`. The repository tracks only `.env.example`.

Import the file once with `seb configure --import-env /absolute/path/to/.env`.
Review the setting names and confirm the import. Seb masks secrets in the preview.
Saved settings apply from any directory. Seb does not load a current-directory `.env` automatically.
Use `seb configure` to edit Gemini credentials, models, Judgment settings, and other supported settings.
See [Persistent configuration](docs/CONFIGURATION.md) for storage, security, and override rules.
Use your own organization ID. Seb sends traces to the `seb` project in that organization.
Seb loads the environment before it initializes tracing once per process.
Every span in a traced request carries the same `judgment.session_id`, including model calls, tool calls, and streaming work.
Missing credentials or initialization failures produce a warning, and Seb continues without tracing.

**Enabling tracing exports conversation content.** Judgment receives prompts, answers, model calls, tool inputs and outputs, and error information.
This content can include league data and personal information that appears in a conversation or tool result.
Seb does not pass its environment or credential configuration to trace wrappers.
Local usage records keep their existing metadata-only format.

Tracing covers CLI questions, structured answers, interactive agent turns, and connector replies.
Each interactive conversation and connector thread groups related traces into a session.
Model and tool spans come from the AI SDK integration. Stream roots remain open until consumption ends or the consumer cancels.
Seb records up to 128,000 characters of final text on each root. Child spans can contain additional content.
Seb flushes completed roots and shuts down tracing when the CLI or connector service stops normally.
An immediate forced exit, including a broken output pipe, can lose queued traces.

Set `SEB_JUDGMENT_TRACING=false` or remove it, then restart Seb, to disable tracing.
`JUDGMENT_MONITORING=false` also disables tracing at startup.

After installing dependencies, verify one normal request and one cancelled request in Judgment.
Check the `seb` project, session grouping, model and tool children, final output, and trace health results.
An initialization message alone does not prove that export works.
See the [Judgment tracing guide](https://docs.judgmentlabs.ai/documentation/tracing)
and [AI SDK integration](https://docs.judgmentlabs.ai/documentation/integrations/agent-frameworks/vercel-ai-sdk).

### Guides

* **Getting Started**: [Setup Guide](docs/SETUP.md) · [Terminal UI Guide](docs/TERMINAL_UI.md) · [Model Configuration](docs/MODELS.md)
* **Features**: [Interactive Experience](docs/INTERACTIVE.md) · [CLI Reference](docs/CLI.md) · [Skills Guide](docs/SKILLS.md)
* **Integrations**: [Chat Connectors](docs/CONNECTORS.md) · [Slack Guide](docs/connectors/SLACK.md) · [Discord Guide](docs/connectors/DISCORD.md)
* **Architecture & Science**: [Architecture Guide](docs/ARCHITECTURE.md) · [Analysis & Accuracy](docs/ANALYSIS.md) · [Data Sources](docs/DATA_SOURCES.md) · [Provenance](docs/PROVENANCE.md)

---

## Contributing & License

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md), our [Code of Conduct](CODE_OF_CONDUCT.md), and [SECURITY.md](SECURITY.md).

Licensed under the [Apache-2.0 License](LICENSE).
