# Agent Note: dsh-kb 团队库 git 策略——草稿、复核、审批门内提交

Status: implemented

[English](2026-08-19-dsh-kb-team-git-strategy.md) | 中文

## Problem

团队库是共享 git 仓库：结构化卡片在 `cards/`、文档型 Wiki 长文在 `docs/`，全团队及其 Agent 共同消费。多个写者改同一个工作树，且设计已定治理红线（架构决策 7：团队库写操作与卡片晋升走 dsh 现有审批流程——sandbox + 审批，绝不在 kb 内自造权限系统）。里程碑 2 kickoff 的待决项 4 是冲突策略：分支 PR 式晋升 vs 直接提交 + 审批钩子，以及人复核在其中的位置。

## Decision

**团队库是一个普通 git 工作树，路径由 `KbConfig.teamRepoPath` 配置（绝对路径，或相对会话 workspace 根），kb 从不 clone/fetch/push。** 仓库的创建与推送走团队现有 git 托管流程；kb 只读写工作树。配置了路径但目录不存在或不是 git 工作树时，首次使用即 loud fail，错误信息附初始化命令（`git init`）。`git push` 是团队自己的工作流而非 kb 工具——kb 的提交停留在本地直到团队推送，这一点作为边界写进文档。

**写操作只落工作树草稿；提交是显式的独立操作。** `kb_team_promote` 与状态工具（`kb_review`、`kb_archive`、`kb_revive`）只写/重写卡片文件；`kb_team_status` 报告工作树变更（`git status --porcelain`，限定 `cards/` 与 `docs/`）；`kb_team_commit` 暂存（`git add -- cards docs`）并以调用方提供的 message 提交。提交就是设计"工具生成草稿 → 人复核 → 提交"的人复核点：先看工具产出的 diff，再批准提交。无变更可提交时 loud fail。

**团队写操作在 dsh 审批门内。** `tools/pre-execute` 监听器对写工具集——`kb_team_promote`、`kb_review`、`kb_archive`、`kb_revive`、`kb_team_commit`——在 `KbConfig.teamWriteApproval`（默认 true）开启时返回 `{ kind: 'ask', reason }`。工具运行时把 `ask` 交给组合的审批服务：`allowed-once` 放行，其余一律拒绝；未组合审批服务的部署同样拒绝（运行时既有 fail-closed 降级）。这就是架构决策 7 的落地：权限归宿主，kb 只声明哪些操作敏感。

**kb 内不做分支/PR 机制。** 通过 pull request 晋升是团队 git 托管的工作流，留在 kb-core 之外：PR 复核与 kb 的配合方式是复核被推送的分支，kb 的本地提交喂养那次推送。kb-core 无法假设托管 API、凭据或仓库级复核策略，把建 PR 做进插件等于重复部署已经拥有的基础设施。

**并发以 id 为先，不加锁。** 卡片 id 在库内唯一。个人→团队迁移以排他创建（`wx`）写团队文件，同 id 竞争 loud fail 而非覆盖。状态迁移是对当前文件的读-改-写，同一张卡片的两个并发迁移可能丢失一次更新；这会在团队下次 push 时以 git 冲突形式浮出，冲突解决归 git——kb 不造分布式锁。每团队库单一活跃 checkout 是推荐部署形态，与每 workspace 一个 agent 主机一致。

## Alternatives considered

**由 kb 驱动分支/PR 晋升。** 拒绝：需要托管 API、凭据与仓库级复核策略，kb-core 无法假设；宿主审批 seam 已经提供本地人复核点，团队推送复核仍是远端那一道。kb-architecture 决策 7 把"复用审批"定为约束。

**无审批门的直接工具提交。** 拒绝：设计的双门禁（进引用池前人复核）与架构决策 7 都要求在共享内容写入时有人复核点；无门提交工具会让一次模型回合无复核点地改写共享库。

**kb 内自造权限系统。** 架构决策 7 直接否决：sandbox + 审批已在宿主中，第二套权限层会与部署实际策略分叉。

## Consequences

`teamWriteApproval` 开启（默认）时每次团队写都消耗一次审批轮次，无审批服务则 fail closed——无头部署要么组合审批服务，要么显式关掉该门，配置文档写明这一点。无先前写操作时 `kb_team_commit` 会因无内容可提交而 loud fail。未提交草稿停留在工作树直到团队提交并推送；单 checkout 的并发写者可能丢失同一卡片的更新，冲突在团队推送复核时浮出。`kb/team-join` 事件记录进入团队库的迁移，卡片文件的 库: team 与 状态 让其余状态都能从 session 日志重建。
