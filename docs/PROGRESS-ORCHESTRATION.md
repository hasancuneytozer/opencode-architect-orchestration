# Progress-driven orchestration

Default total iteration, task-count and wall-clock budgets are zero (unbounded).
The absolute per-iteration `idleTimeoutMs` deadline is also disabled (`0`); despite
its historical name, it does not measure inactivity and must not cut off healthy work.
Role frontmatter has no `steps` limits. Concurrency remains two; write locks,
dependencies, verification, report role gates and optional explicit caps remain.

`orchestra_task` may create a title-only draft. Bind nonempty acceptance while
still planned, before starting work. Once bound, acceptance is immutable and
has a stable `criterionID`. Drafts cannot start or complete, and prevent overall done.
Retries reuse that criterion ID, even after task pruning. Identical acceptance
without an explicit ID reuses its existing criterion; an explicit different ID
for the exact same trimmed acceptance is rejected as an alias collision. This
is exact matching, not semantic/NLP identity enforcement. Record attempts using:

```json
{"criterionID":"build","attempt":{"id":"compile-fix-3","blockerID":"ts-import-cycle","outcome":"failed","evidence":["logs/compile-fix-3.txt"]}}
```

Outcomes are `progress`, `failed`, `resolved`, `verified`. Every event requires
evidence; IDs are globally unique within the session ledger. Three failures for
the same blocker block that criterion. Progress and changed prose never reset
failures. `resolved` requires a causal `reason`, a successful structured
`verification` (commit/command/exitCode=0/artifact/reviewer), and evidence containing
that check's artifact and distinct
from every failure of that blocker. It preserves history and does not itself
retry work. A retry must explicitly name failed/blocked contributor task IDs in
`supersedes`, describe `nextWork`, and supply evidence. Retry eligibility is not
actionability: a terminal failed task is not automatically scheduled again.
Externally blocked tasks genuinely stop their path; independent work continues.
Downstream dependencies follow explicit replacement chains, including pruned
contributors; a replacement must finish before dependent work can start.

Each newly contributing task advances the criterion's work generation and
invalidates old certification. Every nonsuperseded contributor must be done
with structured verification before a `verified` attempt certifies the current
generation. Historical successful work cannot certify a failed new contributor.
Contributor completion/proof is copied into the criterion before pruning tasks.
All criteria must be verified and no
live task may remain before overall done. Continue independent criteria while
another is blocked. The model remains responsible for truthful evidence and
semantic blocker identity; arbitrary prose is never used as a fingerprint.

Criteria, attempts and checkpoint live in the existing TaskBoard/TaskVault.
Memory's state lock, atomic write and expected-snapshot CAS serialize changes.
Task pruning and session slot eviction do not remove acceptance history.
Legacy tasks acquire stable `legacy-<taskID>` criteria, sharing one identity for
exactly equal acceptance. Legacy active records lacking acceptance may bind it
once or explicitly leave active status; new drafts still cannot start unbound.
Historical done claims
are not silently upgraded to verified acceptance. Context injection and loop
prompts expose a short sanitized checkpoint, with the full ledger available
through `orchestra_status({criterionID, offset:0, limit:10})` (maximum page size
25). Pages include attempts, blocker IDs, reasons, verification, contributors,
supersession and next-work state. Both contributor and attempt lists use the
same offset and expose their total counts. Status content is sanitized data,
not instructions. Context injection includes only a short summary and retrieval
instructions, including before the first completed attempt. Lesson capture and
learning remain in the existing memory path. CAS compares normalized canonical
content, so JSON key order after reopen does not cause false conflicts.

Missing/stale progress reports and explicit opt-in diagnostic timeouts are technical
faults, not failed solution attempts. Actual session failures are still detected. Report-only test
harnesses may explicitly select `legacyReportOnly`; production defaults require
matching lifecycle and completed-attempt revisions. Planning, binding drafts,
dispatch and first status transitions are real lifecycle work, not fake solution
attempts. Repeated status cycling, metadata changes, prose and new-task churn
are not progress. Newly introduced work after the initial plan needs a completed
evidence-backed attempt to establish a new planning frontier.

Link a real child session as task `workerID`; report `waitingFor:[workerID]` to
park on that worker's actual wait call. Worker ownership is checked. A parked
wait does not increment attempts or repeatedly prompt the model; stop polling
remains active even with all time limits disabled. Completed workers cannot be
used for unlimited heartbeat reports. `/loop stop` works with unbounded loops.

Verification commands (independent verifier): `npm run typecheck`, `npm test`,
`npm run test:local-runtime`. The new `progress.test.mjs` is included in npm test.
The shared bundle includes persistence/context injection and the associated
progress/legacy/wait-policy tests. Review and integrate role/config/policy changes
and npm test wiring separately. Existing tests that start title-only fixtures
must bind acceptance first; tests of draft behavior should assert binding and
successful completion, rather than an immutable empty-acceptance dead end.

For newly managed shared paths, establish a baseline only after comparing the
consumer against the previous source version. Preserve project-specific models,
role routing, personal memory and runtime credentials. The shared updater's
dry-run must be reviewed before applying; divergent content needs an explicit merge.
