# @deepseek-ai/dsh-client-ui-kb-workbench

English | [中文](README.zh.md)

The knowledge-base governance workbench, browser half: one settings section (id `kb-workbench`, nav label 知识库) rendering the merged pending-review list (freshness + recap blind spots), the card detail, the lifecycle actions, the content-edit form, and the flywheel dashboard. The host half is [`@deepseek-ai/dsh-kb-web`](../../kb/kb-web/README.md); the [milestone-5 Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-5-workbench-and-mcp.md) owns the scope decisions and the [milestone-7 Agent Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-7-doc-import-and-workbench-edit.md) adds the edit surface.

## Surface

The section appears under the web settings panel once a deployment composes it (see the [kb-web overlay example](../../../examples/kb-web/cordis.yml)):

- **Flywheel dashboard** — five start-up metrics (injections, promotions, pending review, blind spots, top-heat cards), every number the host's projection of `kb/*` events or their persisted files; the workbench holds no second event stream.
- **Pending-review list** — the freshness entries (已过期 / 即将过期) and the unrecorded recap blind spots with their excerpts and consumed-card links.
- **Card detail** — one full card's knowledge fields, opened from any review row, top-heat entry, or blind-spot consumed card.
- **Lifecycle actions** — the exact transitions the kb seam supports: promote to pending/ready (personal), approve/reject review (team pending), archive (team ready/revived), revive (team archived). Every action rides the `kbWorkbench` Remote namespace, which performs the `ctx.kb` operation and appends the same `kb/promote` event the tools append to the workbench session's own log.
- **Content edit** — an 编辑 button opens a form over the content fields (type / title / 适用条件 / 核心结论 / 应做 / 不应做 / 反例 / 来源 / 责任人 / 有效期 / 标签). Save sends the patch with the detail's mtime/size identity, so a concurrent modification fails loud with a conflict message and the form stays open; a team-card edit requires the explicit confirmation (approved) under the default `teamWriteApproval`. Success appends `kb/edit` on the host and refreshes the detail and the overview.

## Data and mutation flow

All data arrives through the generated `kbWorkbench` Remote namespace (mounted by the `@deepseek-ai/dsh-api-remotes` client assembly); the component holds no service access and no local state machine. The workspace selector picks a session whose `cwd` can serve the workbench; the host derives the workspace root from that session.

## Model Experience

### Human-driven session events

#### What the model sees

The workbench adds no model-visible surface of its own: the actions it drives append the same `kb/*` events the existing tools append, so a human action is reconstructable from the session log exactly like a tool call. A `kb/promote` event carries the transition payload whenever a workbench action performs a transition; a rejected review appends nothing, exactly like `kb_review`. A content edit appends `kb/edit` with the changed field names (the card file stays the content source of truth); an edit that changes nothing appends nothing. The dashboard's numbers are projections of `kb/*` events and their persisted files — the heat ledger, the recap checkpoint, and the card files.

#### Token effect

None beyond the session-log content the model already reads; the workbench renders no prompt content.

#### KV Cache effect

Append-only; workbench-driven events follow the reusable request prefix like any other session event.

## Known Limitations and Deferred Work

- **Opt-in composition** — kb-core, kb-web, and this plugin mount through the deployment's own `cordis.yml`; the shipped `dsh-web-app` bundle does not include kb.
- **Team edits confirm in-band** — the team-card edit form renders an explicit "write to the shared team library" confirmation, the `approved` signal the host gate requires; there is no separate approval dialog.
- **One session per workspace** — the selector lists sessions with a workspace root; a workspace with no session cannot serve the workbench.
- **Errors surface in-band** — Remote failures render in the section's alert row with a retry; there is no toast or notification channel (IM notification is deferred).
