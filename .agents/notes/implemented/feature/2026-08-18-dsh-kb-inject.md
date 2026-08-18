# Agent Note: dsh-kb milestone 2 — knowledge packs and kb/injected injection

Status: implemented

English | [中文](2026-08-18-dsh-kb-inject.zh.md)

## Problem

Milestone 1 made the personal library real — card write/read, promotion, FTS5 search, and incremental ingest. Milestone 2 must deliver proactive injection: the personal AI assistant receives curated card collections (knowledge packs) at session start, without a retrieval step. The external design fixes the product decisions: packs subscribe per scenario without casting a wide net (start with 1–3 packs), injection must reach the model 100% of the time, every model-visible input must be reconstructable from the session log, and the injection record must carry *which cards* were injected so the milestone-3 telemetry projection can account heat per card.

## Decision

**Pack definitions live in `KbConfig.packs`** (kickoff decision 7.2: Config first, workspace files arrive with the web workbench). A pack is `KnowledgePack { name, tags?, tier?, status?, limit? }`, resolved and validated at load by `resolvePacks` — non-empty unique names, closed-enum tier/status members, positive safe-integer limits, non-empty tag strings, and no unknown keys all fail loud. The deployment's pack list IS the scenario subscription: "按场景订阅" means the deployment configures the packs relevant to its scenarios; runtime keyword matching against task text is deferred because no task text exists at session start.

**The trigger is `agent/session-start`, and the listener completes synchronously.** The agent-loop turn flow assembles the prompt (rendering section text) BEFORE the `agent/pre-step` waterfall, so a pre-step append only reaches the *next* step's request — a one-step turn would never receive the pack. `agent/session-start` fires once before the first turn, so an append there is visible to the first assembly; but session-start is a fire-and-forget emit that does not await listeners, so the selection must not be async. The injection therefore reads the library synchronously through `PersonalCardStore.listSync()` (a sync twin of `list()`, same tier walk and per-file parse-failure reporting). The listener folds the log per pack (`hasInjectedPack`) so resume, fork, or a re-emitted session-start never double-injects; sessions without a `cwd` skip injection (nothing to read), packs matching zero cards append nothing, and a per-pack failure logs a warning and continues without breaking agent publication.

**`kb/injected` carries the rendered content, not just ids.** The payload is `{ pack, cardIds, sections: { name, text }[] }` where `sections` are the rendered card blocks (title / 适用条件 / 核心结论 / 应做 / 不应做 / optional 反例). The log alone reconstructs the prompt section, so later library edits or deletions cannot change what replay produces. **No `ignorable` marker**: the [session-log version mechanism](../architecture/2026-08-10-session-log-version-mechanism.md) marker exists for events outside the generated repo-wide known vocabulary; `kb/injected` is declared in-repo in `packages/kb/kb-core/src/types.ts`, so `gen-persistence-catalog` puts it in `KNOWN_SESSION_EVENT_TYPES` exactly like `kb/write` and `kb/promote`, and it is purely informational (it does not change how the rest of the log is read).

**Rendering is a prompt section, not a message.** `inject.ts` registers `ctx.systemPrompt.section({ name: 'kb:pack', order: 60, text: (context) => fold the kb/injected events from context.agent.session.events })`. The `kb/injected` event is the single source of truth; the section only renders. Arrival is 100% because the append completes synchronously before the first assembly and the section participates in every subsequent request. `agent.inject()` is deliberately not used: it queues a message that may miss a request whose pre-step already claimed its batch, and kb-architecture decision 3 already fixed "event rendered into prompt assembly" as the injection mechanism.

**Selection is a pure function, not a new service method.** `selectPackCards(entries, pack)` in `pack.ts` filters by tags (every listed tag must be present), tier allowlist, and status allowlist (default excludes `archived` — retired cards never auto-inject), sorts by card id, and caps at `limit`. `ctx.kb.listCards` was considered and declined: its only caller would be the internal selection, which is the inverse-smell a private capability avoids.

**The kb-inject module stays inside `dsh-kb-core`** as the source directories `pack.ts` (pack resolution, selection, rendering, folding — pure) and `inject.ts` (the session-start listener and the `kb:pack` section registration), per kickoff decision 7.1 (single package until modules stabilize).

**The invariant companion validates `kb/injected`** from the session log: `cardIds` and `sections` are non-empty, every section has non-empty `name` and `text`, and the section names equal the card ids in order — the payload's two faces cannot drift.

## Alternatives considered

**Pre-step trigger in plan-mode style.** Rejected: the agent-loop turn flow renders the prompt before the pre-step waterfall (verified in `packages/core/agent-loop/src/agent.ts`), so a pre-step append is invisible to the current step's request and only a later step sees it — a one-step turn receives nothing, violating 100% arrival.

**Asynchronous session-start listener.** Rejected: `agent/session-start` is a fire-and-forget emit that discards returned promises, so an async selection races the first assembly. The real launch path makes the race concrete: `dsh --profile headless` creates the agent and follows up with the task immediately, so the library read would routinely lose. The synchronous listener trades a bounded block at agent creation for determinism.

**`agent.inject()` with the rendered message.** Rejected: a queued message can miss the request whose pre-step already claimed its batch and can be dropped by cancellation; the architecture decision 3 already chose event-rendered prompt assembly; and the message would duplicate the durable record (message + event) instead of making the event the one source of truth.

**`ignorable: true` on `kb/injected`.** Rejected: the marker covers vocabulary an old build cannot know; `kb/injected` joins the generated repo-wide known list like every other in-repo event, so first-party readers always recognize it. Adding the marker would also mask a real vocabulary regression from old builds.

**`ctx.kb.listCards` as the selection query.** Rejected: the only caller would be the internal selection; the pure `selectPackCards` keeps the seam unchanged, and a future `kb_pack` tool or the workbench can wrap it when a real consumer exists.

**Scene keyword matching against task text.** Rejected for milestone 2: no task text exists at `agent/session-start`; the pack list configured by the deployment is the subscription. Per-task matching needs a task concept that arrives with the CLI/workbench milestones and would push the trigger to the pre-step path the arrival analysis rejected.

## Consequences

Every session whose deployment configures packs starts with the pack content in the `kb:pack` section of every request — a constant per-request token cost that is the point of "注入即上下文". The session-start listener performs a synchronous library read bounded by library size and pack filters, documented as a limitation. Injection is once per session per pack: new tasks within one session, and library edits after session start, are not re-injected (re-injection belongs to the govern/recap milestones). Resume and fork inherit the injection from the log, and replay reproduces the `kb:pack` section byte-identically from `kb/injected` alone. The event payload's `cardIds` face gives the telemetry projection (shipped in [milestone 3](2026-08-19-dsh-kb-milestone-3.zh.md)) its per-card heat without parsing rendered text. Pack selection excludes archived cards by default so retired content never auto-injects; an explicit `status` allowlist overrides the default entirely, and milestone 3 adds the optional `library` allowlist so packs span both libraries.
