# Agent Note：dsh-kb 里程碑 7 —— 文档导入与工作台卡片编辑

Status: implemented

[English](2026-08-19-dsh-kb-milestone-7-doc-import-and-workbench-edit.md) | 中文

## Problem

里程碑 1–6 已关闭 agent 闭环：卡片写/读/检索、知识包、团队治理、复盘、Web 工作台、只读 MCP 暴露与统一双库检索。对照产品方向（WorkBuddy 式知识内核，安全/运维/运营场景）还剩两个缺口：摄入面把团队存量文档当死重——`importDir` 只解析卡形 `*.md`，所有 raw note 计为跳过，知识库无法吸收团队既有 markdown 存量；人机工作台对卡片内容只读，导入或 agent 蒸馏后的字段无法人工修正（[里程碑 5 note](2026-08-19-dsh-kb-milestone-5-workbench-and-mcp.md) 刻意否决了卡片编辑操作）。里程碑 7（B1+B2）补齐**存量入口**（文档导入）与**人机协同治理**（工作台编辑）两条路径。

## Decision

**B1——`importDir` 把 raw markdown 笔记 wrap 成草稿卡，不再跳过。** wrap 规则集：不以 `---` front matter 围栏开头、且至少有一行非标题内容的 `*.md` 文件被 wrap；推断出的卡片以个人库 `draft` 落在调用方 tier（默认 P2），`有效期` = 今天 + `cardTtlDays`（新增 `ImportOptions.cardTtlDays`，默认 90；`KbService.importDir` 转发自身配置值，显式选项优先）。字段推断是确定性的：`title` = 首个 `# ` 标题行，回退到去扩展名的文件名；`核心结论` = 正文非标题、非空行以 `\n` 连接，截断到 1000 字符；`适用条件` = 正文首个非标题、非空行，截断到 200 字符（解析器要求 `适用条件` 非空，故"首行"取代不可能的"默认空"）；`type` = `howto`（通用运维文档默认——raw note 无可靠推断）；`应做`/`不应做` = 空数组（解析器允许导入卡为空；`kb_write` 的至少一项规则留在工具侧）；`标签` = 文件相对源目录的直属父目录名作为单一标签（至少嵌套一层时），直接在源目录下则无标签；`来源` = 源文件路径；`责任人` = 固定标记 `导入`（导入方未知，工作台人后续修正）。结论与适用条件抽取时丢弃标题行，序列化后的卡片永不携带会破坏再解析的 `## ` 行首。checkpoint 记录 wrap 卡生成的 id，与卡形导入完全一致——源文件变更后重新 wrap 进同一张卡原位更新，保留卡片当前 `状态`（既有再导入契约）；未变的 wrap 文件经 checkpoint 跳过。以 `---` 开头但卡解析失败的文件是坏卡，绝不 wrap——wrap 会静默毁掉用户意图的卡片结构——跳过并计数。空文件或纯标题文件跳过并计数。非 `.md` 文件现在被枚举、跳过并计入 `skippedRaw`（此前对 walker 不可见）；不写 checkpoint，每次运行重新计数被忽略的文件。

**B2——工作台经一个新增 Remote 与一个新增 service 方法编辑卡片内容。** `KbService.editCard(root, id, patch, options?)` 跨个人/团队库解析卡片（同 `card`），在 wire 边界校验 patch（封闭字段集、封闭枚举、日历日期、非空字符串、标签列表、`应做`/`不应做` 数组可为空），应用时保留 `id` / `库` / `状态`（身份、换库、状态迁移分别留在双门禁与状态机），经 `PersonalCardStore.rewrite` 或 `TeamCardStore.rewrite` 原位重写。可编辑字段：`type`、`title`、`适用条件`、`核心结论`、`应做`、`不应做`、`反例`、`来源`、`责任人`、`有效期`、`标签`。个人库与团队库同权；`KbConfig.teamWriteApproval` 为 true（默认）时团队卡编辑必须在请求中携带 `approved: true`，在 `editCard` 内部强制——即"在做出决策的操作中强制执行"——因为人工作台没有独立的审批者（人本身就是审批者；工具 `ask` seam 需要 open turn 与已组合的审批服务，工作台组合两者都不保证）。个人编辑永不需要审批；模型工具路径保留不变的 `tools/pre-execute` ask 门。每次编辑在写入成功后向工作台会话自身日志追加 `kb/edit`——`{ id, library, fields }`，fields 为变更字段名列表；卡片文件仍是内容唯一事实源（`kb/write` 模式）。所有字段均未变化的编辑不写盘、不追加事件。里程碑 5"工作台不做卡片内容编辑"的决策对工作台被取代；本 note 交叉链接（部分取代，两 note 都保持活跃）。

