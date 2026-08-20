# Agent Note：dsh-kb 里程碑 6 —— 统一双库检索与延后的向量后端

Status: implemented

[English](2026-08-19-dsh-kb-milestone-6-unified-search.md) | 中文

## Problem

里程碑 1–5 已关闭闭环：个人库、知识包、团队治理、复盘、Web 工作台与只读 MCP 暴露。检索面仍只覆盖个人库——`kb_search` 与 MCP `search_cards` 工具自述为个人库专用，团队引用池只能经 `kb_team_read` 与知识包注入触达。设计的 kb-search 升级路径（§4.4）是里程碑 6 的职责：统一双库检索，并决定向量/RAG 后端范围与触发条件。

## Decision

**统一索引是每个工作区根一个数据库，`(library, id)` 复合主键。** `CardIndex` 在 `cards` 表与 `cards_fts` 虚拟表上增加 `library` 列；主键改为 `(library, id)`，同 id 的个人草稿与团队卡永不冲突。`sync` 接收统一 `SearchableCard` 条目——个人 `CardFileInfo` 形态加库标签；团队条目不带 tier。`KbService.search` 并列个人库与（配置了 `teamRepoPath` 时的）团队库，同步进同一索引，执行一次 BM25 查询。配置了但损坏的团队仓库与其他团队操作一样大声失败；未配置团队库则只检索个人库。退化契约精神不变、覆盖变宽：索引打不开时，扫描路径覆盖两库并带同样的显式 `mode: 'scan'` 说明。索引 schema 版本升到 2（表结构变更；不兼容库原地重置）。

**`SearchHit` 增加 `library: CardLibrary`，`tier` 变为 `CardTier | 'team'`。** 库字段区分命中所在；团队卡没有个人 tier，其命中携带哨兵 `'team'`（文档化为团队库标记，绝非 tier）。`kb_search` 工具输出 schema 的 `tier` 本就是 string，因此载荷变更是增量（`library` 成为必填命中字段）；`tier` 过滤 enum 保持 P0–P3，显式排除团队卡——无法应用于团队库的过滤不会被静默丢弃。`kb_search` 工具描述从"检索个人知识库"改为"个人 + 团队"，渲染展示库面；MCP `search_cards` 原样直通同一 `SearchOutcome` 并同步渲染。

**向量/RAG 后端延后，记录触发条件。** 真正的向量后端需要外部 embedding provider（网络/LLM 依赖，无法 keyless 测试），且设计触发线——团队卡 >500 或长文语义检索——尚不存在。自包含确定性替代（例如本地 n-gram 或 FTS5 `trigram` 索引）既不能交付语义检索，又会新增一条无消费者的检索路径。提供商槽位已经存在：`KbService.search` 背后是 `CardIndex`/`scanSearch`，退化契约是它的不变式；未来的向量 provider 是同一方法背后的 `CardIndex`-shaped 实现。触发条件与槽位记入 README，本期不再重造。

## Alternatives considered

**两个分库索引分别查询再合并。** 否决：合并需要跨库分数归一化与第二次排序，退化契约还要按库分 mode；一个复合键索引让 BM25 排序与过滤保持在单次查询内。

**给团队卡造合成 tier（例如 `T`）。** 否决：团队库没有层级（L1–L4 是未来 schema 演化），为命中形态发明一个会把 schema 承诺走私进 wire 类型。命中 tier 字段上的 `'team'` 哨兵加显式 `library` 判别符恰好陈述现状。

**现在就交付本地确定性"向量"后端。** 否决：它只是 n-gram 代理，既不能改善 CJK 子串召回（字符拆分已覆盖），也不交付语义检索，还会新增无消费者的检索路径——与里程碑 5 MCP seam 应用的"当前所有者与需求"同一测试。

## Consequences

`packages/kb/kb-core/src/search.ts` 新增统一条目类型（`SearchableCard`）、`(library, id)` 键、团队感知扫描路径与放宽的 `SearchHit`；`KB_SEARCH_SCHEMA_VERSION` 升到 2。`KbService.search` 并列并同步两库；`kb_search` 工具与 MCP `search_cards` 的渲染与 schema 更新（增量 `library` 命中字段、个人+团队描述）。知识包选择（`selectPackCards`）读 `list()` 面而非索引，注入不受影响。测试：search spec 覆盖统一同步/检索/扫描/过滤与团队标签冲突；loader-composition spec 经工具驱动真实个人 + 团队检索；per-file 覆盖率保持 100%。文档更新：`docs/subsystems/kb.md` 的检索契约段、kb-core README 的检索段，向量后端 limitation 补上触发条件。
