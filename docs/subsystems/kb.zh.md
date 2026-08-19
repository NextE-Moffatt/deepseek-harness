# 知识库

[English](kb.md) | 中文

个人 + 团队知识库：`ctx.kb` 持有卡片读写、晋升状态机、带扫描降级契约的 FTS5 检索、增量采集、会话启动时的知识包注入、团队 git 库（cards/ + docs/）、双门禁治理与保鲜、热度遥测投影、复盘盲点扫描与其可选调度器、方法论技能，并注册 `kb_write` / `kb_read` / `kb_search` / `kb_promote` / `kb_gate_check` / `kb_team_promote` / `kb_team_read` / `kb_review` / `kb_archive` / `kb_revive` / `kb_team_status` / `kb_team_commit` / `kb_freshness` / `kb_recap` 工具。[里程碑 1 Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-package-group-milestone-1.md) 持有包组决策，[注入 Agent Note](../../.agents/notes/implemented/feature/2026-08-18-dsh-kb-inject.md) 持有知识包决策，[里程碑 3 Agent Note](../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-3.md) 持有团队库、治理与遥测决策，[里程碑 4 Agent Note](../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-4-recap-and-skills.md) 持有复盘与技能决策；本页记录 [`packages/kb/kb-core/src/types.ts`](../../packages/kb/kb-core/src/types.ts) 的确切类型。

## Card model

卡片 = Markdown + YAML front matter，两库共用一套规范。中文 front matter 键（库 / 状态 / 适用条件 / 来源 / 责任人 / 有效期 / 标签）是定稿的用户可见格式，并逐字镜像为 TypeScript 属性名；正文的 核心结论 / 应做 / 不应做 / 反例 / 踩坑记录 节解析为其余字段。

```ts type-equiv
/**
 * A knowledge-card id, unique across one library. The design's id format is
 * `{type}-YYYYMMDD-{seq}` (for example `rule-20250818-001`); the format is
 * enforced by the card parser, not by this brand.
 */
type CardId = Branded<'CardId'>
```

```ts type-equiv
/** The four knowledge-card types of the shared card spec (§4.1). */
type CardType = 'rule' | 'case' | 'howto' | 'decision'
```

```ts type-equiv
/** Which library a card belongs to. Milestone 1 ships `personal`; `team` is the shared git repo (post-milestone-1). */
type CardLibrary = 'personal' | 'team'
```

```ts type-equiv
/**
 * Lifecycle states of the promotion pipeline. `draft` is the personal-library
 * entry state; `pending` awaits verification; `ready` is the reference pool;
 * `archived` is retired; `revived` is a restored-active state, distinct from
 * never-archived `ready` so governance can tell the two apart.
 */
type CardStatus = 'draft' | 'pending' | 'ready' | 'archived' | 'revived'
```

```ts type-equiv
/** Personal-library tiers, encoded as the card's directory: P0 Inbox, P1 project notes, P2 draft cards, P3 private experience. */
type CardTier = 'P0' | 'P1' | 'P2' | 'P3'
```

```ts type-equiv
/**
 * The three governance grades of the quality-grading mechanism (design §6):
 * `verified` is a ready/revived card inside its 有效期; `pending` is a card
 * awaiting verification; `verify` is a card that needs re-verification (a
 * ready/revived card past its 有效期, or a retired one). The grade is derived
 * from the card's status and expiry, never stored on the card.
 */
type CardGrade = 'verified' | 'pending' | 'verify'
```

晋升状态机是闭合链 `draft → pending → ready → archived → revived`，`revived → archived` 可再归档；`kb_promote` 只暴露晋升子集（目标 `pending` 与 `ready`），治理工具暴露退场/恢复边（`kb_archive`、`kb_revive`）与第二道门（`kb_review`）。卡片解析对未知键、缺失必填字段、非法日期与未知枚举值 loud fail；应做 / 不应做 节对导入卡片允许为空，而 `kb_write` 工具要求每侧至少一项。

## Team library

团队库是 `KbConfig.teamRepoPath` 指向的 git 工作树（绝对路径，或相对会话 workspace 根）：结构化卡片在 `cards/`，给人读的文档型 Wiki 在 `docs/`——docs 永不进入卡片列表、检索索引或引用池。kb 只读写工作树；提交是显式的 `kb_team_commit` 操作（草稿 → 复核 → 提交，`kb_team_status` 展示待提交 diff），`KbConfig.teamWriteApproval` 开启时写工具走审批 `ask` 门。git 并发与审批策略见[团队库 git 策略 Agent Note](../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-team-git-strategy.md)。

