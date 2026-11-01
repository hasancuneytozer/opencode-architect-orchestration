# Bounded orchestration — 2026-10-31

## Start small

Use Orchestra for coding workflow; opencode-library is only needed when building an application that observes or controls OpenCode. Subtitle does not need the library merely to use the agent roles. No subtitle onboarding is included in this change.

Run `npm run route -- implementation low` (or `architecture high`, `review normal`, `research low`, `docs low`) before assigning work. The command reads the configured role model and returns a recommendation; it does not launch agents, call a provider, or change models. Availability remains **unverified** until checked against the authenticated provider catalog. Existing local role frontmatter is authoritative. Automatic fallback is disabled: an unavailable model must be reported, not silently substituted.

Use one maker for a small change. Normal independent tasks may use at most two workers; high-risk changes use one worker plus an architectural decision and independent critic. Reviewers must use a checked commit and actual command results. Stop after two failed repair rounds and reassess. Extra reviewers are not automatically useful: each rereads context and consumes resources.

## Enforced boundaries

The project selects `budget.mode: autonomous`: admission rejects task-count, iteration, concurrent-task and elapsed-time overflow. Overlapping declared write surfaces cannot enter running; verifying continues to reserve the surface. Advisory mode retains warning-only behavior for legacy users. Limits are in `.opencode/orchestra.json`: 24 tasks, 12 starts, 2 concurrent tasks, 1 hour; loop max 6 iterations with the remaining overall deadline passed into each wait.

These limits apply to a session's task ledger. They are not a global scheduler, filesystem isolation, provider token quota, or interception of every direct subagent call. Use separate worktrees for simultaneous sessions. Accurate write-surface declarations are required.

A done task requires acceptance/evidence plus `verification: {commit, command, exitCode: 0, artifact, reviewer}`. The commit is a full hexadecimal hash. This is a structured record, not cryptographic proof that a command ran or that the reviewer is independent. The orchestrator must check the actual artifact/output. Starting another attempt clears old verification.

Task persistence compares the saved session snapshot under the existing memory lock. A stale writer receives `TASK_VAULT_CONFLICT`; reload and reconsider the mutation. Do not blindly retry an old update.

## Memory maintenance policy

The current memory ceiling is 800; the task memory block recalls up to 6 entries and includes up to 3 pending lesson signals. These bounds are not a guarantee of semantic quality. As a recommended operating policy, the architect should review memory after every 20 new permanent lessons or the second recurrence of the same root cause. This is not automatically enforced; an automatic maintenance counter is out of scope for this round.

Prove duplicates before consolidating them into one actionable rule; use `supersedes` or `forget` to retire prior entries with a reason. Do not turn one-off incidents into lessons: preserve the `AGENTS.md` threshold of 3. Personal memory is not committed to Git, and there is no automatic semantic deletion.

## Shared engine updates

`node scripts/sync-shared.mjs --target <existing-project>` is dry-run by default. Review its plan before adding `--apply`. Source hashes come from `docs/orchestra-shared.json`; target baseline hashes live in `docs/orchestra-shared-state.json`. An untracked/divergent target is a conflict; the whole preflight stops before writing. Existing updated files are backed up under `.orchestra-sync-backups/`.

This is a curated shared-file bundle, **not a full project installer**. It deliberately excludes roles, user configuration, secrets, runtime state, memory.ts and other divergent integration code. Those need explicit review. Stop concurrent writers before applying. The apply phase is not a filesystem transaction; an unexpected I/O failure can leave a partial update, recoverable from backups. Symlink/junction paths and traversal are rejected. No remote download occurs.

## Cost and compatibility

Task/iteration/concurrency limits bound work, not ChatGPT weekly usage. This change does not measure actual model quota, authorize a new provider, or promise free-model availability. OAuth access, subscription usage and API billing depend on the actual provider/integration. Pilot a small change and inspect measured usage before increasing parallelism.

The repository's optional patched runtime is pinned to 2.0.18. Installed CLI 2.1.4 must not be treated as equivalent. Its default discovery commands encountered an occupied service port, and debug agents rejects standalone routing flags. An isolated 2.1.4 server on a separate port answered authenticated agent/plugin queries with empty lists for both project locations; this is NOT a successful role/plugin discovery check. Existing user services were left untouched. No paid or free provider inference was run for this release.

## Verification

For scope verification, compare `git status` and file hashes against the initial baseline. A previously existing untracked file is not automatically outside the task's scope; establish whether it changed rather than excluding it solely because it was untracked.

Both repositories: typecheck, full existing test suites, new hardening tests (5), shared updater tests (3), and local-runtime tests (48 each) pass. Library additionally: bounded-stream tests (4), isolated HTTP security tests (2), dist smoke (9), README contract checks (48), and build pass. Security tests use a fake adapter with real local HTTP; they do not demonstrate provider/OAuth or interactive TUI behavior. The opt-in `test:example:live` remains a real-service integration check, not part of offline tests.

Remaining pilot: confirm installed-runtime role/plugin discovery, authenticated model availability, parent-to-child delegation and interactive stop behavior on a disposable project before enabling autonomous work on subtitle.
