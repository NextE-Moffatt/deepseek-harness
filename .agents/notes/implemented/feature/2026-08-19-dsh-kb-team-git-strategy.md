# Agent Note: dsh-kb team library git strategy — draft, review, commit inside the approval gate

Status: implemented

English | [中文](2026-08-19-dsh-kb-team-git-strategy.zh.md)

## Problem

The team library is a shared git repository: structured cards under `cards/` and document-style wiki text under `docs/`, consumed by the whole team and their agents. Several writers mutate one work tree, and the design fixes the governance bar (architecture decision 7: team-library writes and card promotions go through the harness's existing approval flow — sandbox plus approval — never a permission system invented inside kb). The open decision from the milestone-2 kickoff (待决项 4) is the conflict strategy: branch/PR style promotion versus direct commits plus an approval hook, and where the human review of a promotion sits in between.

## Decision

**The team library is a plain git work tree at `KbConfig.teamRepoPath` (absolute, or relative to the session workspace root), and kb never clones, fetches, or pushes.** The repository is created and pushed through the team's existing git hosting workflow; kb reads the working tree and writes into it. A configured path that does not exist or is not a git work tree fails loud at first use, with the init command (`git init`) in the error message. `git push` is the team's workflow, not a kb tool — kb commits stay local until the team pushes, documented as the boundary.

**Writes are working-tree drafts; commits are an explicit, separate operation.** `kb_team_promote` and the state tools (`kb_review`, `kb_archive`, `kb_revive`) only write or rewrite card files; `kb_team_status` reports the working-tree changes (`git status --porcelain` over `cards/` and `docs/`); `kb_team_commit` stages (`git add -- cards docs`) and commits with a caller-supplied message. The commit is the human review point of the design's "工具生成草稿 → 人复核 → 提交": review the diff the tool produced, then approve the commit. A commit with nothing staged fails loud.

**Team writes sit inside the dsh approval gate.** A `tools/pre-execute` listener returns `{ kind: 'ask', reason }` for the write tool set — `kb_team_promote`, `kb_review`, `kb_archive`, `kb_revive`, `kb_team_commit` — whenever `KbConfig.teamWriteApproval` (default true) is set. The tool runtime routes `ask` through the composed approval service: `allowed-once` runs the call, anything else denies it, and a deployment without an approval service denies (the runtime's existing fail-closed degradation). This is the architecture decision 7 realization: the harness owns permissions, kb only declares which operations are sensitive.

**No branch/PR machinery in kb.** Promotion through pull requests is the team's git hosting workflow and stays outside kb-core: PR review composes with kb by reviewing the pushed branch, and kb's local commits feed that push. kb-core cannot assume a hosting API, credentials, or per-repo review policy, so building PR creation into the plugin would duplicate infrastructure the deployment already owns.

**Concurrency is id-first, not lock-based.** Card ids are unique per library. The personal→team move writes the team file exclusively (`wx`), so a same-id race fails loud instead of overwriting. State transitions are read-modify-write on the current file, so two concurrent transitions of one card can lose an update; that surfaces as a git conflict at the team's next push, and git owns conflict resolution — kb does not build a distributed lock. One active checkout per team repo is the recommended deployment, matching one agent host per workspace.

## Alternatives considered

**Branch/PR promotion driven from kb.** Rejected: it requires a git hosting API, credentials, and per-repo review policy that kb-core cannot assume; the harness's approval seam already provides the local human checkpoint, and the team's push review remains the remote one. kb-architecture decision 7 names approval reuse as the constraint.

**Direct tool commits without an approval gate.** Rejected: the design's dual gate (human review before the reference pool) and architecture decision 7 both require a human checkpoint on shared-content writes; an ungated commit tool would let a model turn rewrite the shared library with no review point.

**A kb-internal permission system.** Rejected outright by architecture decision 7: sandbox plus approval already exist in the harness; a second permission layer would diverge from the deployment's actual policy.

## Consequences

Every team write costs an approval round when `teamWriteApproval` is on (the default), and fails closed without an approval service — headless deployments must compose one or explicitly turn the gate off, which the config documentation states. A `kb_team_commit` without prior writes fails loud with nothing to commit. Uncommitted drafts live in the work tree until the team commits and pushes; concurrent writers on one checkout can lose a same-card update, and the team's push review is where conflicts surface. The `kb/team-join` event records the move into the team library, and the card file's 库: team + 状态 make the rest of the state reconstructable from the session log.