## Search contract

`CardIndex` 在 `kb/.kb-index.sqlite`（`indexPath` 配置）上按库根目录运行 FTS5 `unicode61`（BM25），另配普通 `cards` 表做结构化过滤（type / 状态 / tier / tags）。中日韩/假名连续段在索引与查询两侧都按字切分，子串检索无需分词词典。降级契约显式化：索引无法打开时 `search` 返回确定性扫描模式结果（`mode: 'scan'`，同一套过滤 + 说明），绝不编造答案。

## Session events

状态变更必须入日志：`kb/write` 记录工具执行的卡片写入，`kb/promote` 记录状态流转，`kb/team-join` 记录个人卡片经第一道门进入团队库，`kb/injected` 记录一次会话启动时的知识包注入，`kb/recap` 记录一次复盘扫描的检查点推进（记录的位置与列出的盲点）。全部都在底层操作成功后追加，模型可见面可从 session 日志回放；`kb/injected` 携带完整渲染后的卡片节，`kb:pack` prompt section 仅凭日志即可重建。完整载荷声明见 [persistence catalog](../persistence-catalog.md#kbpromote--log-only)。

## Knowledge packs

知识包 = 按订阅注入到 agent 会话的卡片集合。部署配置的包清单本身就是场景订阅——每个包携带选择卡片的过滤条件：

```ts type-equiv
/**
 * A knowledge pack: a subscribed card collection injected into agent sessions
 * at session start. The deployment's configured pack list IS the scenario
 * subscription — each pack carries the filters that select its cards.
 */
interface KnowledgePack {
  /** Unique pack name, shown to the model as the pack header. */
  name: string
  /** Filter: every listed tag must be present on the card. */
  tags?: readonly string[]
  /** Filter: tier allowlist (personal-library tiers). */
  tier?: readonly CardTier[]
  /** Filter: library allowlist; when absent, cards from both libraries are eligible. */
  library?: readonly CardLibrary[]
  /** Filter: status allowlist; when absent, `archived` cards are excluded by default. */
  status?: readonly CardStatus[]
  /** Maximum cards injected per session; no cap when absent. */
  limit?: number
}
```

```ts type-equiv
/** One injected card's rendered section, the replayable unit of a pack injection. */
interface PackSection {
  /** The card id, also the rendered heading. */
  name: string
  /** The rendered card content (title / 适用条件 / 核心结论 / 应做 / 不应做 / optional 反例). */
  text: string
}
```

包在 `KbConfig.packs` 下声明，加载时校验（非空唯一 name、闭合枚举 tier/library/status、正整数 limit、无未知键）。`agent/session-start` 时注入监听器同步读个人库，配置了团队库时同步读团队库；按包选择卡片（`tags` 必须全含、tier 白名单只作用于个人条目、library/status 白名单、缺省排除 `archived`、按 id 升序、按 `limit` 截断），每包追加一条携带渲染节的 `kb/injected` 事件。`kb:pack` prompt section fold 这些事件，为每个请求渲染包头与卡片块。注入按"每会话每包一次"（以日志 fold 为守卫），resume 与 fork 继承注入，回放逐字节复现该 section。无 workspace 的会话跳过注入，零命中卡片不追加，单包失败记日志并继续。

## Governance

双门禁（设计 §5.3）以状态机形态落地：`kb_gate_check` 评估第一道门（证据 → 对结构性事实的 PASS/BLOCK——个人草稿、来源链接、可执行清单、非空证据），`kb_team_promote` 在晋升点强制执行同一规则并把卡片以 `pending` 移入团队库（`kb/team-join`），`kb_review` 是第二道门——人复核把 `pending → ready` 送进引用池。质量分级按卡片派生（`gradeCard`：`verified` / `pending` / `verify`）；保鲜扫描（`kb_freshness` 工具 + `KbConfig.freshnessIntervalDays` 下的可选 `ctx.jobs` 调度器）把卡片分为已过期与即将过期，并给出基于热度的建议（复核续期 / 待复核 / 归档候选 / 复活候选）；`kb_archive` / `kb_revive` 应用状态机的退场/恢复边。保鲜默认值与审批行为都是部署配置；[里程碑 3 Agent Note](../../.agents/notes/implemented/feature/2026-08-19-dsh-kb-milestone-3.md) 持有模块决策。

## Telemetry

消费热度从 session 日志投影，绝不另起第二事件流：每条 `kb/injected` 事件按卡片 id 向 workspace 的 JSONL 热度账本（`KbConfig.heatPath`，默认 `kb/.kb-heat.jsonl`）贡献一条账目，账本聚合成按卡片的行（次数、最近会话、知识包）。投影可仅凭 session 日志重建（对任意日志跑 `projectInjectedHeat` 即可复现条目）。热度喂给保鲜建议与未来的复活/晋升信号。

## Recap

复盘闭合"用即积累"的循环：`kb_recap`（以及 `KbConfig.recapIntervalDays` 下的可选每会话 `kb-recap` 任务）扫描 workspace 的会话日志，找出未记录的盲点——消费过知识（`kb/injected` 携带卡片 id）但未产出卡片（无 `kb/write`）的会话——列出最近发生者及其有界会话摘录，并把已列出的位置记入 `KbConfig.recapPath`（默认 `kb/.kb-recap.jsonl`）的检查点。每个盲点按会话长度只浮出一次，只有当该会话日志增长后才重新进入队列；`limit` 可翻页消化队列。复盘绝不伪造卡片内容：模型读清单与摘录后通过 `kb_write` 蒸馏成 P2 草稿，之后双门禁管线原样适用。`kb/recap` 事件记录每次扫描的检查点推进，对会话日志跑 `projectRecapScans` 即可重建检查点——`HeatLedger` 模式。

## Skills

挂载了 skills 服务时，三个方法论技能注册进 skills 注册表：`kb-card-writing`（卡片模板与 §4.3 质量检查清单，结构事实从解析器常量插值生成、不可能漂移）、`kb-recap-flow`（模式 B 步骤：何时跑 `kb_recap`、如何判断盲点、经 `kb_write` 蒸馏、再走双门禁）、`kb-pack-building`（`tags` / `tier` / `library` / `status` / `limit` 过滤语义）。没有 skills 服务的上下文记一次响亮错误并跳过。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxkb--kbservice"></a>

### `ctx.kb` — `KbService`

`ctx.kb`: owns the personal library seam — card write/read, promotion, search, and incremental ingest — plus the milestone-1 tools and the knowledge-pack injection wiring (session-start trigger + `kb:pack` section).

```ts cordis-catalog
/** The absolute team repository path for one workspace root (config-relative paths resolve against the root).
 * @param root - the session workspace root.
 * @returns the absolute team repository path.
 */
teamRepoRoot(root: string): string

/**
 * Write a new personal-library draft card, generating the id when omitted.
 * @param root - the session workspace root.
 * @param input - the card to write (values validated at the tool boundary).
 * @returns the written card, tier, and absolute path.
 */
async writeCard(root: string, input: WriteCardInput): Promise<CardWriteResult>

/**
 * Read one card by id across all tiers.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @returns the card file info; throws when no tier holds the id.
 */
async readCard(root: string, id: CardId): Promise<CardFileInfo>

/**
 * Search one library: FTS5 BM25 with structured filters when the index is
 * available, otherwise a deterministic full-library scan with an explicit
 * `mode: 'scan'` note. Results are always real card files.
 * @param root - the session workspace root.
 * @param request - the retrieval request.
 * @returns the retrieval outcome with its mode.
 */
async search(root: string, request: SearchRequest): Promise<SearchOutcome>

/**
 * Apply a promotion transition: assert the state machine, rewrite the card
 * file, and return the new state. The caller (tool) appends `kb/promote`.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @param target - the requested next state (promotion subset: `pending` or `ready`).
 * @param evidence - optional objective signal.
 * @returns the card in its new state plus the transition.
 */
async promote(root: string, id: CardId, target: CardStatus, evidence?: string): Promise<PromoteResult>

/**
 * Run the incremental ingest over a source directory into the library at
 * `options.root` (see {@link importDir}).
 * @param options - import options.
 * @returns the import outcome.
 */
importDir(options: ImportOptions): Promise<IngestResult>

/**
 * The first gate's admission: promote a personal draft into the team
 * library as `pending` (库: team). The gate rule from `evaluateGate` is
 * enforced here — a BLOCK verdict throws before anything is written — so
 * the promotion point, not the advisory `kb_gate_check` tool, is the
 * enforcement. The personal file is removed after the team write succeeds.
 * @param root - the session workspace root.
 * @param id - the personal draft card id.
 * @param evidence - the objective signals (上线/交付/关闭/评审/复用).
 * @returns the card in its new library plus the team file path.
 */
async promoteToTeam(root: string, id: CardId, evidence: readonly string[]): Promise<{ card: Card; path: string }>

/**
 * Look up a card in the personal library, returning undefined when no tier
 * holds it.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @returns the card file info, or undefined.
 */
async personalCard(root: string, id: CardId): Promise<CardFileInfo | undefined>

/**
 * Look up a card in the team library, returning undefined when the library
 * does not hold it (or is not configured).
 * @param root - the session workspace root.
 * @param id - the card id.
 * @returns the team card file info, or undefined.
 */
async teamCard(root: string, id: CardId): Promise<TeamCardFileInfo | undefined>

/**
 * Read one team-library card.
 * @param root - the session workspace root.
 * @param id - the card id.
 * @returns the card file info; throws when the team library does not hold it.
 */
async teamRead(root: string, id: CardId): Promise<TeamCardFileInfo>

/**
 * The second gate (human review): an approved review transitions a team
 * `pending` card to `ready` (the reference pool); a rejected review changes
 * nothing and the card stays `pending` for more evidence. The caller (tool)
 * appends `kb/promote` on approval.
 * @param root - the session workspace root.
 * @param id - the team card id.
 * @param approved - whether the reviewer approved the card.
 * @returns the card and whether the state changed.
 */
async reviewTeam(root: string, id: CardId, approved: boolean): Promise<{ card: Card; changed: boolean }>

/**
 * Archive a team card: `ready` or `revived` → `archived` (the state machine's
 * retire edges; other states fail loud).
 * @param root - the session workspace root.
 * @param id - the team card id.
 * @returns the card in its new state, the previous state, and the file path.
 */
async archiveTeam(root: string, id: CardId): Promise<{ card: Card; from: CardStatus; path: string }>

/**
 * Revive an archived team card: `archived` → `revived`.
 * @param root - the session workspace root.
 * @param id - the team card id.
 * @returns the card in its new state, the previous state, and the file path.
 */
async reviveTeam(root: string, id: CardId): Promise<{ card: Card; from: CardStatus; path: string }>

/**
 * The team work tree's porcelain status — what a commit would carry.
 * @param root - the session workspace root.
 * @returns the non-empty porcelain lines.
 */
async teamStatus(root: string): Promise<string[]>

/**
 * Stage and commit the team work tree (the human review point: review the
 * status, then commit). Fails loud when nothing is staged or git rejects.
 * @param root - the session workspace root.
 * @param message - the commit message.
 * @returns the raw commit output.
 */
async teamCommit(root: string, message: string): Promise<string>

/**
 * The wiki documents under the team library's `docs/`, repository-relative.
 * @param root - the session workspace root.
 * @returns the sorted doc paths.
 */
async listTeamDocs(root: string): Promise<string[]>

/**
 * Read one wiki document.
 * @param root - the session workspace root.
 * @param docPath - the repository-relative doc path (`docs/...`).
 * @returns the document text.
 */
async readTeamDoc(root: string, docPath: string): Promise<string>

/**
 * The workspace's aggregated heat ledger: which cards were consumed by which
 * sessions, projected from `kb/injected` events (see {@link HeatLedger}).
 * @param root - the session workspace root.
 * @returns the per-card heat rows, card-id ascending.
 */
async heat(root: string): Promise<HeatRow[]>

/**
 * The freshness pending-review list for one workspace (see
 * {@link freshnessReview}).
 * @param root - the session workspace root.
 * @param today - the reference date `YYYY-MM-DD` (defaults to today, local).
 * @returns the review list.
 */
freshnessReview(root: string, today?: string): Promise<FreshnessReview>

/**
 * Run one recap scan for one workspace: detect the unrecorded blind spots
 * (sessions that consumed knowledge but produced no card), list up to
 * `limit`, and record the listed positions (see {@link runRecapScan}). The
 * caller (tool) appends the `kb/recap` event when positions were recorded.
 * @param root - the session workspace root.
 * @param limit - the listing cap (a positive integer).
 * @returns the scan outcome.
 */
async recap(root: string, limit: number): Promise<RecapScanResult>
```

Source: [`packages/kb/kb-core/src/index.ts:300`](../../packages/kb/kb-core/src/index.ts)
<!-- END GENERATED cordis-surface -->
