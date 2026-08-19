# Agent Note: dsh-kb milestone 4 — recap blind-spot detection, distillation strategy, and methodology skills

Status: implemented

English | [中文](2026-08-19-dsh-kb-milestone-4-recap-and-skills.zh.md)

## Problem

Milestones 1–3 closed the personal library loop, the knowledge-pack injection, the team library with the dual gate, freshness, and the heat telemetry projection. The flywheel's "用即积累" (use and accumulate) leg is still manual: a session that consumes injected knowledge but writes no card leaves the consumption without the accumulation, and nothing scans the session logs to surface those blind spots. Milestone 4 must add the recap leg — scan the workspace's session logs, find the sessions that consumed without producing, and turn them into draft cards — plus the methodology skills (card writing standard, recap flow, knowledge-pack building) so the model can follow the same rules the code enforces. The open questions the design left to this milestone (待决项 6, design §9 week 6) are: what counts as a blind spot, when distillation triggers and how new drafts dedup against existing cards, how the recap stays replayable from the session log, and which notification channel carries the review list.

## Decision

**A blind spot is a workspace session that consumed knowledge but produced no card.** The session's own log decides: at least one `kb/injected` event with a non-empty `cardIds` array (the consumption fact, the same face the heat telemetry projects) and no `kb/write` event anywhere in the log (the production fact). Sessions without injection, or with a write, are healthy. The predicate is structural, exactly like `evaluateGate`: it checks event presence, never semantics.

**The scan is deterministic machinery; the model distills.** `runRecapScan` reads the workspace's session logs (live `ctx.sessions` sessions whose `header.cwd` equals the root, with precedence over persisted sessions from the optional `ctx.sessionPersistence` service; live wins a duplicate), computes blind spots, renders each one's bounded conversation excerpt (the tail of the message stream, capped at `RECAP_EXCERPT_MAX_CHARS`), and appends the recorded positions to the checkpoint. The recap never fabricates card content: the model reads the listed blind spots and excerpts and writes draft cards through the existing `kb_write` path into tier P2, after which the milestone-3 dual-gate pipeline (`kb_gate_check` / `kb_team_promote` / `kb_review`) applies unchanged. Each listed entry carries the session's consumed card ids so the model can judge coverage against existing cards — that semantic judgment stays with the model, the same way the first gate checks structure and trusts the model's evidence claim.

**Dedup is a per-session scan-position checkpoint.** `RecapCheckpoint` is a JSONL file at `KbConfig.recapPath` (default `kb/.kb-recap.jsonl`) recording `{ sessionId, eventCount }` positions. A blind spot is listed only when its position is not recorded at or beyond the current log length; listing records the position, so each blind spot is surfaced exactly once per session length and re-listed only when that session's log grows (new activity means a new distillation opportunity). `kb_recap` takes an optional `limit` (1–50, default 10); blind spots beyond the limit stay unrecorded, so repeated calls page through the queue. A session that wrote a card is not a blind spot and never needs a position — recording only ever holds listed blind spots.

**The checkpoint is a projection; `kb/recap` is the durable fact.** The scan appends the new `kb/recap` session event after the checkpoint write succeeds, carrying `{ scanDate, scanned: {sessionId, eventCount}[], blindSpots: {sessionId, at, consumed}[], total, listed }`. `projectRecapScans` over any session log plus `RecapCheckpoint.writeAll` rebuild the checkpoint from session logs alone — the `HeatLedger` pattern, not a second event stream. Excerpts are pure functions of the referenced session's own log, so the rendered list re-derives; the `kb/recap` event joins the generated known-vocabulary list like the other in-repo `kb/*` events, so no `ignorable` marker and no session-format bump are needed. Tool-driven renders ride the tool call/result events like `kb_freshness`.

**Both surfaces run the same scan.** The `kb_recap` tool (on demand) and the per-session owner-scoped `kb-recap` `ctx.jobs` job (started at `agent/session-start` when `KbConfig.recapIntervalDays` is positive; one immediate scan then a daily timer counting down days, the freshness scheduler's shape) share `runRecapScan`. The job captures its owner agent and appends the `kb/recap` event to the owner's session, so job-driven checkpoint advances stay logged. A configured interval without a jobs service logs one loud error per context and skips; sessions without a cwd skip.

**The notification channel is deferred.** Recap output reaches the model through the `kb_recap` tool result, the scheduled job's buffered output (read through the jobs tools), and the `kb/recap` events. Web-todo versus IM notification is the web-workbench milestone's decision, recorded as a limitation.

**kb-skills registers three runtime skills on `ctx.skills`**: `kb-card-writing` (the §4.3 checklist and card template; structure facts — types, tiers, statuses, libraries — interpolated from the `card.ts` constants so the text cannot drift from the parser), `kb-recap-flow` (the mode-B steps: when to run `kb_recap`, how to judge blind spots, distill through `kb_write` into P2, then the dual gate), and `kb-pack-building` (the `tags` / `tier` / `library` / `status` / `limit` filter semantics of pack selection). The skill bodies are generated from the same constants the code validates against — no hand-copied second copy of the card spec. Registration is optional: a context without a `skills` service logs one loud error and skips.

## Alternatives considered

**Semantic blind-spot detection (an LLM scans the logs).** Rejected: it is nondeterministic and untestable, and the model-visible ⟺ logged invariant needs deterministic machinery; the semantic judgment belongs at the distillation step, where the model reads the deterministic list and decides what to write.

**The recap auto-writes stub or skeleton cards.** Rejected: writing card content without a model fabricates knowledge, and the design's "敢于不沉淀" (dare not to accumulate) means skipping is a legitimate outcome that only the model can judge.

**Recording every scanned session in the checkpoint.** Rejected: it would record blind spots beyond the tool's limit and hide them from the model; recording only listed blind spots keeps the queue pageable and each blind spot visible exactly once.

**Recap depending on `dsh-session-query` for the log corpus.** Rejected: the scan needs only the session log surface — live sessions and the optional persistence service — both reachable through `dsh-session` types plus one optional `ctx.get('sessionPersistence')`; pulling the whole FTS query stack into kb-core would couple the two packages for a list-and-fold.

**Skill text hand-copied from the docs.** Rejected: the skill bodies interpolate the parser's own constants, so an enum or template change cannot leave the skill text stale.

## Consequences

kb-core gains two peer dependencies: `@deepseek-ai/dsh-skill` (the `ctx.skills` registry types) and `@deepseek-ai/dsh-session-persistence` (the optional persisted-log surface, type-only plus `ctx.get`). The `kb/recap` event extends `SessionEventMap` and the invariant companion validates its payload. The recap contract is: each blind spot is surfaced once per session length; historical lists and the checkpoint rebuild from `kb/recap` events; sessions grow to re-enter the queue. The scheduled recap needs a composed jobs service, like freshness; without one the on-demand tool still works and the misconfiguration logs loudly. The peer deps stay optional at runtime — a deployment without the skill or persistence services gets the loud log and the live-session-only scan, never a crash.