**B2 并发是轻量乐观守卫，不是锁。** `KbWorkbenchCard` 增加 `mtime` / `size`（ingest checkpoint 已在用的文件身份）。编辑请求携带详情加载时观察到的预期 `{ mtime, size }`；`editCard` 重新读文件，磁盘身份不一致即抛冲突错误（「卡片已被其他会话修改，请刷新后重试」）。完整锁延后（D2）并记录触发条件；mtime+size 身份保留文档化的残余——文件系统 mtime 粒度内同尺寸编辑。

## Alternatives considered

**所有 `*.md` 一律 wrap，包括 front matter 损坏的。** 否决：以 `---` 开头的文件是试图写的卡片，把它转成 `howto` 笔记会静默毁掉用户意图的结构；跳过它让解析失败保持可见，作者去修卡。

**用内容启发式（关键词打分）推断 wrap 卡的 `type`、用文件名推断标签。** 否决：任意 raw note 上没有可靠信号，关键词打分是第二个无消费者的手搓分类器，逐文件标签每卡唯一——对知识包订阅无用。固定 `howto` 默认与目录派生单标签是确定且可教的；工作台编辑负责改类目。

**工作台团队编辑走工具 `ask` 审批 seam（`approval.request`）。** 否决：该 seam 要求会话处于 open turn 且有已组合的审批服务——工作台会话在交付组合中两者皆无——且人点保存本身就是审批者，ask 只是自我审批的表演。在 `editCard` 内强制的显式 `approved` 标志把审批决策随操作携带，且闭路退化（缺标志即在默认策略下拒绝团队编辑）。

**用内容 hash 守卫编辑。** 否决：ingest checkpoint 已把文件身份定义为 mtime+size，hash 会给每次编辑加一次全文读取；同一身份及其文档化的亚秒残余同样适用。

## Consequences

`packages/kb/kb-core/src/ingest.ts` 增加 wrap 路径（raw note 推断、非 `.md` 计数、wrap id 的 checkpoint 往返）与 `ImportOptions.cardTtlDays`；`KbService.importDir` 转发配置默认值。`KbService.editCard` 与 `kb/edit` 事件落地 kb-core：事件进入 `SessionEventMap`、`KNOWN_SESSION_EVENT_TYPES`、生成的 persistence catalog 与 invariant companion 的 `validateEdit`。`packages/kb/kb-web` 增加 `@Remote('edit')`（薄包装：解析 → editCard → 追加 `kb/edit` → 返回刷新后的卡片视图），`KbWorkbenchCard` 携带 `mtime`/`size` 供冲突检查。工作台客户端在卡片详情加"编辑"入口：内容字段编辑表单、团队编辑确认、冲突错误路径刷新详情。keyless 组装快照 lane 经 connection fixture（`kbWorkbench/edit`）增加编辑用例；golden 文件重录。消费面不变：kb 工具（无新工具）、只读 MCP server、知识包注入（读 `list()` 面）、统一双库检索（索引在下次查询时按 mtime/size 重同步编辑过的文件）。测试：所有改动 src 文件 per-file 100%——ingest spec 的 wrap 矩阵、新增 edit spec、invariant spec 的 `kb/edit` 用例、kb-web spec 的编辑/审批/冲突用例、loader-composition 链（经 Loader 真实工作区编辑）、client 组件 spec 的编辑表单用例。文档更新：`docs/subsystems/kb.md` + zh（会话事件、工作台段）、persistence catalog + zh、kb-core/kb-web/ui-kb-workbench 三份 README + zh（raw-note 导入与无卡片编辑两条 limitation 被交付行为替换）、生成的 cordis catalog。

按触发条件延后并记录在 README：B3 团队 docs web 写（放宽只读边界决策）、模型面 `kb_edit` 工具（模型编辑流）、工作台 tier 迁移（用户需求）、完整编辑锁 D2（真实并发编辑证据）。
