# Field-level provenance guide

Field-level provenance records which upstream endpoint supplied each value, when that observation or retrieval occurred, whether the data was fresh or stale, and which deterministic calculation produced any derived metric. Every successful source refresh in Seb writes a versioned snapshot paired with a SHA-256-verified provenance manifest in `.cache/seb.sqlite` (see the [storage guide](STORAGE.md)).

## Envelope and source schema

In memory, a provenance envelope wraps an application value with its contributing sources, JSON Pointer field lineage, and aggregate freshness assessment; when persisted inside `snapshots`, SQLite stores the manifest without duplicating the snapshot's `payload` column. Conflicting definitions sharing the same source `id` within one envelope are rejected.

| Source record field | Required | Description |
| --- | :---: | --- |
| `id` | Yes | Stable source identifier within the envelope (referenced by field lineage entries). |
| `provider` | Yes | Upstream family (`sleeper`, `nflverse`, `weather`, `news`, or derived source namespace). |
| `label` | Yes | Human-readable source description (treated as untrusted display text). |
| `retrievedAt` | Yes | Canonical ISO 8601 UTC timestamp when Seb received or validated the payload. |
| `url` | No | Sanitized public `http://` or `https://` URL without credentials or secret tokens. |
| `observedAt` | No | Upstream measurement or event timestamp when distinct from publication/retrieval time. |
| `publishedAt` | No | Upstream feed, sitemap, or release publication timestamp. |
| `version` | No | Client schema or parser revision identifier. |
| `freshnessPolicy` | No | Fresh and `stale-if-error` TTL bounds plus future-drift tolerance (`maxFutureDriftMs`). |

## JSON Pointer field paths and derived lineage

Seb addresses tracked fields using RFC 6901 JSON Pointer paths (such as `/player/name` or `/points`). Direct cache snapshots automatically generate leaf-field lineage up to **2,000 field paths** per payload; payloads exceeding 2,000 leaf paths record root lineage (`/`) to bound snapshot serialization size and CPU cost.

| Field lineage property | Role |
| --- | --- |
| `path` | RFC 6901 JSON Pointer (`/` for root fallback or exact leaf path such as `/expectedPoints`). |
| `sourceIds` | Contributing source `id` references merged from direct or upstream inputs. |
| `freshness` | Per-field freshness evaluation (`fresh`, `stale`, `expired`, `future`, or `unknown`). |
| `derivation` *(optional)* | Records `operation` (e.g., `weighted-player-mean`), semantic `version` (bumped whenever formula logic changes), and `inputs` (`{ envelopeId, path }` pointers into validated parent envelopes). |

Every `derivation.inputs` reference must resolve to an existing tracked path, allowing an end-to-end audit from any derived projection or summary back to its exact upstream source fields.

## Timestamp selection and freshness precedence

To evaluate a source's age and clock skew at assessment time, Seb selects the most authoritative available timestamp via the deterministic fallback chain:

```text
effectiveTimestamp = observedAt ?? publishedAt ?? retrievedAt
```

Timestamps more than **5 minutes** ahead of the evaluation clock (the default `maxFutureDriftMs` tolerance) classify as `future`. Across multiple sources on a field—or across all tracked fields in an envelope—Seb assigns the **least reliable (worst) state** using strict precedence:

```text
future  ->  expired  ->  unknown  ->  stale  ->  fresh
(worst / least reliable)                      (best / usable)
```

| State | Condition | Usable in live answers? |
| --- | --- | :---: |
| `future` | `effectiveTimestamp` exceeds evaluation time by more than `maxFutureDriftMs` (default `5m`). | No |
| `expired` | Age exceeds both the fresh TTL and the `stale-if-error` window. | No |
| `unknown` | Missing valid timestamp or missing freshness policy bounds. | No |
| `stale` | Age exceeds the fresh TTL, remains within `stale-if-error`, and serves after a refresh failure. | Yes (flagged; caps action confidence) |
| `fresh` | Age is within the configured fresh TTL. | Yes |

Refresh logic can recompute freshness assessments against current policy windows without mutating immutable snapshot payloads.

## Inspecting sources and manifests

After an interactive answer, run `/sources` to view every grounded URL, cache outcome (`fresh`, `updated`, `not-modified`, or `stale-if-error`), and retrieval timestamp; `seb ask --json` emits the same validated `sources` array alongside `analysis`. To inspect stored snapshots and field-level lineage directly:

```bash
# List recent snapshot metadata without large payloads
seb snapshots --json

# Inspect a human-readable provenance summary or full JSON manifest
seb snapshots --id SNAPSHOT_ID
seb snapshots --id SNAPSHOT_ID --json
```

Inside interactive chat, `/snapshots` lists the 20 newest snapshots and `/provenance SNAPSHOT_ID` renders up to 50 JSON Pointer paths with their contributing source IDs. Programmatic callers can load verified snapshots via `SebDatabase.getSnapshot()`.

> [!WARNING]
> **Provenance & snapshot security rules**
> - Never embed API keys, webhook secrets, or user credentials inside `source.url`, and never record `Authorization` or cookie headers in provenance manifests.
> - Always validate stored envelopes through Seb's Zod parser and SHA-256 payload/manifest checksum checks before reading values—canonical key sorting guarantees deterministic hashes, and tampered rows fail closed.
> - Treat upstream `label` and publisher strings as untrusted display text passed through Seb's terminal/output sanitizer.
