# Agent Note：dsh-kb 里程碑 5 —— Web 治理工作台、飞轮看板与只读 MCP Server

Status: implemented

[English](2026-08-19-dsh-kb-milestone-5-workbench-and-mcp.md) | 中文

## Problem

里程碑 1–4 关上了模型侧闭环：卡片写/读/检索、知识包注入、带双门禁的团队库、保鲜、热度遥测、复盘盲点检测与方法论技能。人的界面仍然缺失：待复核清单（保鲜 + 复盘盲点）与飞轮指标只通过工具结果到达模型，人没有工作台，复核队列也没有通知渠道。引用池也无法被 Harness 之外消费：`packages/mcp/mcp-client` 把外部 MCP Server 桥接进来，但没有任何东西把知识库作为 MCP Server 暴露出去。里程碑 5 必须先定工作台范围、通知渠道与 MCP 暴露边界，再实现最小闭环。

## Decision

**工作台是设置页的一个 section，由一个主机侧 Remote 服务驱动。** 新包 `@deepseek-ai/dsh-kb-web`（`packages/kb/kb-web`）暴露 `ctx.kbWorkbench`（`KbWorkbenchService extends TypertRemoteService`，namespace `kbWorkbench`），带 `@Remote` 方法：`overview`（合并待复核清单 + 飞轮指标）、`card`（单张完整卡片）、以及生命周期动作 `promote` / `archive` / `revive` / `review`。浏览器侧是新客户端插件 `@deepseek-ai/dsh-client-ui-kb-workbench`（`packages/client/ui-kb-workbench`），注册 `settings.section` 条目 id `kb-workbench`（导航文案 知识库），渲染待复核清单、卡片详情、动作按钮与飞轮看板。每个 Remote 方法第一个参数是 session（`session` Typert lookup 在线上携带 session id）；主机侧从 `session.header.cwd` 推导工作区根。工作台是可选组合：部署通过自己的 `cordis.yml` 挂载 `@deepseek-ai/dsh-kb-core` + `@deepseek-ai/dsh-kb-web` + 客户端插件，`examples/kb-web/cordis.yml` 是文档化的 overlay。出厂 bundle 默认值不变：kb 与里程碑 1–4 一样不进入 `packages/bundle/web-app`。

**工作台动作是既有 `ctx.kb` 方法的薄事件追加包装——不另造状态机。** 每个动作执行对应工具执行的同一个服务调用——`ctx.kb.promote`、`archiveTeam`、`reviveTeam`、`reviewTeam`——然后向工作台所在 session 自己的日志追加工具追加的同一个 `kb/*` 事件（携带迁移的 `kb/promote`；被拒的 `review` 与 `kb_review` 一样不追加）。人的点击是 session 事实，与工具调用一样可从 session 日志重建，因此写侧满足"模型可见 ⟺ 已记录"。卡片内容编辑刻意不是动作：kb 没有带既定事件语义的编辑操作，为一个 UI 诉求发明新操作会造出第二条变更路径；改卡片内容仍是模型任务，走 `kb_write`（新草稿）+ 双门禁。工作台动作集恰好是既有 seam 已支持的生命周期迁移。

**待复核清单合并两个既有读面，飞轮指标是纯投影。** `overview` 返回保鲜复核（`kb.freshnessReview`）、未记录的复盘盲点（`liveRecapLogSource` + `RecapCheckpoint` 读取 + `detectBlindSpots`——只检测不记录，工作台永不推进检查点，工具/调度器的队列语义不受影响）、热度账本（`kb.heat`），以及从同一批数据面投影的五个飞轮指标：注入次数（热度账本合计）、热度 Top 卡片（带标题的前三热度行）、晋升总数（对复盘日志源上的 `kb/promote` 事件做折叠）、待复核数（保鲜 overdue + expiring-soon）、未记录盲点数。不存在第二事件流：每个数字都来自 `kb/*` 事件或其持久化投影（热度账本、复盘检查点、卡片文件）。

**通知渠道落地为工作台待复核清单；IM 后置。** 复盘与保鲜输出已经通过工具结果与定时任务输出到达模型；工作台是人的渠道。IM 推送保持为带触发条件的已记录遗留（真实运维渠道需求），记录在各包 README。

**kb-mcp 拆分为对内接线与新的对外只读 Server。** 对内中台——把外部 MCP Server 接进 dsh，或按域拆分事件/日志/告警——是复用既有 `mcp-client` 的连接器/配置工作（`examples/mcp-memory` 模式），不产出新代码。对外暴露——把引用池提供给外部 MCP 客户端——是一个最小只读 MCP Server：`@deepseek-ai/dsh-kb-mcp-server`（`packages/kb/kb-mcp-server`），stdio 传输走 `@modelcontextprotocol/sdk`（已是 mcp-client 的工作区依赖），四个只读工具（`search_cards` / `read_card` / `freshness_review` / `heat`）调用 `ctx.kb` 方法，带一个 `bin` 启动最小组合（agent / system-prompt / tools / session / kb-core / server）并连接 `StdioServerTransport`。无写工具：写侧留在 Harness 内（工具与工作台），那里 `kb/*` 事件照常入日志。Server 放在 kb 包族而非通用 `packages/mcp/` seam，因为通用 MCP-server seam 只会有一个消费者——`packages/AGENTS.md` 的"当前所有者与需求"规则——且 SDK 已提供机制。

## Alternatives considered

**在 `packages/mcp/` 建通用 MCP-server seam。** 否决：单一消费者（kb）不足以支撑新能力 seam，SDK 的 `McpServer` / `StdioServerTransport` 就是被维护的机制。出现第二个 server 消费者时再抽取 seam。

**工作台打开时跑一次记录型复盘扫描。** 否决：记录会不可见地推进检查点，把盲点队列翻页却无人蒸馏；只读检测把队列语义留给工具与调度器，它们才是仅有的记录路径。

**工作台进入 web-app bundle。** 否决：kb 是可选插件族；把 kb-core 加进每个 web session 会改变出厂产品默认（它的工具与注入）。可选 overlay 与 `examples/mcp-memory`、`examples/web-cordis` 先例一致。

**现在就做 IM 通知。** 否决：尚无运维渠道需求；工作台清单就是人的界面，延后保留文档化触发条件。

**工作台做卡片编辑操作。** 否决：为一个 UI 诉求发明新的状态变更路径与事件语义。编辑仍是模型任务，走 `kb_write`（新草稿）+ 双门禁；生命周期动作覆盖人的闭环。

## Consequences

新包：`packages/kb/kb-web`（主机 Remote 服务 + 事件追加）、`packages/kb/kb-mcp-server`（只读 MCP Server + bin）、`packages/client/ui-kb-workbench`（浏览器半）。`packages/api/remotes` 的客户端装配导入 kb-web remote contribution，浏览器才够得到该 namespace；工作台客户端插件加入 assembled-jsdom 启动清单用于浏览器快照，出厂 web-app bundle 不变。`packages/client/connection` fixture 为无 key 快照 lane 提供 `kbWorkbench/*` 端点，新增 fixture 分支由 connection 包 spec 覆盖以保持 per-file 100% 覆盖率。`docs/subsystems/kb.md`、kb-core README（"Web workbench and MCP exposure are deferred" 这条限制改为指向新包）、新包 README 与生成 catalog 一起更新。门禁新增：assembled-jsdom 浏览器快照（`apps/web/tests/kb-workbench.snapshot.ts`）、两个主机包的 Loader 组合测试、以及 MCP Server 经 SDK client 走 stdio 的真实组合测试。
