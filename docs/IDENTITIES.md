# Canonical identity guide

Seb maps source identifiers to one internal player or NFL team identity.

This mapping prevents a source join from using only a display name.

## NFL team identities

Seb includes all 32 current NFL franchises in a built-in registry.

Each team uses this canonical ID format.

```text
nfl-team:SEA
```

The identity contains the current code, city, team name, aliases, and source identifiers.

The aliases include common codes, full names, nicknames, and selected historical names.

For example, the Washington identity accepts `WAS`, `WSH`, and `WFT`.

Historical source codes map to the current franchise identity.

Seb maps `OAK` to the Las Vegas Raiders and `SD` to the Los Angeles Chargers.

An ambiguous alias returns candidate teams instead of one guessed team.

For example, `LA` can refer to three franchises.

Use a current team code or a full team name after an ambiguous result.

## Player identities

A player identity contains these values.

- A canonical player ID.
- A display name and normalized name.
- A position and canonical team ID when known.
- Display aliases.
- Sleeper and nflverse source identifiers.

Seb prefers an nflverse record when it selects the display value for a linked group.

Seb generates this ID when no explicit canonical ID exists.

```text
nfl-player:PROVIDER:SOURCE_ID
```

Seb URL-encodes the source ID inside the generated identifier.

## Automatic player matching

The identity tool uses the strict matching strategy.

This strategy requires the normalized name, position, and team to match.

It also requires one candidate from each provider.

Seb reports an issue when one provider supplies several candidates for the same match.

Seb never joins those ambiguous candidates automatically.

The registry can also use these developer strategies.

| Strategy | Rule |
| --- | --- |
| `strict` | Match the normalized name, position, and team. |
| `name-position` | Match the normalized name and position. |
| `off` | Use only explicit source links. |

Use explicit links when a player changed teams or uses conflicting source names.

An explicit link can also assign a stable canonical ID.

## Name normalization

Player matching removes case differences, accents, punctuation, and spacing differences.

Position values use uppercase text.

Team values first pass through the canonical team registry.

Normalized matching can still return several players.

Add a position, team, or source ID to resolve that case.

## Agent tools

`resolveTeamIdentity` accepts a code, full name, nickname, historical alias, or canonical ID.

It can also resolve a direct Sleeper or nflverse source code.

`resolvePlayerIdentity` reads Sleeper players and nflverse weekly records.

It then builds a strict identity registry for the requested name and season.

The result contains the identity resolution, match issues, and source row counts.

The agent uses these tools when a name can map to several source identifiers.

## SQLite persistence

Version `0.0.4` stores resolved player and team identities in SQLite.

The `identities` table stores the entity type, canonical ID, checked payload, and update time.

The `identity_links` table maps each provider source ID to one canonical ID.

The player identity tool still builds a strict registry from current source records.

It saves the result only after the registry returns one resolved identity.

The team identity tool saves a team after one successful resolution.

Ambiguous and missing results do not create identity records.

The repository can read an identity by canonical ID or provider source ID.

Each stored payload has a SHA-256 checksum.

Seb stops when a stored identity fails checksum validation.

## Stable canonical IDs

The first stored source mapping owns the stable canonical ID.

A later cross-source match reuses that ID when it includes the first source mapping.

Seb merges the new source links into the existing canonical record.

For example, an early Sleeper-only ID remains stable after nflverse supplies a matching ID.

Seb rejects a write when its source links already point to several canonical IDs.

This rule prevents a silent merge of conflicting people.

Cache clearing and source refresh commands preserve identity records and links.

The built-in team aliases remain versioned with the application.

The identity libraries can also serialize a validated version `1` catalog.

## Developer rules

Use a canonical ID inside every derived record that combines several providers.

Keep every original source identity beside the canonical ID.

Do not silently replace an ambiguous result.

Record an explicit identity issue when source records conflict.

Add identity tests before you add a new provider.

Review historical team aliases before each season.
