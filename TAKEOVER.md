# OpenViking Context Takeover for Pi

Context takeover makes OpenViking the authoritative long-term context store for
pi sessions. Pi still keeps recent active turns locally, but committed history
is represented to the model by OpenViking's archive overview through pi's
`context` hook.

## Model

The extension tracks:

| Field | Meaning |
|-------|---------|
| `coveredUserTurns` | Number of real user turns covered by the confirmed archive overview |
| `overview` | Overview read from the exact archive identified by its commit response |
| `confirmedArchive` | Archive identity that owns the injected overview |
| `pendingArchive` | Accepted commit identity and boundary snapshot awaiting its own overview |
| `fingerprint` | Stable fingerprint of the last covered message for branch mismatch detection |
| `pendingTokens` | Estimated synced token pressure not yet covered by a confirmed archive |
| `syncedEntryCount` | Pi branch watermark restored across `pi -p` / `pi -c` processes |

State is persisted as a pi custom entry:

```ts
pi.appendEntry("ov-takeover", state)
```

On startup the extension scans the branch from the end, restores the latest
entry, and restores `SyncManager`'s watermark so `pi -c` does not resend the
same branch entries to OpenViking.

## Runtime Flow

1. `turn_end` captures new branch entries into the OpenViking session.
2. The capture path uses a disk pending queue when OpenViking is temporarily
   unreachable.
3. When `pendingTokens >= takeover.tokenThreshold`, takeover tries to advance.
4. Advance first drains the current session's pending `addMessage` entries.
5. The commit opts into OpenViking `turn_budget` retention and must return
   `status=accepted`, `archived=true`, `task_id`, and `archive_uri`.
6. The accepted identity is persisted before polling. While it is pending, all
   automatic, manual, and compaction entry points reuse it instead of committing again.
7. The task must complete and `GET /sessions/{id}/archives/{archive_id}` must return
   that exact archive's non-empty overview before the boundary can advance.
8. Completion subtracts only the token pressure present when the commit was accepted;
   tokens synced while waiting remain pending.
9. The `context` hook replaces confirmed covered messages with a synthetic user
   message beginning with `[OpenViking Session Context]`, then recall is injected
   into the remaining latest user turn.

The overview message timestamp is derived from the first kept message, so the
provider payload remains byte-stable between commits and can benefit from
prompt caching.

## Compaction

When pi emits `session_before_compact`, takeover first reconciles any accepted
archive. It then commits the remaining live OpenViking messages with
`keep_recent_count=0`, so the exact overview covers everything Pi is about to
replace. If that archive becomes ready in time, the extension returns:

```ts
{
  compaction: {
    summary: "[OpenViking Session Context]\\n...",
    firstKeptEntryId,
    tokensBefore,
    details: { source: "openviking", archiveUri }
  }
}
```

If any step is still pending or fails, the handler returns `undefined` and Pi's
default compaction runs. The archive identity remains retryable, but
`session_compact` prevents it from later advancing the pre-compaction boundary.

## Capture Fidelity

Takeover mode enables faithful capture in the pi adapter. Short acknowledgments,
punctuation-only turns, and other low-signal text are still captured because
those turns may later disappear from the live model context. Empty text,
slash commands, and OpenViking status messages remain filtered. Captured messages
carry the Pi user entry ID as `turn_id` and an explicit `message_kind`, allowing
OpenViking to keep an assistant response and its tool transports in one atomic step.

If one Pi user turn accumulates beyond `retainedTokenBudget`, the extension requests
Pi's native compaction instead of implementing another message splitter. Pi owns the
safe mid-turn cut rules, including keeping tool results with their calls.
## Configuration

```json
{
  "takeover": {
    "enabled": true,
    "tokenThreshold": 20000,
    "retainedTokenBudget": 30000,
    "keepRecentTurns": 3,
    "overviewBudget": 16000,
    "overviewPollMs": 2000,
    "overviewPollMax": 15
  }
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `takeover.enabled` | `true` | Enable context takeover |
| `takeover.tokenThreshold` | `20000` | Synced-token pressure required before starting an archive |
| `takeover.retainedTokenBudget` | `30000` | Raw OpenViking tail budget and oversized Pi-turn threshold |
| `takeover.keepRecentTurns` | `3` | Recent logical user turns preferred in full fidelity |
| `takeover.overviewBudget` | `16000` | Token budget for the injected archive overview |
| `takeover.overviewPollMs` | `2000` | Delay between overview polling attempts |
| `takeover.overviewPollMax` | `15` | Max overview polling attempts after commit |

## Failure Modes

| Failure | Behavior |
|---------|----------|
| OpenViking health check fails | Extension stays disconnected; pi runs normally |
| Pending addMessage replay fails | Boundary is not advanced; full local history remains visible |
| Commit fails or is skipped | Boundary is not advanced; pending token pressure remains |
| Commit response is lost after Phase 1 | New task is recovered by pre/post task IDs; ambiguous outcomes block further commits |
| Accepted archive is pending | Identity is persisted and retried without another commit |
| Task fails, is cancelled, or archive identity mismatches | Pending identity is cleared; pressure remains; boundary is unchanged |
| Exact archive overview is empty | Identity remains pending; session context overview is never used as fallback |
| Legacy state has no confirmed archive identity | Old boundary is discarded; active legacy tasks must drain before a new commit |
| Branch fingerprint mismatch | Boundary resets to 0 and full history is shown until the next successful advance |
| Compaction takeover fails | Returns `undefined`; Pi default compaction proceeds |

## Verification

Run `npm test` and `git diff --check` for every takeover change. A live gate must use
an isolated Pi/OpenViking session and verify all of the following identities agree:

1. commit response `archive_uri` and `task_id`;
2. completed task result `archive_uri`;
3. exact archive API `archive_id` and non-empty overview;
4. persisted `confirmedArchive` and the boundary shown by `/viking`;
5. the provider payload contains the confirmed overview and omits only messages
   covered by that archive.

The pending path must also be exercised across a Pi restart. An oversized turn must
contain at least one tool call/result pair and verify that Pi compaction leaves no
orphan tool result.
