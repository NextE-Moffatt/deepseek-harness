# @deepseek-ai/dsh-kb-web

English | [中文](README.zh.md)

The web governance workbench host half: `ctx.kbWorkbench`, a Remote service exposing one workspace's merged pending-review list (freshness + recap blind spots), full card reads, the flywheel metrics, the lifecycle actions (promote / archive / revive / review), and the content-edit action (conflict-guarded, team-gated). The browser half is [`@deepseek-ai/dsh-client-ui-kb-workbench`](../../client/ui-kb-workbench/README.md); the [milestone-5 Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-5-workbench-and-mcp.md) owns the scope decisions and the [milestone-7 Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-7-doc-import-and-workbench-edit.md) supersedes its "no card-content editing" choice.

## Service

`ctx.kbWorkbench` (class `KbWorkbenchService`, default export) is a `TypertRemoteService` under the `kbWorkbench` namespace. Every Remote method takes the session first (the `session` Typert lookup carries the session id on the wire); the workspace root derives from `session.header.cwd`.

| Method | Behavior |
|---|---|
| `overview(session, today?)` | The merged pending-review view: the freshness review, the unrecorded recap blind spots (detection without recording — the checkpoint queue stays with the tool and the scheduler), the heat ledger, and five flywheel metrics projected from those same surfaces (injections, top-heat cards, promotions, pending review, blind spots). |
| `card(session, id)` | One full card across the personal and team libraries with its derived grade and file identity (the edit guard's expected values). |
| `edit(session, id, patch, options?)` | The content edit: apply the patch through `KbService.editCard` (conflict-guarded, team-gated) and append `kb/edit` when anything changed. |
| `promote(session, id, target, evidence?)` | The promotion transition (`pending` / `ready`, the `kb_promote` subset) plus the `kb/promote` event. |
| `archive(session, id)` / `revive(session, id)` | The retire/restore edges plus the `kb/promote` event. |
| `review(session, id, approved)` | The second gate; appends `kb/promote` only on approval, like `kb_review`. |

The actions are thin event-appending wrappers over the existing `ctx.kb` methods — the workbench drives no second state machine, and every `kb/promote` it appends to the workbench session's own log is validated by the `@deepseek-ai/dsh-kb-core` invariant companion.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `blindSpotLimit` | `20` | Cap on the unrecorded blind spots the overview lists. |
| `topHeatCount` | `3` | How many top-heat cards the flywheel metrics carry. |

Invalid values fail loud at load.

## Events

The workbench appends the same `kb/*` events the tools append (with the transition payload; a rejected review appends nothing), so a human action is a session fact reconstructable from the log like a tool call. The content edit appends `kb/edit` (the changed field names; the card file stays the content source of truth) after the write succeeds. The overview reads only existing projections (`kb.freshnessReview`, the recap checkpoint, the heat ledger, and a fold of `kb/promote` events over the workspace's session logs) — no second event stream exists.

## Model Experience

### Workbench-driven session events

#### What the model sees

The workbench is a human surface; its lifecycle actions append the same `kb/promote` events the tools append to the workbench session's own log. A `kb/promote` event carries the transition payload (`id`, `from`, `to`, optional `evidence`); a rejected review appends nothing, exactly like `kb_review`.

#### Token effect

None beyond the session-log content the model already reads; the workbench adds no prompt sections.

#### KV Cache effect

Append-only; workbench-driven events follow the reusable request prefix like any other session event.

## Known Limitations and Deferred Work

- **Opt-in composition** — kb-core, kb-web, and the workbench client plugin mount through the deployment's own `cordis.yml` (see the [kb-web overlay example](../../../examples/kb-web/cordis.yml)); the shipped `dsh-web-app` bundle does not include kb.
- **Team edits are approval-gated by default** — under `KbConfig.teamWriteApproval` (default true) the `edit` Remote refuses a team-card edit without `options.approved`; the workbench's team-edit confirmation is that approval signal, and the model tool path keeps its own `tools/pre-execute` ask gate.
- **The edit guard is optimistic, not a lock** — a stale edit (the card's mtime/size changed since the detail was read) fails loud with a conflict message; the client refreshes the detail and the human retries.
- **The workbench lists blind spots without recording them** — the recap checkpoint advances only through the `kb_recap` tool and the scheduled job, so the queue semantics are unchanged.
- **IM notification is deferred** — the pending-review list is the human-facing channel; an IM channel has a documented trigger condition (a real ops-channel requirement).
