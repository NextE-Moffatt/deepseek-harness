# dsh-kb-core

[English](README.md) | 中文

个人 + 团队知识库：session workspace 内与共享团队 git 仓库（`cards/` + 文档型 `docs/`）中的 Markdown + YAML 知识卡片，带 FTS5 检索、晋升状态机、双门禁治理与保鲜调度、热度遥测投影、复盘盲点扫描与其可选调度器、方法论技能、`kb_write` / `kb_read` / `kb_search` / `kb_promote` / `kb_gate_check` / `kb_team_promote` / `kb_team_read` / `kb_review` / `kb_archive` / `kb_revive` / `kb_team_status` / `kb_team_commit` / `kb_freshness` / `kb_recap` 工具与会话启动时的知识包注入。设计：[dsh-kb 包组设计与里程碑 1 范围](../../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md)、[知识包与 kb/injected 注入](../../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-inject.md)、[里程碑 3：团队库、治理与遥测](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-3.md) 与 [里程碑 4：复盘盲点检测与方法论技能](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-4-recap-and-skills.md)。

## Service

`ctx.kb`（类 `KbService`，默认导出）持有库的接缝：

| 方法 | 行为 |
|---|---|
| `writeCard(root, input)` | 写入新的个人库草稿卡片；缺省生成 `{type}-YYYYMMDD-{seq}` id，有效期缺省按 `now + cardTtlDays` 计算。 |
| `readCard(root, id)` | 跨层级读取一张卡片；不存在时抛错。 |
| `search(root, request)` | FTS5 BM25 检索，一个工作区根一个索引（`(library, id)` 键），同时覆盖个人库与团队库 + 结构化过滤；索引无法打开时对两库显式降级为 `mode: 'scan'`。 |
| `promote(root, id, target, evidence?)` | 校验状态机、重写卡片文件并返回新状态。 |
| `editCard(root, id, patch, options?)` | 跨两库编辑一张卡片的内容：在 wire 边界校验 patch、保留 `id` / `库` / `状态` 应用、经预期文件身份做并发冲突守卫并原位重写；`teamWriteApproval` 下团队编辑需 `options.approved`。 |
| `promoteToTeam(root, id, evidence)` | 第一道门准入：强制执行门禁规则、把个人草稿以 `pending` 移入团队库并删除个人文件。 |
| `reviewTeam(root, id, approved)` | 第二道门：复核通过时团队 `pending → ready`；不通过则不变更。 |
| `archiveTeam(root, id)` / `reviveTeam(root, id)` | 退场/恢复边：`ready|revived → archived` 与 `archived → revived`。 |
| `teamRead(root, id)` | 读取一张团队卡片；团队库无此卡时抛错。 |
| `teamStatus(root)` / `teamCommit(root, message)` | 团队工作树的 porcelain 状态与暂存 + 提交操作（人复核点）。 |
| `listTeamDocs(root)` / `readTeamDoc(root, docPath)` | `docs/` Wiki 层（仓库相对路径）；docs 永不进入引用池。 |
| `teamDocInfo(root, docPath)` / `writeTeamDoc(root, docPath, content, options?)` / `removeTeamDoc(root, docPath, options?)` | `docs/` Wiki 写面：原位覆盖与删除（逃逸 + `.md` 守卫），由乐观 mtime/size 身份与 `teamWriteApproval` 门守卫；新建留在团队自己的 git 工作流。 |
| `heat(root)` | 热度账本聚合：哪些卡片被哪些会话消费。 |
| `freshnessReview(root, today?)` | 待复核清单：已过期与即将过期的卡片，附热度与建议。 |
| `recap(root, limit)` | 运行一次复盘扫描：找出未记录的盲点、列出至多 `limit` 条并把已列出的位置记入检查点。 |
| `importDir(options)` | 增量采集：从源目录导入卡片形 `*.md`，把无 front matter 的 raw markdown 笔记 wrap 成草稿卡（确定性字段推断），跳过不可 wrap 的文件，经检查点去重；非 markdown 文件跳过并计数。 |

