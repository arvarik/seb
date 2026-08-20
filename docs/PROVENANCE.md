# Field-level provenance guide

Provenance states where a value came from and when the source supplied it.

Seb stores provenance manifests with source snapshots.

## Envelope structure

A provenance envelope contains these values.

- A schema version and envelope ID.
- The envelope creation time.
- The complete value.
- The contributing source definitions.
- A lineage record for each tracked field.
- One aggregate freshness assessment.

A stored snapshot keeps the same manifest without a duplicate value field.

The snapshot already stores the source value as its payload.

## Source records

Each source definition contains an ID, provider, label, and retrieval time.

It can also contain these values.

- A source URL.
- The observation or publication time.
- A source version.
- A freshness policy.

Seb rejects conflicting definitions that use the same source ID.

## Field paths

Seb identifies fields with standard JSON Pointer paths.

These examples identify a player name and a point total.

```text
/player/name
/points
```

Each field record lists its source IDs and freshness assessment.

A derived field also lists the operation, calculation version, and input field references.

The references contain an envelope ID and a JSON Pointer field path.

This structure supports an audit from a result to every input field.

## Direct source manifests

Cache snapshots create direct lineage for each leaf field.

The default limit is 2,000 field paths for one value.

Seb assigns the root path when the value exceeds that limit.

This limit bounds snapshot size and creation time.

## Freshness states

| State | Meaning | Usable |
| --- | --- | --- |
| `fresh` | The source age remains inside the fresh period. | Yes |
| `stale` | The source age remains inside the stale-if-error period. | Yes |
| `expired` | The source age exceeds the complete allowed period. | No |
| `future` | The source time exceeds the allowed future tolerance. | No |
| `unknown` | A timestamp or freshness policy is missing. | No |

The default future tolerance is five minutes.

Seb uses the observation time before the publication or retrieval time.

An envelope uses the least reliable state from its tracked fields.

Refresh logic can recalculate freshness without changing the stored value.

## Derived lineage

Use derived lineage for any calculated value.

The operation name must describe the exact calculation.

The version must change when the calculation behavior changes.

For example, a rolling average can name `weighted-player-mean` and version `1.0.0`.

Each input reference must point to a field with existing lineage.

Seb merges the source definitions from all referenced fields.

## User-visible source status

Run `/sources` after an interactive answer.

Seb shows the source link, cache outcome, and retrieval time.

It also shows a warning when the client used stale data after an error.

One-shot JSON output includes the source list and retrieval information.

Run `seb snapshots --json` to inspect snapshot metadata.

Inspect one provenance summary.

```bash
seb snapshots --id SNAPSHOT_ID
```

Return the complete manifest as JSON.

```bash
seb snapshots --id SNAPSHOT_ID --json
```

Inspect one snapshot inside chat.

```text
/provenance SNAPSHOT_ID
```

The interactive command shows up to 50 field paths and their source IDs.

Developers can read a snapshot by ID through `SebDatabase.getSnapshot()`.

## Validation and serialization

Seb validates every source, field path, derivation, and freshness policy.

The serializer sorts object keys for stable JSON output.

The parser validates the envelope structure and the application value.

Do not trust a stored provenance file without this validation.

## Security rules

Do not put an API key or platform token inside a source URL.

Do not store request authorization headers inside provenance.

Use public source URLs when a report can show the link.

Treat source labels and descriptions as untrusted display text.
