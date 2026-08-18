# Agent Note: dsh-kb 里程碑 3 —— 团队库、治理与遥测

Status: implemented

[English](2026-08-19-dsh-kb-milestone-3.md) | 中文

## Problem

里程碑 1 与 2 让个人库闭环与知识包注入成为现实。里程碑 3 必须让团队闭环成为现实：一个团队 Agent 作为引用池消费的共享团队库；让引用池可信的治理（双门禁、质量分级、保鲜、归档/复活）；以及喂给治理的消费记账（热度）。外部设计已定产品决策：团队库是含结构化卡片与文档型 Wiki 长文的 git 仓库（长文永不整篇进引用池）；双门禁只放行已验证的知识；保鲜是 90 天式的周期复核；消费热度来自既有 `kb/*` 事件——session 日志是事实源，绝无第二事件流。

## Decision

**团队库是 `KbConfig.teamRepoPath` 指向的 git 工作树，分 `cards/` 与 `docs/` 两层。** `TeamCardStore` 读写 `cards/` 下的卡片文件（无个人层级——L1–L4 团队层级是 schema 演进，见卡片 schema 版本化 Note），并单独列出/读取 `docs/`，文档型长文永不进入卡片列表、检索索引或知识包选择。构造时根目录不是 git 工作树则 loud fail。git 操作是包在 git CLI 外的薄层 `GitRunner`（exec 可注入）：`status`（porcelain）、`stage`、`commit` 与工作树断言。写操作只落工作树草稿；`kb_team_commit` 是显式提交——即 [git 策略决策](2026-08-19-dsh-kb-team-git-strategy.md) 的人复核点，写工具在 `KbConfig.teamWriteApproval`（默认 true）开启时走审批 `ask` 门，权限归宿主。

**双门禁在准入操作内强制执行，而非只做咨询工具。** `evaluateGate`（纯函数）核验结构性事实——个人草稿、来源链接、非空应做/不应做、非空证据——返回带原因的 PASS/BLOCK。`kb_gate_check` 把结论展示给模型；`kb_team_promote` 调用同一规则，BLOCK 时在写任何东西之前抛错，然后把卡片以 `pending` 移入团队库并删除个人文件，追加 `kb/promote`（状态流转）与 `kb/team-join`（迁移，含新路径）。第二道门是 `kb_review`：复核通过时团队 `pending → ready`（引用池）；不通过则不变更。`kb_promote` 拒绝团队库卡片并给出指引，晋升子集无法绕过复核门。`kb_archive` / `kb_revive` 暴露状态机里 `kb_promote` 从未暴露的退场/恢复边（`ready|revived → archived`、`archived → revived`）。

**质量分级是派生值，绝不存储。** `gradeCard` 把状态 + 有效期映射到设计的三级：`verified`（有效期内的 ready/revived）、`pending`（draft/pending）、`verify`（过期或已归档）。无新卡片字段、无迁移——卡片 schema 保持 schema 版本化 Note 的决策。

**保鲜是纯分区 + 每会话的 `ctx.jobs` 调度器。** `freshnessReview` 扫描两库，为每张卡片挂上账本热度，派生出保鲜位置（已过期 / `KbConfig.freshnessWarningDays`（默认 14）内即将过期）与建议（复核续期 / 待复核 / 过期且零引用的归档候选 / 已归档且仍有热度的复活候选），按 id 升序分区并渲染为待复核清单。`kb_freshness` 工具按需返回清单（工具结果即日志记录）。`KbConfig.freshnessIntervalDays` 为正时，`registerFreshnessSchedule` 在 `agent/session-start` 为每个会话启动一个 owner 作用域的 `kb-freshness` 任务：立即扫描一次，然后按天倒数计时（天级间隔超过 Node 定时器钳制上限），渲染后的清单作为任务输出缓冲。配置了间隔但无 jobs 服务时每个 context 记一条 loud error 并跳过调度——最早可解析点。

**遥测从 session 日志投影热度；账本是持久投影，绝不是第二事件流。** `kb/injected` 的 `cardIds` 面正是为此预留：`projectInjectedHeat` 为每个事件每张卡片产出一条 `HeatEntry`，`HeatLedger` 以 JSONL 追加到 `KbConfig.heatPath`（默认 `kb/.kb-heat.jsonl`），`aggregateHeat` 聚合成按卡片的行（次数、最近访问、去重会话与知识包）。实时监听器消费 `session/event` 派发（`internal/dispatch`，global）并追加；重建路径（对投影日志跑 `writeAll`）仅凭 session 日志即可复现账本。遥测失败记日志并继续——投影绝不能打断循环。账本喂给保鲜建议（归档候选 vs 复核续期就是热度决策）与未来的复活/晋升信号。

**知识包横跨两库。** `KnowledgePack` 新增可选 `library` 白名单（缺省选择两库）；选择逻辑消费 `PackEntry`（卡片 + 可选个人层级 + 路径），团队条目无需假层级即可参与，层级过滤永不命中团队条目。会话启动注入读个人库，配置了团队库时也读团队库；配置了但不可读的团队仓库记日志并继续个人侧。`kb/injected` 不变——包名、`cardIds` 与渲染节以同样方式携带团队卡片，里程碑 2 的 fold 与遥测投影无需改动即可消费。

## Alternatives considered

**工具直接提交团队写操作。** git 策略决策否决：人复核点必须落在提交处，审批门覆盖共享内容写入。

**为第三级新增 `verify` 生命周期状态。** 拒绝：闭合状态集（`draft/pending/ready/archived/revived`）是晋升管线的词表且 invariant 伴生镜像它；设计的第三层是可信度*分级*，从状态 + 有效期派生保持单一事实源。

**无会话的部署级保鲜任务。** 拒绝：扫描需要 workspace 根（卡片按 workspace 存放），且宿主的任务是 owner 作用域的；每会话任务镜像注入模式并随 owner 消亡。

**为消费另起第二事件流。** 设计直接否决（"记账一个家"）：`kb/injected` 已带按卡片的面，账本是带重建路径的投影，不是并行记录。

**自动归档/复活流转。** 拒绝：状态机边归显式工具；保鲜扫描只*建议*（归档候选 / 复活候选），流转由人或模型执行——即设计的"人只做高价值复核"。

## Consequences

团队闭环在一个包内闭合：晋升 → 复核 → 提交 → 知识包注入 → 热度投影 → 保鲜复核，全程可从 session 日志回放。`teamWriteApproval` 开启时团队写工具消耗审批轮次，无审批服务则拒绝；审批故事写进配置与 git 策略 Note。里程碑 3 的热度按 workspace 记账——团队库的跨 workspace 聚合是 web 工作台的工作，作为限制写入文档。保鲜调度器需要组合的 jobs 服务；没有时按需工具仍可用，配置错误 loud log。团队检索保持仅个人库（`kb_search` 不变）；引用池经 `kb_team_read` 与知识包注入可达，统一检索是 kb-search 升级路径。`kb/team-join` 事件与其余仓库内 `kb/*` 事件一样进入生成词表，无需 `ignorable` 标记、无需 session 格式升级。
