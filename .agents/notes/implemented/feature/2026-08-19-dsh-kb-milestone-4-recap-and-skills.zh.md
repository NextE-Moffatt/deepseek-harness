# Agent Note: dsh-kb 里程碑 4 —— 复盘盲点判定、蒸馏策略与方法论技能

Status: implemented

[English](2026-08-19-dsh-kb-milestone-4-recap-and-skills.md) | 中文

## Problem

里程碑 1–3 已经闭环：个人库、知识包注入、团队库双门禁、保鲜、热度遥测投影。飞轮的"用即积累"还差自动积累这条腿：一个消费了注入知识却没有写任何卡片的会话，消费发生了、积累没有发生，而没有任何机制去扫会话日志找出这些盲点。里程碑 4 必须补上复盘这条腿——扫本 workspace 的会话日志、找出"消费而未沉淀"的会话、把它们蒸馏成草稿卡片——并沉淀方法论技能（卡片写作规范、复盘流程、知识包构建），让模型遵循与代码同一套规则。设计留给本里程碑的待决项（待决项 6、设计 §9 周 6）是：什么算盲点、蒸馏何时触发、新草稿如何与既有卡片去重、复盘如何从 session 日志可重建、复盘清单走哪个通知渠道。

## Decision

**盲点 = 消费过知识但未产出卡片的 workspace 会话。** 由会话自己的日志判定：至少一个 `cardIds` 非空的 `kb/injected` 事件（消费事实，与热度遥测投影用的是同一个面）且整个日志中没有任何 `kb/write` 事件（产出事实）。没有注入、或写过卡片的会话都是健康的。判定是结构性的，与 `evaluateGate` 完全同类：只查事件存在性，不查语义。

**扫描是确定性机制，蒸馏是模型动作。** `runRecapScan` 读取本 workspace 的会话日志（`header.cwd` 等于 root 的实时 `ctx.sessions` 会话，优先于可选 `ctx.sessionPersistence` 服务里的持久化会话；重复时实时优先），计算盲点，为每个盲点渲染有界的会话摘录（消息流的尾部，上限 `RECAP_EXCERPT_MAX_CHARS`），并把记录的位置追加进检查点。复盘绝不伪造卡片内容：模型读清单与摘录，通过既有 `kb_write` 路径把草稿写进 P2，之后里程碑 3 的双门禁管线（`kb_gate_check` / `kb_team_promote` / `kb_review`）原样适用。每条清单项携带该会话消费过的卡片 id，供模型对照既有卡片判断覆盖度——语义判断留在模型侧，正如第一道门只查结构、信任模型的证据声明。

**去重 = 按会话的扫描位置检查点。** `RecapCheckpoint` 是 `KbConfig.recapPath`（默认 `kb/.kb-recap.jsonl`）下的 JSONL 文件，记录 `{ sessionId, eventCount }` 位置。只有当某会话的位置未被记录到当前日志长度时，它的盲点才会被列出；列出即记录位置，所以每个盲点按会话长度只浮出一次，只有当该会话日志增长后才再次列出（新活动 = 新的蒸馏机会）。`kb_recap` 带可选 `limit`（1–50，默认 10）；超出限额的盲点保持未记录，反复调用即可翻页消化队列。写过卡片的会话不是盲点、不需要位置——检查点只保存已列出的盲点。

**检查点是投影，`kb/recap` 事件是持久事实。** 扫描在检查点写入成功后追加新的 `kb/recap` 会话事件，携带 `{ scanDate, scanned: {sessionId, eventCount}[], blindSpots: {sessionId, at, consumed}[], total, listed }`。对任意会话日志跑 `projectRecapScans` 再 `RecapCheckpoint.writeAll` 即可仅凭 session 日志重建检查点——这是 `HeatLedger` 模式，不是第二条事件流。摘录是所引用会话自身日志的纯函数，清单可重新推导；`kb/recap` 事件与仓库内其它 `kb/*` 事件一样进入生成的知识词表，因此无需 `ignorable` 标记、无需 session 格式升版。工具驱动的清单渲染随工具调用/结果事件落日志，与 `kb_freshness` 相同。

**两个入口跑同一个扫描。** `kb_recap` 工具（按需）与每会话 owner 域内 `kb-recap` 的 `ctx.jobs` 任务（`KbConfig.recapIntervalDays` 为正时在 `agent/session-start` 启动；一次立即扫描后按天递减计时，形状同保鲜调度器）共用 `runRecapScan`。任务捕获其 owner agent，把 `kb/recap` 事件追加进 owner 会话，因此任务驱动的检查点推进同样留痕。配置了间隔却没有 jobs 服务时，每个上下文记一次响亮错误并跳过；无 cwd 的会话跳过。

**通知渠道后置。** 复盘产出通过三条路到达模型：`kb_recap` 工具结果、定时任务缓冲输出（经 jobs 工具读取）、`kb/recap` 事件。Web 待办还是 IM 推送是 web 工作台里程碑的决策，作为遗留问题记录。

**kb-skills 向 `ctx.skills` 注册三个运行时技能**：`kb-card-writing`（§4.3 检查清单与卡片模板；类型/层级/状态/库等结构事实从 `card.ts` 常量插值生成，文本不可能与解析器漂移）、`kb-recap-flow`（模式 B 步骤：何时跑 `kb_recap`、如何判断盲点、经 `kb_write` 蒸馏进 P2、再走双门禁）、`kb-pack-building`（知识包 `tags` / `tier` / `library` / `status` / `limit` 过滤语义）。技能正文由代码校验所用的同一批常量生成——卡片规范绝不手抄第二份。注册是可选的：没有 `skills` 服务的上下文记一次响亮错误并跳过。

## Alternatives considered

**语义化盲点检测（让 LLM 扫日志）。** 拒绝：不确定、不可测，而"模型可见 ⟺ 已记录"不变式需要确定性机制；语义判断属于蒸馏步骤——模型读确定性的清单，决定写什么。

**复盘自动写占位/骨架卡片。** 拒绝：没有模型参与就写卡片内容等于伪造知识；设计的"敢于不沉淀"意味着跳过是合法结局，只有模型能判断。

**检查点记录所有被扫描的会话。** 拒绝：会把超出工具限额的盲点也记掉、从模型眼前藏起来；只记录已列出的盲点才能保持队列可翻页、每个盲点恰好可见一次。

**复盘依赖 `dsh-session-query` 拿日志语料。** 拒绝：扫描只需要会话日志表面——实时会话加可选持久化服务，`dsh-session` 类型加一次可选的 `ctx.get('sessionPersistence')` 就够；把整套 FTS 查询栈拖进 kb-core 会让两个包为一个"列出+折叠"耦合。

**技能文本从文档手抄。** 拒绝：技能正文插值解析器自己的常量，枚举或模板一旦变更，技能文本不可能过期。

## Consequences

kb-core 新增两个 peer 依赖：`@deepseek-ai/dsh-skill`（`ctx.skills` 注册表类型）与 `@deepseek-ai/dsh-session-persistence`（可选持久化日志表面，仅类型 + `ctx.get`）。`kb/recap` 事件扩展 `SessionEventMap`，不变式伴生插件校验其载荷。复盘契约是：每个盲点按会话长度浮出一次；历史清单与检查点可从 `kb/recap` 事件重建；会话增长后重新进入队列。定时复盘需要组合了 jobs 服务，与保鲜相同——没有时按需工具照常可用、配置错误响亮记录。两个新 peer 依赖在运行时都是可选的——没有技能或持久化服务的部署得到响亮日志与仅实时会话的扫描，绝不会崩溃。
