# Agent Note：dsh-kb 里程碑 8 —— 团队 docs Web 写（B3）

Status: implemented

[English](2026-08-20-dsh-kb-milestone-8-team-docs-web-write.md) | 中文

## Problem

里程碑 1–7 已关闭 agent 闭环与人机闭环：卡片写/读/检索、知识包、团队治理、复盘、Web 工作台（只读生命周期，随后是[里程碑 7](2026-08-19-dsh-kb-milestone-7-doc-import-and-workbench-edit.md)的卡片内容编辑）、只读 MCP 暴露、统一双库检索与 raw-note 导入。B3 的触发条件——"放宽只读边界的决策"——在里程碑 7 B2 为卡片内容放宽同一边界时（团队卡编辑同权 + 审批门）即已满足。剩下唯一的人写缺口是团队库的 `docs/` wiki 层：`KbService.listTeamDocs` / `readTeamDoc` 已暴露读面、工作台已能列出并读取 docs，但没有人的路径写入或删除 wiki 文档——人无法从 Web 面修正或维护团队 wiki，团队知识库的人机协同治理缺最后一条写路径。

## Decision

**B3——工作台经一对新增 service 方法、三个新增 Remote 与两个新增会话事件写团队 docs。** 操作是覆盖（`KbService.writeTeamDoc`）与删除（`KbService.removeTeamDoc`）。新建留在团队自己的 git 工作流（wiki 是团队的创作面；工作台治理既有内容，与 docs-are-for-humans 契约一致），重命名/移动是工作树里的删除 + 写入，同样不在范围。路径边界是 `readDoc` 已强制的同款逃逸拒绝——`resolve(root, docPath)` 必须留在 `docs/` 内——且写/删额外要求 `.md` 扩展名，使工作台触碰的每个文档都可被 `listDocs`（仅 `.md`）列出。内容为非空 trim 后的字符串；空文档是配置错误，大声失败。

**审批门与乐观守卫从 B2 原样迁移。** docs 只存在于团队库，因此每次写与删都走团队门：`KbConfig.teamWriteApproval`（默认 true）下 `writeTeamDoc` / `removeTeamDoc` 要求 `options.approved`，在做出决策的操作内部强制——人工作台的确认就是审批信号，与 B2 卡片编辑完全一致（无 open agent turn，人即审批者）。文档文件身份是 mtime + size（与卡片同处一个工作树）；`writeTeamDoc` 接受 `options.expected`，磁盘身份不一致或文档已消失时抛与 `editCard` 相同的冲突错误。`removeTeamDoc` 是终结操作、不带身份守卫：git 工作树加显式 `kb_team_commit` 保留历史，删除所见文件后的陈旧删除可恢复。

**写事实是会话事件；docs 仍永不进入模型引用池。** `kb/doc-write`（`{ path, size }`）与 `kb/doc-remove`（`{ path }`）进入 `SessionEventMap`、`KNOWN_SESSION_EVENT_TYPES`、persistence catalog 与 `@deepseek-ai/dsh-kb-core` invariant companion（`validateDocWrite` / `validateDocRemove`）。工作台在写成功后向工作台会话自身日志追加它们，使人的 doc 写成为像 `kb/edit` 一样可自日志重建的会话事实——模型可见 ⟺ 已记录不变量对"人写侧"成立。docs 纪律不变且被重申：docs 永不进入卡片列表、检索索引、引用池、知识包注入、保鲜、热度或复盘——这些面只读卡片。

**Remote 面与 UI 块是 B2 模式。** `KbWorkbenchService` 增加 `@Remote('listDocs')`、`@Remote('readDoc')`、`@Remote('writeDoc')` 与 `@Remote('removeDoc')`；`KbWorkbenchDoc` 携带 `{ path, content, mtime, size }`（冲突守卫期望的身份，同 `KbWorkbenchCard`）。`writeDoc` / `removeDoc` 包装 service 方法并追加事件，`writeDoc` 随后返回刷新后的文档视图。工作台区段增加团队 docs 块：文档列表、读视图、编辑表单与带团队确认的删除动作（与卡片编辑同款确认）。

## Alternatives considered

**工作台内新建 + 完整重命名/移动。** 否决：git 工作树拥有新建与重命名语义，里程碑范围（列、读、编辑）不需要它们；交付无守卫的新建还会打开第二条无身份写路径，正是 B2 并发叙事刻意回避的。

**doc 写走工具 `ask` 审批 seam。** 因 B2 的理由否决：seam 要求 open agent turn 与已组合的审批服务，工作台组合两者皆无保证，且人点保存本身就是审批者——随操作携带的显式 `approved` 标志才是强制点。

**用内容 hash 守卫写。** 否决：mtime + size 身份从卡片与 ingest checkpoint 原样迁移，hash 会给每次写加一次全文读取；该身份文档化的亚秒残余同样适用。

**一个带 `operation` 字段的共享 `kb/doc` 事件。** 否决：操作就是载荷的判别项，两个事件让日志无需发明字段即可重建——与 `kb/write` 事件和缺失的卡片删除路径画出的分界相同。

**给 docs 内容设 size 上限。** 否决：wiki 文档天然可以很长，卡片内容没有上限，任意天花板会挡住真实文档；wire 边界、封闭路径契约与审批门已界定表面。

## Consequences

`packages/kb/kb-core`：`TeamCardStore` 增加 `writeDoc` / `removeDoc` / `docInfo`（与读面共享逃逸 + `.md` 守卫），`KbService` 增加 `writeTeamDoc` / `removeTeamDoc` / `teamDocInfo`，带审批门、乐观身份守卫与大声失败；两个事件进入会话词汇与 invariant companion。`packages/kb/kb-web` 增加四个 Remote 与 `KbWorkbenchDoc`，成功后追加 `kb/doc-write` / `kb/doc-remove`。`packages/client/ui-kb-workbench` 增加团队 docs 块（列表 / 读 / 编辑 / 带团队确认的删除）。keyless 组装快照 lane 经 connection fixture（`kbWorkbench/listDocs` / `readDoc` / `writeDoc` / `removeDoc`）增加 docs 用例；golden 重录。消费面不变：无新工具、只读 MCP server 不动、注入与检索只读卡片、docs 仍在引用池之外。测试：所有改动 src 文件 per-file 100%——store doc spec、service doc-edit spec（审批 / 冲突 / 逃逸 / 扩展名）、invariant spec 的 `kb/doc-*` 用例、kb-web spec 的 doc 用例、loader-composition 链（经 Loader 真实 doc 写/删）、client 组件 spec 的 docs 块用例。文档更新：`docs/subsystems/kb.md` + zh（团队库、会话事件、工作台段）、persistence catalog + zh、kb-core/kb-web/ui-kb-workbench 三份 README + zh（"docs 对 agent 只读"limitation 被交付的工作台写替换）、生成的 cordis catalog。

按触发条件延后并记录在 README：模型面 doc-write 工具（模型创作流）、工作台内新建 doc（真实 wiki 创作需求）、重命名/移动 UI（内容卫生需求）。