服务方法不持有 session；`kb/*` session 事件由工具追加。后续模块（web 工作台）复用同一接缝。

## Configuration

| 字段 | 默认 | 含义 |
|---|---|---|
| `cardsPath` | `kb/cards` | 相对 session workspace 根目录的库路径；P0–P3 为子目录，卡片文件为 `<id>.md`。 |
| `indexPath` | `kb/.kb-index.sqlite` | 相对 workspace 根目录的 FTS5 索引库路径。 |
| `cardTtlDays` | `90` | 有效期缺省时加算的天数。 |
| `teamRepoPath` | — | 团队库 git 工作树（绝对路径，或相对 session workspace 根）；缺省禁用团队库。 |
| `heatPath` | `kb/.kb-heat.jsonl` | 相对 workspace 根的热度账本路径。 |
| `freshnessWarningDays` | `14` | 距有效期多少天内算"即将过期"。 |
| `freshnessIntervalDays` | `0` | 保鲜扫描间隔天数；`0` 关闭调度器。调度器是每会话的 `ctx.jobs` 任务，需要组合 jobs 服务（挂 `@deepseek-ai/dsh-jobs-local` 与 job 控制器如 `@deepseek-ai/dsh-tool-jobs`）；配置了间隔但无 jobs 服务时每个 context 记一条 loud error。 |
| `teamWriteApproval` | `true` | 团队写工具走审批 `ask` 门；无审批服务时拒绝。 |
| `recapPath` | `kb/.kb-recap.jsonl` | 复盘检查点路径（相对 workspace 根）；检查点记录去重盲点队列的扫描位置。 |
| `recapIntervalDays` | `0` | 复盘扫描间隔天数；`0` 关闭调度器。调度器是每会话的 `ctx.jobs` 任务，需要组合 jobs 服务，同保鲜。 |
| `packs` | `[]` | 会话启动时注入的知识包；见 [Knowledge packs](#knowledge-packs)。 |

非法配置在加载时 loud fail。

## Card spec

卡片遵循统一模板（设计 §4.2）：YAML front matter 含 `id` / `type`（`rule` | `case` | `howto` | `decision`）/ `title` / 库 / 状态 / 适用条件 / 来源 / 责任人 / 有效期 / 标签，正文含 核心结论 / 应做 / 不应做 / 反例 / 踩坑记录。中文键是定稿的用户可见格式，并逐字镜像为 TypeScript 属性名。解析对未知键、缺失必填字段、非法日期与未知枚举值 loud fail；应做 / 不应做 节对导入卡片允许为空，但 `kb_write` 要求每侧至少一项。

## Lifecycle

晋升状态机为 `draft → pending → ready → archived → revived`，`revived → archived` 可再归档；`kb_promote` 只暴露晋升子集（目标 `pending` 与 `ready`）。`revived` 是"已恢复活跃"状态，与从未归档的 `ready` 区分。

## Events

`kb/write`（工具写入卡片文件）、`kb/edit`（工作台或未来编辑消费者修改卡片内容字段）、`kb/promote`（状态流转）、`kb/team-join`（个人卡片经第一道门进入团队库）、`kb/injected`（一次知识包注入）、`kb/recap`（一次复盘扫描的检查点推进）与 `kb/doc-write` / `kb/doc-remove`（经 Web 工作台写入或删除团队 wiki 文档——docs 永不进入引用池）扩展 `SessionEventMap`，均在底层操作成功后追加，模型可见面可从 session 日志回放。

## Knowledge packs

知识包 = 在 `agent/session-start` 注入到每个 agent 会话的订阅卡片集合，在 `KbConfig.packs` 下配置为 `{ name, tags?, tier?, status?, limit? }`（加载时校验：非空唯一 name、闭合枚举成员、正整数 limit）。会话启动时监听器同步读库，按包选择卡片（标签必须全含、tier/status 白名单、缺省排除 `archived`、按 id 升序、按 `limit` 截断），每包追加一条携带渲染卡片节的 `kb/injected` 事件。`kb:pack` prompt section 为每个请求 fold 这些事件，注入内容无需检索步骤即可到达首个模型请求，且仅凭日志即可逐字节回放。注入按"每会话每包一次"（以日志 fold 为守卫）；无 workspace 的会话跳过注入，零命中卡片不追加，单包失败记日志并继续。载荷的 `cardIds` 面向是记账投影按卡片核算热度的记录。

## Extension points

- **检索后端**：`CardIndex`（FTS5 `unicode61`、BM25、按库根目录一个库）可替换；降级契约（`mode: 'scan'` + 说明，绝不编造结果）是接口的一部分。中文按字切分，子串查询无需分词词典。
- **采集接缝**：`importDir` 是模式 E 的最小实现：导入卡片形文件、把 raw markdown 笔记 wrap 成草稿卡并跳过不可 wrap 的文件；`ctx.jobs` 调度随真实连接器落地。
- **包选择**：`selectPackCards`（纯函数）是横跨两库的订阅过滤；未来 `kb_pack` 工具或 web 工作台出现真实消费者时再包装。
- **治理逻辑**：`evaluateGate`、`gradeCard`、`partitionReview` 与 `recommendFreshness`（纯函数）分别是双门禁、质量分级、保鲜分区与基于热度的建议；工具与调度器组合它们。
- **热度投影**：`projectInjectedHeat` + `HeatLedger` 把 `kb/injected` 事件的消费投影进 JSONL 账本；仅凭 session 日志即可重建。
- **复盘扫描**：`runRecapScan` + `RecapCheckpoint` + `detectBlindSpots`（纯函数）扫描 workspace 会话日志找出盲点、用记录位置去重并记录已列出者；`projectRecapScans` 仅凭 session 日志重建检查点。`kb_recap` 工具与可选 `kb-recap` 调度器共用该扫描。
- **技能注册**：有 skills 服务时 `registerKbSkills` 把三个方法论技能挂到 `ctx.skills`；技能正文插值解析器常量，所述卡片规范事实不可能漂移。

## Recap

复盘闭合"用即积累"循环（设计 §5 模式 B）：`kb_recap`（以及 `recapIntervalDays` 下的可选每会话 `kb-recap` 任务）扫描 workspace 的会话日志——`header.cwd` 等于根目录的实时 `ctx.sessions` 会话，优先于可选 `sessionPersistence` 服务中的持久化会话——找出盲点：消费过知识（`kb/injected` 携带卡片 id）但未产出卡片（无 `kb/write`）的会话。扫描列出最近发生的未记录盲点（至多 `limit` 条，默认 10），附有界会话摘录，并把已列出的位置记入 `recapPath` 检查点；每个盲点按会话长度只浮出一次，只有当该会话日志增长后才重新进入队列。扫描绝不伪造卡片内容：模型读清单与摘录后通过 `kb_write` 蒸馏成 P2 草稿，之后双门禁管线原样适用。`kb/recap` 事件携带每次扫描记录的位置与列出的盲点，检查点仅凭这些事件即可重建（`projectRecapScans` + `RecapCheckpoint.writeAll`）。

## Skills

挂载了 `ctx.skills` 服务（如 `@deepseek-ai/dsh-skill`）时注册三个方法论技能：`kb-card-writing`（卡片模板与 §4.3 质量检查清单；类型/层级/状态/库等结构事实插值解析器常量）、`kb-recap-flow`（模式 B 步骤：何时跑 `kb_recap`、如何判断盲点、经 `kb_write` 蒸馏、再走双门禁）、`kb-pack-building`（`tags` / `tier` / `library` / `status` / `limit` 过滤语义）。没有 skills 服务时每个 context 记一条 loud error 并跳过。

## Model Experience

### Tool schemas

#### What the model sees

模型看到的是 [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-kb-core) 中的生成 schema：`kb_write`（tier / type / title / 适用条件 / 核心结论 / 应做 / 不应做 / 来源 / 责任人 / 有效期 / 标签 / 反例，`id` 可选）、`kb_read`（`id`）、`kb_search`（`query` + 可选 `type` / `status` / `tier` / `tags` / `limit`）、`kb_promote`（`id`、`target: pending|ready`、可选 `evidence`）、`kb_gate_check`（`id`、`evidence`）、`kb_team_promote`（`id`、`evidence`）、`kb_team_read`（`id`）、`kb_review`（`id`、`approved`、可选 `note`）、`kb_archive` / `kb_revive`（`id`）、`kb_team_status`（无参）、`kb_team_commit`（`message`）、`kb_freshness`（无参）、`kb_recap`（可选 `limit`，1–50，默认 10）。`kb_write` 的描述内嵌配置的 `cardTtlDays`。

#### Token effect

工具可见的每个请求都有固定的 schema 成本。

#### KV Cache effect

定义与可见性不变时前缀稳定；插件生命周期可能使这些 schema 的复用失效。

### Tool-call results and session events

#### What the model sees

`kb_write` 返回 `{ id, title, type, tier, status: draft, path }` 并记录 `kb/write` 事件；`kb_read` 返回完整卡片 + 层级与路径；`kb_search` 返回 `{ mode: 'fts' | 'scan', total, note?, hits }`，命中始终是真实卡片文件，扫描模式带降级说明；`kb_promote` 返回 `{ id, from, to, title, path }` 并记录 `kb/promote` 事件；`kb_gate_check` 返回 `{ verdict: PASS|BLOCK, reasons, evidenceCount }`；`kb_team_promote` 返回 `{ id, title, status: pending, path }` 并记录 `kb/promote` + `kb/team-join`；`kb_review` 返回 `{ id, title, status, changed, note? }`，通过时记录 `kb/promote`；`kb_archive` / `kb_revive` 返回 `{ id, from, to, title, path }` 并记录 `kb/promote`；`kb_team_status` 返回 `{ clean, files }`；`kb_team_commit` 返回 `{ message, output }`；`kb_freshness` 返回 `{ scanDate, total, overdue, expiringSoon }` 复核条目；`kb_recap` 返回 `{ scanDate, total, listed, entries }`（条目携带盲点会话 id、最后事件时间、消费过的卡片 id 与有界会话摘录），记录位置时追加 `kb/recap` 事件。稳定失败信息：`Error: card not found: <id>`、`Error: invalid card transition <from> → <to> (...)`、`kb_gate_check BLOCK:` 前缀的门禁原因、`Error: limit must be an integer between 1 and 50, got <value>`。

#### Token effect

结果大小随命中数或卡片字段增长；调用参数保留至压缩。

#### KV Cache effect

追加式；新可见内容跟在可复用请求前缀之后，不使既有 KV-cache 条目失效。

### Knowledge-pack injection

#### What the model sees

配置了包的部署，每个请求都携带 `kb:pack` system-prompt section：每个注入包一个 `## 知识包：<name>` 块，每张卡片一个 `### <id>` 标题 + 渲染后的知识字段（标题 / 适用条件 / 核心结论 / 应做 / 不应做 / 可选 反例）。治理元数据（库 / 状态 / 责任人 / 有效期 / 标签）不渲染。

#### Token effect

成本 = 注入卡片渲染的总和；注入后（每会话每包一次）在会话内恒定。

#### KV Cache effect

注入包不变时前缀稳定；该 section 跟在可复用请求前缀之后，不使既有 KV-cache 条目失效。

## Known Limitations and Deferred Work

- **docs 写经 Web 工作台**——`writeTeamDoc` / `removeTeamDoc` 原位覆盖与删除 `docs/` 文件（审批门 + 身份守卫）；docs 新建留在团队自己的 git 工作流，模型面 doc-write 工具与工作台新建文档等真实创作需求落地。
- **kb 从不 clone/fetch/push**——团队仓库的远端同步是团队自己的 git 工作流；kb 的提交停留在本地直到团队推送。
- **热度按 workspace 记账**——`KbConfig.heatPath` 账本只记录本 workspace 的会话；团队库的跨 workspace 聚合是工作台工作。
- **卡片写入无分布式锁**——内容编辑带乐观 mtime/size 冲突守卫（过期编辑大声失败），但状态迁移与并发的 agent 写入仍可能丢失更新；push 时的 git 冲突解决是边界（见 [git 策略 Note](../../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-team-git-strategy.md)）。
- **保鲜调度依赖 jobs 服务**——调度需要组合的 `ctx.jobs` 实现与控制器；没有时按需 `kb_freshness` 工具仍可用，且配置错误会 loud log。
- **复盘调度依赖 jobs 服务**——`kb-recap` 任务与保鲜相同；没有时按需 `kb_recap` 工具仍可用，且配置错误会 loud log。
- **复盘通知就是工具与任务输出**——盲点清单经 `kb_recap` 工具结果与定时任务缓冲输出到达模型；web 待办或 IM 通知渠道是 web 工作台里程碑的决策。
- **盲点按会话长度只浮出一次**——已列出的盲点被记录，直到该会话日志增长才重新列出；历史清单从 `kb/recap` 事件重建。
- **复盘只扫当前进程的实时与持久化会话**——可选 `sessionPersistence` 服务把扫描扩展到持久化日志；harness 之外的跨进程日志存储不扫描。
- **向量/RAG 检索后置**——FTS5 + 结构化过滤是里程碑 6 契约；提供商槽位是 `KbService.search` 背后的 `CardIndex`-shaped 实现，降级契约是它的不变式，触发条件是团队卡 >500 或长文语义检索（设计 §4.4）。
- **Web 工作台与 MCP 暴露在兄弟包中** —— 治理工作台（`@deepseek-ai/dsh-kb-web` + `@deepseek-ai/dsh-client-ui-kb-workbench`）与只读 MCP Server（`@deepseek-ai/dsh-kb-mcp-server`）组合 kb-core；两者均为可选，不在出厂 bundle 中。
- **检索每次同步重新解析全库**——每次 `search` 都重读并重解析所有卡片文件；索引写入按 mtime/size 差异更新，但解析成本与库大小线性。
- **原始笔记 wrap 成草稿卡并带推断字段**——`importDir` 把无 front matter 的 `*.md` 文件 wrap 成 `howto` 草稿（`title` 取首个标题或文件名，`核心结论` 取非标题正文，`适用条件` 取首个内容行，有效期 `now + cardTtlDays`）；front matter 损坏的文件与空笔记保持跳过，工作台编辑修正推断字段。经 `ctx.jobs` 的定时采集仍等待真实连接器。
- **中文检索按字切分**——FTS 索引将中文按字拆开以支持子串查询，无需分词词典；排序与短语语义与分词检索不同，单字查询会命中所有含该字的卡片。
- **文件写入非原子**——卡片写入与采集检查点均为直接写入；中途崩溃可能留下半截文件，store 会将其报告为解析失败。
- **会话启动时同步读库注入**——`agent/session-start` emit 不 await 监听器且首个 prompt 组装紧随其后，选择逻辑使用 store 的同步路径；读取受库规模与包过滤约束。
- **注入按"每会话每包一次"**——同一会话内的新任务与会话开始后的库编辑不会重新注入；包没有运行时场景匹配（配置的包清单就是订阅），workspace 文件化包定义等待 web 工作台。
